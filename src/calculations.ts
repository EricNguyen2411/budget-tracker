import type { Category, Transaction, RecurringTransaction } from './types'
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
  const subsTotal = subs.reduce((sum, s) => sum + s.monthlyBudget, 0)
  // Once subcategories actually have their own budgets set, the parent
  // is meant to be their sum, not a separate number on top of them —
  // but if none of them have been set yet (all still 0), falling back
  // to whatever's set directly on the parent is what makes budgeting a
  // category at the parent level actually work, rather than silently
  // discarding it just because empty subcategories happen to exist.
  return subsTotal > 0 ? subsTotal : category.monthlyBudget
}

export interface DashboardTotals {
  spent: number
  income: number
  reimbursed: number
  saved: number
  totalBudget: number
  safeToSpend: number
}

/** Prorates recurring expenses to a monthly-equivalent figure — a
 * yearly insurance premium or car registration becomes 1/12th of its
 * amount, a weekly one becomes roughly 4.33x. This is what lets an
 * annual bill be accounted for in Safe to Spend every month, not just
 * the one month it's actually due in. */
export function monthlyEquivalentRecurringExpenses(recurring: RecurringTransaction[]): number {
  return recurring
    .filter((r) => r.isActive && r.isExpense)
    .reduce((sum, r) => {
      if (r.frequency === 'monthly') return sum + r.amount
      if (r.frequency === 'yearly') return sum + r.amount / 12
      if (r.frequency === 'weekly') return sum + (r.amount * 52) / 12
      return sum
    }, 0)
}

export function computeDashboardTotals(categories: Category[], transactions: Transaction[], referenceDate: Date, recurring: RecurringTransaction[] = []): DashboardTotals {
  const topLevel = categories.filter((c) => !c.parentId)
  const thisMonth = transactions.filter((t) => isInSamePeriod(new Date(t.date), referenceDate))

  const spendingCategories = topLevel.filter((c) => !c.isSavingsCategory)
  const savingsCategories = topLevel.filter((c) => c.isSavingsCategory)

  const spent = spendingCategories.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)
  const saved = savingsCategories.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)

  const unlinkedIncome = thisMonth.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)
  const excessFromLinked = thisMonth
    .filter((t) => !t.isExpense && t.reimbursesExpenseId)
    .reduce((sum, t) => sum + excessForReimbursement(t, transactions), 0)
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

  // A savings category counts toward Safe to Spend only if it has its
  // own monthly budget explicitly set — that's the signal that it's a
  // real monthly obligation being budgeted for (a sinking fund for an
  // annual bill like insurance or car registration, where skipping a
  // contribution means not having the money when it's actually due),
  // not a discretionary "extra" goal (an iPhone, a holiday) sitting on
  // top of the regular budget that shouldn't eat into it.
  // Confirmed against the original app's real behavior: every dollar
  // that goes toward savings reduces Safe to Spend, not just amounts
  // with a monthly budget explicitly set on the category — money set
  // aside isn't available to spend on anything else, budgeted or not.
  const totalBudget = topLevel.reduce((sum, c) => sum + effectiveBudget(c, categories), 0)
  const totalNetBudgetedSpent = topLevel.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)
  // Prorated recurring bills (yearly ones especially) reserve their
  // monthly-equivalent share year-round, not just in the month they're
  // actually due — otherwise an annual premium looks "free" for 11
  // months and then blows the budget the one month it lands.
  const monthlyRecurringReserve = monthlyEquivalentRecurringExpenses(recurring)
  const safeToSpend = totalBudget - totalNetBudgetedSpent - monthlyRecurringReserve

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
      .reduce((sum, t) => sum + excessForReimbursement(t, transactions), 0)
    const income = unlinkedIncome + excessFromLinked

    result.push({ periodStart: period.start, amount: income - spent })
  }
  return result
}

/**
 * Extracts YYYY-MM-DD in LOCAL time, for use with <input type="date">.
 * toISOString().slice(0,10) — used in a few places before this existed —
 * looks equivalent but isn't: it converts to UTC first, so for any
 * transaction whose stored time-of-day is late enough that the local
 * calendar date has already rolled over (anything from early-to-mid
 * afternoon UTC onward, for Australia), it silently returns the WRONG
 * day — one day behind what every other part of the app shows, since
 * everywhere else correctly uses local time via toLocaleDateString /
 * toDateString.
 */
export function localDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface MerchantTotal {
  note: string
  amount: number
}

export function topMerchantsThisMonth(transactions: Transaction[], categories: Category[], referenceDate: Date = new Date(), limit = 5): MerchantTotal[] {
  const thisMonth = transactions.filter((t) => {
    if (!t.isExpense || !t.note.trim() || !isInSamePeriod(new Date(t.date), referenceDate)) return false
    const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
    return !cat?.isSavingsCategory
  })
  const map = new Map<string, number>()
  for (const t of thisMonth) {
    const key = t.note.trim()
    map.set(key, (map.get(key) ?? 0) + netAmount(t, transactions))
  }
  return Array.from(map.entries())
    .map(([note, amount]) => ({ note, amount }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
}

export function repaysNote(transaction: Transaction, all: Transaction[]): string | null {
  if (transaction.isExpense || !transaction.reimbursesExpenseId) return null
  const expense = all.find((e) => e.id === transaction.reimbursesExpenseId)
  if (!expense) return null
  return `repays ${expense.note || 'transaction'}`
}

/** How much of THIS SPECIFIC reimbursement transaction is excess beyond
 * what the expense actually cost — allocated in order (earliest
 * reimbursement first), so with several people chipping in, only the
 * actual overflow counts as excess, not an even split. Returns 0 if this
 * transaction isn't an excess-producing reimbursement at all. */
export function excessForReimbursement(transaction: Transaction, all: Transaction[]): number {
  if (transaction.isExpense || !transaction.reimbursesExpenseId) return 0
  const expense = all.find((e) => e.id === transaction.reimbursesExpenseId)
  if (!expense) return 0

  const reimbursements = reimbursementsFor(expense, all).sort((a, b) => a.date.localeCompare(b.date))
  let remaining = expense.amount
  for (const r of reimbursements) {
    const applied = Math.min(r.amount, Math.max(0, remaining))
    const excess = r.amount - applied
    remaining -= applied
    if (r.id === transaction.id) return excess
  }
  return 0
}

export function excessIncomeNote(transaction: Transaction, all: Transaction[]): string | null {
  const excess = excessForReimbursement(transaction, all)
  return excess > 0 ? `${formatCurrency(excess)} extra, counted as income` : null
}

export function reimbursementNote(transaction: Transaction, all: Transaction[]): string | null {
  if (!transaction.isExpense) return null
  const reimbursed = totalReimbursed(transaction, all)
  if (reimbursed <= 0) return null
  return `${formatCurrency(transaction.amount)} − ${formatCurrency(reimbursed)} reimbursed`
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
