import type { Category, Transaction } from './types'
import { isInSamePeriod, daysRemainingInPeriod, periodOffsetBy } from './budgetPeriod'

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
}

/** Reimbursements linked to a given expense. */
export function reimbursementsFor(expense: Transaction, all: Transaction[]): Transaction[] {
  return all.filter((t) => t.reimbursesExpenseId === expense.id)
}

export function totalReimbursed(expense: Transaction, all: Transaction[]): number {
  return reimbursementsFor(expense, all).reduce((sum, t) => sum + t.amount, 0)
}

/** What an expense actually cost after linked reimbursements — floored at 0. */
export function netAmount(transaction: Transaction, all: Transaction[]): number {
  if (!transaction.isExpense) return transaction.amount
  const reimbursed = totalReimbursed(transaction, all)
  if (reimbursed === 0) return transaction.amount
  return Math.max(transaction.amount - reimbursed, 0)
}

/**
 * If reimbursements linked to an expense add up to MORE than it cost, the
 * excess is real income, not a reimbursement — allocated in order
 * (earliest first) so with several people chipping in, only the actual
 * overflow counts as excess, not an even split across everyone.
 */
export function totalExcessReimbursement(expense: Transaction, all: Transaction[]): number {
  if (!expense.isExpense) return 0
  const reimbursements = reimbursementsFor(expense, all).sort((a, b) => a.date.localeCompare(b.date))
  let remaining = expense.amount
  let excess = 0
  for (const r of reimbursements) {
    const applied = Math.min(r.amount, Math.max(0, remaining))
    excess += r.amount - applied
    remaining -= applied
  }
  return excess
}

export function categoryAndDescendantIds(category: Category, allCategories: Category[]): Set<string> {
  const ids = new Set([category.id])
  for (const c of allCategories) {
    if (c.parentId === category.id) ids.add(c.id)
  }
  return ids
}

/** Net spend for a category (+ subcategories) within the given month. */
export function netSpentForCategory(category: Category, allCategories: Category[], allTransactions: Transaction[], referenceDate: Date): number {
  const ids = categoryAndDescendantIds(category, allCategories)
  const relevant = allTransactions.filter((t) => t.categoryId && ids.has(t.categoryId) && isInSamePeriod(new Date(t.date), referenceDate))

  const expenses = relevant.filter((t) => t.isExpense).reduce((sum, t) => sum + netAmount(t, allTransactions), 0)
  const excess = relevant.filter((t) => t.isExpense).reduce((sum, t) => sum + totalExcessReimbursement(t, allTransactions), 0)
  const unlinkedIncome = relevant.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)

  return expenses - excess - unlinkedIncome
}

export function effectiveBudget(category: Category, allCategories: Category[]): number {
  const subs = allCategories.filter((c) => c.parentId === category.id)
  if (subs.length === 0) return category.monthlyBudget
  return subs.reduce((sum, s) => sum + s.monthlyBudget, 0)
}

export interface DashboardTotals {
  spent: number
  income: number
  reimbursed: number
  saved: number
  totalBudget: number
  safeToSpend: number
}

export function computeDashboardTotals(categories: Category[], transactions: Transaction[], referenceDate: Date): DashboardTotals {
  const topLevel = categories.filter((c) => !c.parentId)
  const thisMonth = transactions.filter((t) => isInSamePeriod(new Date(t.date), referenceDate))

  const spendingCategories = topLevel.filter((c) => !c.isSavingsCategory)
  const savingsCategories = topLevel.filter((c) => c.isSavingsCategory)

  const spent = spendingCategories.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)
  const saved = savingsCategories.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)

  const unlinkedIncome = thisMonth.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)
  const excessFromLinked = thisMonth
    .filter((t) => !t.isExpense && t.reimbursesExpenseId)
    .reduce((sum, t) => sum + totalExcessReimbursement(transactions.find((e) => e.id === t.reimbursesExpenseId)!, transactions), 0)
  const income = unlinkedIncome + excessFromLinked

  const reimbursed = thisMonth
    .filter((t) => !t.isExpense && t.reimbursesExpenseId)
    .reduce((sum, t) => {
      const expense = transactions.find((e) => e.id === t.reimbursesExpenseId)
      if (!expense) return sum
      const reimbursements = reimbursementsFor(expense, transactions).sort((a, b) => a.date.localeCompare(b.date))
      let remaining = expense.amount
      for (const r of reimbursements) {
        const applied = Math.min(r.amount, Math.max(0, remaining))
        if (r.id === t.id) return sum + applied
        remaining -= applied
      }
      return sum
    }, 0)

  const totalBudget = topLevel.reduce((sum, c) => sum + effectiveBudget(c, categories), 0)
  const totalNetBudgetedSpent = topLevel.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)
  const safeToSpend = totalBudget - totalNetBudgetedSpent

  return { spent, income, reimbursed, saved, totalBudget, safeToSpend }
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(amount)
}

export function daysRemainingInMonth(referenceDate: Date): number {
  return daysRemainingInPeriod(referenceDate)
}

export interface CategorySlice {
  categoryId: string
  name: string
  color: string
  amount: number
}

export function categoryBreakdown(categories: Category[], transactions: Transaction[], referenceDate: Date = new Date()): CategorySlice[] {
  const topLevel = categories.filter((c) => !c.parentId && !c.isSavingsCategory)

  return topLevel
    .map((c) => ({ categoryId: c.id, name: c.name, color: c.color, amount: Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)) }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount)
}

export interface DayPoint {
  date: Date
  amount: number
}

export function last14DaysSpend(transactions: Transaction[], categories: Category[], referenceDate: Date = new Date()): DayPoint[] {
  const result: DayPoint[] = []
  for (let offset = 13; offset >= 0; offset--) {
    const day = new Date(referenceDate)
    day.setDate(day.getDate() - offset)
    const dayStr = day.toDateString()
    const total = transactions
      .filter((t) => {
        const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
        return t.isExpense && !cat?.isSavingsCategory && new Date(t.date).toDateString() === dayStr
      })
      .reduce((sum, t) => sum + netAmount(t, transactions), 0)
    result.push({ date: day, amount: total })
  }
  return result
}

export interface PeriodPoint {
  periodStart: Date
  amount: number
}

export function last6PeriodsSpend(categories: Category[], transactions: Transaction[], referenceDate: Date = new Date()): PeriodPoint[] {
  const result: PeriodPoint[] = []
  for (let offset = 5; offset >= 0; offset--) {
    const period = periodOffsetBy(-offset, referenceDate)
    const total = transactions
      .filter((t) => {
        const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
        return t.isExpense && !cat?.isSavingsCategory && new Date(t.date) >= period.start && new Date(t.date) < period.end
      })
      .reduce((sum, t) => sum + netAmount(t, transactions), 0)
    result.push({ periodStart: period.start, amount: total })
  }
  return result
}

export function last6PeriodsNetSavings(categories: Category[], transactions: Transaction[], referenceDate: Date = new Date()): PeriodPoint[] {
  const result: PeriodPoint[] = []
  for (let offset = 5; offset >= 0; offset--) {
    const period = periodOffsetBy(-offset, referenceDate)
    const periodTx = transactions.filter((t) => new Date(t.date) >= period.start && new Date(t.date) < period.end)

    const spent = periodTx
      .filter((t) => {
        const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
        return t.isExpense && !cat?.isSavingsCategory
      })
      .reduce((sum, t) => sum + netAmount(t, transactions), 0)

    const unlinkedIncome = periodTx.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)
    const excessFromLinked = periodTx
      .filter((t) => !t.isExpense && t.reimbursesExpenseId)
      .reduce((sum, t) => {
        const expense = transactions.find((e) => e.id === t.reimbursesExpenseId)
        return expense ? sum + totalExcessReimbursement(expense, transactions) : sum
      }, 0)
    const income = unlinkedIncome + excessFromLinked

    result.push({ periodStart: period.start, amount: income - spent })
  }
  return result
}

export function isGoal(category: Category): boolean {
  return category.isSavingsCategory && category.goalTargetAmount > 0
}

/** Cumulative progress toward a goal since goalStartDate (or all-time). */
export function goalProgress(category: Category, transactions: Transaction[]): number {
  const own = transactions.filter((t) => t.categoryId === category.id)
  const relevant = category.goalStartDate
    ? own.filter((t) => new Date(t.date) >= new Date(category.goalStartDate!))
    : own
  const contributions = relevant.filter((t) => t.isExpense).reduce((sum, t) => sum + netAmount(t, transactions), 0)
  const withdrawals = relevant.filter((t) => !t.isExpense).reduce((sum, t) => sum + t.amount, 0)
  return Math.max(0, contributions - withdrawals)
}

export function goalProgressFraction(category: Category, transactions: Transaction[]): number {
  if (category.goalTargetAmount <= 0) return 0
  return Math.min(1, goalProgress(category, transactions) / category.goalTargetAmount)
}

/** Projected completion date based on average monthly pace since the goal started. */
export function projectedGoalCompletionDate(category: Category, transactions: Transaction[], referenceDate: Date = new Date()): Date | null {
  if (category.goalTargetAmount <= 0) return null
  const own = transactions.filter((t) => t.categoryId === category.id)
  const earliestTx = own.reduce<Date | null>((earliest, t) => {
    const d = new Date(t.date)
    return !earliest || d < earliest ? d : earliest
  }, null)
  const start = category.goalStartDate ? new Date(category.goalStartDate) : (earliestTx ?? referenceDate)
  const monthsElapsed = Math.max(1 / 30, (referenceDate.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44))
  const saved = goalProgress(category, transactions)
  if (saved <= 0 || monthsElapsed < 1) return null

  const monthlyPace = saved / monthsElapsed
  if (monthlyPace <= 0) return null
  const remaining = Math.max(0, category.goalTargetAmount - saved)
  if (remaining <= 0) return referenceDate

  const monthsRemaining = remaining / monthlyPace
  return new Date(referenceDate.getTime() + monthsRemaining * 30.44 * 24 * 60 * 60 * 1000)
}
