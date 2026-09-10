import type { Category, Transaction, RecurringTransaction, Account } from './types'
import { isInSamePeriod, daysRemainingInPeriod, periodOffsetBy } from './budgetPeriod'
import { normalizeMerchantKey } from './merchantRules'
import { normalizeTag } from './tags'

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
  // A transfer's own "reimbursement" (its linked income landing in
  // another of the person's own tracked accounts) is deliberately NOT
  // netted out here — confirmed via a real screenshot this was showing
  // a transfer's outbound side as "-$0.00" on the transaction list,
  // which reads as if the expense cost nothing. It didn't cost nothing;
  // the money genuinely moved, just to somewhere this person still owns
  // and tracks. Netting to zero only makes sense for a genuine
  // reimbursement or a Fund From Savings draw-down, where the whole
  // point IS that it didn't cost anything extra. Safe to exclude here
  // specifically: a transfer always has categoryId null, so this
  // change can't affect any category's spend or Safe to Spend either
  // way — it only fixes what the transaction's own row displays.
  const reimbursed = reimbursementsFor(transaction, all)
    .filter((t) => !isAccountTransferLink(t, transaction))
    .reduce((sum, t) => sum + t.amount, 0)
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
/** How many of a recurring item's own bills already show up as real
 * transactions this period — matched by merchant name (the same
 * normalization used for merchant learning elsewhere), not category,
 * since a category can hold several unrelated transactions and matching
 * on category alone could let some other purchase silently "cover" a
 * subscription it has nothing to do with. */
export function paidOccurrencesThisPeriod(item: RecurringTransaction, transactions: Transaction[], referenceDate: Date): number {
  const itemKey = normalizeMerchantKey(item.note)
  if (!itemKey) return 0
  return transactions.filter((t) =>
    t.isExpense === item.isExpense &&
    isInSamePeriod(new Date(t.date), referenceDate) &&
    normalizeMerchantKey(t.note) === itemKey
  ).length
}

/** The other direction of the same match — given one real transaction,
 * which active recurring item (if any) does it correspond to. Used to
 * show a plain confirmation on the transaction itself that this exact
 * charge is the one keeping its recurring item's reserve from double
 * counting, rather than leaving that connection invisible and only
 * checkable by reading the Safe to Spend math. */
export function matchingRecurringItem(transaction: Transaction, recurring: RecurringTransaction[]): RecurringTransaction | null {
  if (!transaction.note.trim()) return null
  const txKey = normalizeMerchantKey(transaction.note)
  if (!txKey) return null
  return recurring.find((r) =>
    r.isActive &&
    r.isExpense === transaction.isExpense &&
    normalizeMerchantKey(r.note) === txKey
  ) ?? null
}

/** The monthly reserve set aside for recurring bills. Confirmed via
 * direct testing that this was double-counting every MONTHLY recurring
 * item once its real charge had also been recorded as an actual
 * transaction: the reserve summed every active item's monthly-equivalent
 * amount completely unconditionally, with no way to know a matching real
 * transaction already existed for the period — so a $16 Spotify charge
 * reduced Safe to Spend by $32, not $16, the moment it was logged
 * (whether entered by hand or auto-generated by processDueRecurring,
 * which creates the real transaction automatically when a recurring
 * item comes due). Fixed for monthly items directly (recurs once a
 * period at full amount, so one match fully covers it) and weekly items
 * proportionally (several occurrences are expected per period, so only
 * as many as have actually landed get subtracted out — one paid week of
 * four shouldn't zero out reserving for the other three). Yearly items
 * keep prorating unconditionally by design — a small monthly slice
 * reserved year-round for a once-a-year bill, not tied to whether this
 * exact month is the one it's due (see the in-app "How Safe to Spend
 * Works" explanation). */
export function monthlyEquivalentRecurringExpenses(recurring: RecurringTransaction[], transactions: Transaction[] = [], referenceDate: Date = new Date()): number {
  return recurring
    .filter((r) => r.isActive && r.isExpense)
    .reduce((sum, r) => {
      if (r.frequency === 'monthly') {
        const paid = paidOccurrencesThisPeriod(r, transactions, referenceDate)
        return paid > 0 ? sum : sum + r.amount
      }
      if (r.frequency === 'yearly') return sum + r.amount / 12
      if (r.frequency === 'weekly') {
        const fullReserve = (r.amount * 52) / 12
        const paid = paidOccurrencesThisPeriod(r, transactions, referenceDate)
        const alreadyCovered = Math.min(fullReserve, paid * r.amount)
        return sum + Math.max(0, fullReserve - alreadyCovered)
      }
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
  const monthlyRecurringReserve = monthlyEquivalentRecurringExpenses(recurring, transactions, referenceDate)
  const safeToSpend = totalBudget - totalNetBudgetedSpent - monthlyRecurringReserve

  return { spent, income, reimbursed, saved, totalBudget, safeToSpend }
}

/** How much of this period's spending was covered by drawing down a
 * savings category, specifically — a sub-breakdown of what's already
 * folded into Net Spend So Far, not a separate deduction on top of it
 * (that would double count it). Exists purely for transparency: without
 * this, "why is my net spend lower than what I actually paid for
 * things" has no visible answer on the Safe to Spend breakdown, even
 * though the app is already doing the right thing underneath. */
export function fundedFromSavingsThisPeriod(categories: Category[], transactions: Transaction[], referenceDate: Date): number {
  const thisMonth = transactions.filter((t) => isInSamePeriod(new Date(t.date), referenceDate))
  return thisMonth
    .filter((t) => !t.isExpense && t.reimbursesExpenseId)
    .filter((t) => {
      const ownCategory = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
      return ownCategory?.isSavingsCategory ?? false
    })
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
  const thisMonth = transactions
    .filter((t) => {
      if (!t.isExpense || !t.note.trim() || !isInSamePeriod(new Date(t.date), referenceDate)) return false
      const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
      return !cat?.isSavingsCategory
    })
    .sort((a, b) => b.date.localeCompare(a.date)) // most recent first, so each group's representative label below is its latest note, not an arbitrary one

  // Grouped by the same first-word "brand" heuristic merchant learning
  // already uses (see merchantRules.ts) — confirmed a real gap without
  // it: "WOOLWORTHS FAIRFIELD" and "WOOLWORTHS BURWOOD" have different
  // suburb text, so grouping by the full normalized note (or the raw
  // note, as before) shows them as two separate, smaller entries
  // instead of one "Woolworths" total. Beem is excluded from this
  // grouping specifically — its notes are the actual payment
  // description ("food", "rent split"), not a merchant name, so
  // collapsing every Beem-labeled transaction under one meaningless
  // "Beem" bucket would be actively worse than keeping them separate.
  const map = new Map<string, { amount: number; note: string }>()
  let beemCounter = 0
  for (const t of thisMonth) {
    const normalized = normalizeMerchantKey(t.note)
    const brandKey = normalized.split(' ')[0] || normalized || t.note.trim().toLowerCase()
    const key = /beem/i.test(brandKey) ? `beem-${beemCounter++}` : brandKey
    const existing = map.get(key)
    if (existing) {
      existing.amount += netAmount(t, transactions)
    } else {
      map.set(key, { amount: netAmount(t, transactions), note: t.note.trim() })
    }
  }
  return Array.from(map.values())
    // A transaction fully covered by a reimbursement or Fund From
    // Savings link nets to $0 — genuinely correct for what it cost, but
    // meaningless as a "top merchant" entry, and confirmed via testing
    // that it can otherwise occupy a ranked slot showing "$0.00" for no
    // useful reason.
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
}

export interface TagTotal {
  tag: string
  amount: number
  count: number
}

/** Mirrors topMerchantsThisMonth exactly, grouped by tag instead of
 * merchant — tags have their own detail screen (date range, category
 * breakdown, full transaction list) but had zero presence on the
 * dashboard itself, so a trip or event you're actively tracking (the
 * whole reason tags exist) was invisible unless you specifically went
 * looking for it under More → Tags. */
export function topTagsThisMonth(transactions: Transaction[], categories: Category[], referenceDate: Date = new Date(), limit = 5): TagTotal[] {
  const thisMonth = transactions.filter((t) => {
    if (!t.isExpense || t.tags.length === 0 || !isInSamePeriod(new Date(t.date), referenceDate)) return false
    const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
    return !cat?.isSavingsCategory
  })

  const map = new Map<string, { amount: number; count: number }>()
  for (const t of thisMonth) {
    const amount = netAmount(t, transactions)
    if (amount <= 0) continue
    for (const rawTag of t.tags) {
      const tag = normalizeTag(rawTag)
      if (!tag) continue
      const existing = map.get(tag) ?? { amount: 0, count: 0 }
      existing.amount += amount
      existing.count += 1
      map.set(tag, existing)
    }
  }
  return Array.from(map.entries())
    .map(([tag, v]) => ({ tag, amount: v.amount, count: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit)
}

export interface OutstandingReimbursement {
  transaction: Transaction
  owed: number
}

/** Expenses that are only PARTIALLY covered so far — fully reimbursed
 * ones aren't included (nothing left to chase), and this is
 * deliberately all-time rather than period-scoped: a friend owing you
 * money from three weeks ago doesn't stop being owed just because the
 * budget period rolled over, and the whole point is not forgetting
 * about it. */
export function outstandingReimbursements(transactions: Transaction[]): OutstandingReimbursement[] {
  return transactions
    .filter((t) => t.isExpense)
    .map((t) => ({ transaction: t, owed: t.amount - totalReimbursed(t, transactions) }))
    .filter((r) => r.owed > 0.01 && totalReimbursed(r.transaction, transactions) > 0)
    .sort((a, b) => b.owed - a.owed)
}

/** A transfer between two of the person's own tracked accounts uses the
 * exact same linking mechanism as a reimbursement (an income
 * transaction pointing at the expense it offsets) — deliberately, so it
 * inherits the same safe-deletion handling and the same automatic
 * exclusion from the Income stat, without a new field or new
 * calculation path to keep in sync. Identified here by both sides
 * having a DIFFERENT account set — the one signal a genuine friend
 * reimbursement essentially never has, since the normal "Reimburses"
 * picker doesn't prompt for an account on either side. */
export function isAccountTransferLink(reimbursingTx: Transaction, expenseTx: Transaction): boolean {
  return !!reimbursingTx.accountId && !!expenseTx.accountId && reimbursingTx.accountId !== expenseTx.accountId
}

/** Given either half of a transfer, finds the other half — used to edit
 * or delete a transfer as one thing instead of two separately-editable
 * transactions that could drift out of sync (a corrected amount on one
 * side without the matching correction on the other would leave the
 * two account balances reflecting different transfer amounts, silently
 * wrong on whichever side didn't get updated). Returns null for an
 * ordinary transaction, or for a genuine reimbursement/Fund From
 * Savings link — only an actual account-to-account transfer pairs up
 * here. */
export function findTransferPair(transaction: Transaction, all: Transaction[]): Transaction | null {
  if (transaction.isExpense) {
    const income = all.find((t) => t.reimbursesExpenseId === transaction.id && isAccountTransferLink(t, transaction))
    return income ?? null
  }
  if (!transaction.reimbursesExpenseId) return null
  const expense = all.find((t) => t.id === transaction.reimbursesExpenseId)
  if (!expense || !isAccountTransferLink(transaction, expense)) return null
  return expense
}

/** Given a Fund From Savings withdrawal (an income transaction that
 * covers part or all of a real expense), finds the expense it funds —
 * used to show a compact, focused view instead of the full transaction
 * editor when someone taps this specific record. Unlike a transfer, the
 * expense side here still has real, independent meaning (a category, a
 * date, tags, whether it matches a recurring bill) that needs full
 * editing of its own — only this thin link record benefits from a
 * simpler view, so this deliberately doesn't merge the two the way
 * findTransferPair does. Returns null for an ordinary transaction, a
 * genuine friend reimbursement, or a transfer. */
export function findFundedExpense(transaction: Transaction, all: Transaction[], categories: Category[]): Transaction | null {
  if (transaction.isExpense || !transaction.reimbursesExpenseId) return null
  const expense = all.find((t) => t.id === transaction.reimbursesExpenseId)
  if (!expense) return null
  if (isAccountTransferLink(transaction, expense)) return null
  const ownCategory = transaction.categoryId ? categories.find((c) => c.id === transaction.categoryId) : null
  if (!ownCategory?.isSavingsCategory) return null
  return expense
}

export function repaysNote(transaction: Transaction, all: Transaction[], categories: Category[] = [], accounts: Account[] = []): string | null {
  if (transaction.isExpense || !transaction.reimbursesExpenseId) return null
  const expense = all.find((e) => e.id === transaction.reimbursesExpenseId)
  if (!expense) return null
  // Distinguishes "I funded this from my own savings" from "someone
  // else paid me back" — same underlying mechanism (an income
  // transaction linked to the expense it covers), but conceptually
  // different, and worth being explicit about rather than describing
  // both the same way just because they share one field.
  const ownCategory = transaction.categoryId ? categories.find((c) => c.id === transaction.categoryId) : null
  if (ownCategory?.isSavingsCategory) return `funded from ${ownCategory.name}`
  if (isAccountTransferLink(transaction, expense)) {
    const fromAccount = accounts.find((a) => a.id === expense.accountId)
    return `transferred from ${fromAccount?.name ?? 'another account'}`
  }
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

export function reimbursementNote(transaction: Transaction, all: Transaction[], categories: Category[] = []): string | null {
  if (!transaction.isExpense) return null
  const reimbursed = totalReimbursed(transaction, all)
  if (reimbursed <= 0) return null
  // Same distinction as repaysNote, from the expense's side this time —
  // if every linked transaction covering this expense was funded from a
  // savings category (not necessarily the same one, though that's the
  // common case), say so plainly rather than the generic "reimbursed"
  // wording, which reads as if a friend paid it back. A genuinely mixed
  // source (part savings, part an actual friend) falls back to the
  // neutral wording rather than guessing which framing fits better.
  const linkedTransactions = all.filter((t) => t.reimbursesExpenseId === transaction.id)
  const allFromSavings = linkedTransactions.length > 0 && linkedTransactions.every((t) => {
    const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
    return cat?.isSavingsCategory ?? false
  })
  const allTransfers = linkedTransactions.length > 0 && linkedTransactions.every((t) => isAccountTransferLink(t, transaction))
  const verb = allFromSavings ? 'funded from savings' : allTransfers ? 'transferred out' : 'reimbursed'
  return `${formatCurrency(transaction.amount)} − ${formatCurrency(reimbursed)} ${verb}`
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

/** An account's balance is raw cash flow through it, deliberately NOT
 * netted against reimbursements the way category spending is. A $100
 * dinner paid from this account and a $60 refund into it later are both
 * real movements of money through the account — netting them the way
 * netSpentForCategory does for "what did this actually cost me" would
 * be wrong here, since the account's balance needs to reflect what
 * literally happened to the money, not the net cost after being paid
 * back.
 *
 * Credit cards are inverted on purpose: a real credit card's "balance"
 * means what you OWE, so an expense on it (borrowing) increases that
 * number and a payment/refund (income) decreases it — the opposite
 * sign convention from every other account type, where an expense
 * reduces what you have and income adds to it. */
export function accountBalance(account: Account, transactions: Transaction[]): number {
  // Both sides normalized to local midnight before comparing — confirmed
  // via a real screenshot this matters: a freshly created account's
  // openingDate captures the exact moment it was created (including
  // time of day), while a transaction dated "today" is normalized to
  // midnight. Without this, the single most common first action —
  // creating an account and immediately logging today's spending —
  // silently excluded that transaction from the balance, since
  // midnight-today falls before later-today when the account was made.
  const openingMidnight = new Date(account.openingDate)
  openingMidnight.setHours(0, 0, 0, 0)
  const relevant = transactions.filter((t) => {
    if (t.accountId !== account.id) return false
    const txMidnight = new Date(t.date)
    txMidnight.setHours(0, 0, 0, 0)
    return txMidnight >= openingMidnight
  })
  const netFlow = relevant.reduce((sum, t) => sum + (t.isExpense ? -t.amount : t.amount), 0)
  const signedFlow = account.type === 'credit_card' ? -netFlow : netFlow
  return account.openingBalance + signedFlow
}

/** The account's balance as it stood at the end of a specific day —
 * used for interest calculation, which needs the actual daily closing
 * balance for every day in a period, not just the current balance.
 * Deliberately a separate function from accountBalance rather than
 * generalizing accountBalance to take an optional cutoff: accountBalance
 * is used everywhere else in the app and is already well-tested with no
 * upper date bound (it includes a future-dated transaction the moment
 * it's entered, which is arguably correct for "what does this account
 * currently show"); changing its semantics to cap at "today" to reuse
 * it here would be a behavior change to something that already works,
 * for the benefit of a feature that doesn't need that function touched
 * at all. Same underlying logic, applied with an inclusive upper bound
 * instead of none. */
export function accountBalanceAsOf(account: Account, transactions: Transaction[], asOfDate: Date): number {
  const openingMidnight = new Date(account.openingDate)
  openingMidnight.setHours(0, 0, 0, 0)
  const cutoffEndOfDay = new Date(asOfDate)
  cutoffEndOfDay.setHours(23, 59, 59, 999)
  const relevant = transactions.filter((t) => {
    if (t.accountId !== account.id) return false
    const txMidnight = new Date(t.date)
    txMidnight.setHours(0, 0, 0, 0)
    return txMidnight >= openingMidnight && txMidnight <= cutoffEndOfDay
  })
  const netFlow = relevant.reduce((sum, t) => sum + (t.isExpense ? -t.amount : t.amount), 0)
  const signedFlow = account.type === 'credit_card' ? -netFlow : netFlow
  return account.openingBalance + signedFlow
}

/** Interest earned over a period, calculated the way real savings
 * accounts actually do it: a daily rate (annual rate ÷ 365) applied to
 * the account's actual closing balance on EACH day in the period, then
 * summed — not a flat rate applied to the opening or average balance,
 * which would misstate it for any account whose balance changed
 * partway through the period (a deposit or withdrawal mid-month is
 * exactly the normal case, not an edge case, for a real savings
 * account). Confirmed the user's own understanding matches this: "the
 * interest is calculated daily."
 *
 * Rounds only the final total, not each day's contribution — real
 * banks accrue fractional cents internally through the month and only
 * round at the point of crediting it, and rounding every day first
 * would introduce a small but real cumulative error against that.
 * periodEnd is capped at "yesterday" if it would otherwise land in the
 * future — interest can't have accrued for days that haven't happened
 * yet, even if the person is calculating mid-month. */
export function calculateInterestEarned(account: Account, transactions: Transaction[], periodStart: Date, periodEnd: Date): number {
  const rate = account.interestRate
  if (!rate) return 0
  const dailyRate = rate / 100 / 365
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const cappedEnd = periodEnd > yesterday ? yesterday : periodEnd

  let total = 0
  const cursor = new Date(periodStart)
  cursor.setHours(0, 0, 0, 0)
  const end = new Date(cappedEnd)
  end.setHours(0, 0, 0, 0)
  while (cursor <= end) {
    const dayBalance = accountBalanceAsOf(account, transactions, cursor)
    // Interest accrues on a positive balance; a credit card's "balance"
    // here represents debt owed, not savings, so it never earns
    // interest through this calculation regardless of a rate being set.
    if (dayBalance > 0 && account.type !== 'credit_card') {
      total += dayBalance * dailyRate
    }
    cursor.setDate(cursor.getDate() + 1)
  }
  return Math.round(total * 100) / 100
}

/** The single adjustment transaction needed to make accountBalance
 * match a real-world figure the person just read off their bank app —
 * the "reconcile" half of the hybrid approach: automatic day to day,
 * with an easy correction whenever it drifts (a bank fee, interest, a
 * transaction that never made it into the app).
 *
 * Returns the actual expense/income split to create, not just a raw
 * signed number — a credit card's inverted sign convention means "the
 * real balance came in higher than calculated" is an EXPENSE for a
 * credit card (more debt than expected, e.g. an unrecorded fee) but
 * INCOME for every other account type (more money than expected, e.g.
 * interest). Deriving that here once, rather than leaving the caller to
 * re-apply the same inversion rule accountBalance already encodes, is
 * exactly the kind of logic that's already drifted apart into silently
 * wrong duplicates elsewhere in this codebase when left to more than
 * one place. Null return means already matches, nothing to create. */
export function accountReconciliationDelta(account: Account, transactions: Transaction[], realBalance: number): { amount: number; isExpense: boolean } | null {
  const calculated = accountBalance(account, transactions)
  const delta = realBalance - calculated
  if (Math.abs(delta) < 0.005) return null
  const higherThanExpected = delta > 0
  const isExpense = account.type === 'credit_card' ? higherThanExpected : !higherThanExpected
  return { amount: Math.abs(delta), isExpense }
}

