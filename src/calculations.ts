import type { Category, Transaction, RecurringTransaction, Account } from './types'
import { isInSamePeriod, periodContaining, daysRemainingInPeriod, periodOffsetBy } from './budgetPeriod'
import { normalizeMerchantKey } from './merchantRules'
import { normalizeTag } from './tags'

/** True if an income transaction is genuinely unlinked — not tied to
 * covering any specific expense, whether via the simple single-link
 * field (reimbursesExpenseId) or the multi-expense allocations array
 * (multiAllocations), and not an account balance reconciliation
 * either. A transaction using multiAllocations has reimbursesExpenseId
 * set to null by design, and a balance adjustment has neither field
 * set at all, so checking only reimbursesExpenseId was confirmed to
 * let both slip through as if they were ordinary, unlinked income —
 * real money already accounted for elsewhere, or not real new money at
 * all, getting double-counted as fresh income on top of it. Every
 * place in this file and the rest of the app that identifies "unlinked
 * income" reads through this one function so that distinction can't
 * drift out of sync between them again. */
export function isUnlinkedIncome(t: Transaction): boolean {
  return !t.isExpense && !t.reimbursesExpenseId && !(t.multiAllocations && t.multiAllocations.length > 0) && !t.isBalanceAdjustment
}

/** The inverse of isUnlinkedIncome — true if an income transaction IS
 * linked to covering one or more expenses, however it's linked. */
export function isLinkedReimbursement(t: Transaction): boolean {
  // A balance adjustment is neither: it's not "unlinked income" (salary,
  // a refund, cashback) since isUnlinkedIncome already excludes it
  // deliberately, but that same exclusion was silently making it look
  // like a reimbursement instead by process of elimination — it has no
  // reimbursesExpenseId or multiAllocations at all, so it was showing
  // up as a $0 row on the Reimbursed screen rather than the correct
  // outcome, which is not appearing in either stat. A correction to
  // match the real bank isn't new income and isn't anyone paying
  // anything back; it shouldn't read as either.
  return !t.isExpense && !isUnlinkedIncome(t) && !t.isBalanceAdjustment
}

/** The narrower, display-facing version of "is this a reimbursement" —
 * genuinely someone else paying you back, and only that. Confirmed
 * directly this needed splitting out from isLinkedReimbursement: that
 * broader check also matches two other income-direction, linked
 * transaction shapes that have nothing to do with anyone reimbursing
 * anyone — a Transfer's own income side (reimbursesExpenseId there
 * points at its own paired expense purely as the plumbing that keeps
 * the two halves connected, see createTransfer) and a "Fund from
 * Savings" offset (fundedFromAccountId set, your own money covering
 * your own expense). Both were showing up on the Reimbursed tile and
 * screen, inflating it with money that was never anyone else's in the
 * first place. Kept separate from isLinkedReimbursement itself rather
 * than changing what that means everywhere, since a couple of other
 * calculations (fundedFromSavingsThisPeriod, the excess-income figures
 * on Income/trend screens) specifically need the broader definition
 * and would silently break if it narrowed under them. */
export function isGenuineReimbursement(t: Transaction, all: Transaction[]): boolean {
  if (!isLinkedReimbursement(t)) return false
  if (t.fundedFromAccountId) return false
  for (const expenseId of coveredExpenseIds(t)) {
    const expense = all.find((e) => e.id === expenseId)
    if (expense && isAccountTransferLink(t, expense)) return false
  }
  return true
}

/** Every expense id a reimbursement transaction covers — one, via the
 * simple single-link field, or several, via multiAllocations. Shared so
 * anything that needs to walk "what does this payment actually cover"
 * (the dashboard's own Reimbursed total, monthly/custom-range reports,
 * and more) does it the same way rather than re-deriving it and
 * potentially only handling one of the two shapes. */
export function coveredExpenseIds(t: Transaction): string[] {
  if (t.multiAllocations && t.multiAllocations.length > 0) return t.multiAllocations.map((a) => a.expenseId)
  if (t.reimbursesExpenseId) return [t.reimbursesExpenseId]
  return []
}

/** Reimbursements linked to a given expense — both the simple,
 * single-expense case (reimbursesExpenseId, used when editing one
 * transaction's own Fund From Savings link) and the multi-expense case
 * (multiAllocations, used by the bulk reimburse/fund flows, where one
 * real payment covers several different expenses at once).
 *
 * For a multi-allocation transaction, returns a SYNTHESIZED view with
 * `.amount` overridden to just this expense's own share, not the full
 * transaction total — e.g. a single $970 payment covering three
 * different expenses shows up here, for any ONE of those expenses, as
 * a transaction whose amount is only the $450 (or whatever) that
 * specific expense actually received. This is the one place that
 * distinction gets made: every other calculation in this file
 * (totalReimbursed, netAmount, reimbursementBreakdown,
 * outstandingReimbursements, fundedFromSavingsThisPeriod, repaysNote,
 * and more) is built on top of this function and just reads `.amount`
 * normally, so they all correctly handle multi-allocation transactions
 * automatically without needing their own changes. */
export function reimbursementsFor(expense: Transaction, all: Transaction[]): Transaction[] {
  const direct = all.filter((t) => t.reimbursesExpenseId === expense.id)
  const multi = all
    .filter((t) => t.multiAllocations?.some((a) => a.expenseId === expense.id))
    .map((t) => {
      const allocation = t.multiAllocations!.find((a) => a.expenseId === expense.id)!
      return { ...t, amount: allocation.amount }
    })
  return [...direct, ...multi]
}

/** The order an expense's linked reimbursements actually get applied to
 * its cost, everywhere that matters: a friend's repayment (or any
 * other non-savings reimbursement) always absorbs the expense first;
 * a savings draw-down only covers whatever's left after that — never
 * the other way around, regardless of which happened to get recorded
 * first. Confirmed directly with the person this is the intended
 * behavior: savings is meant to be the backstop, not the first source
 * tapped, so if someone pays you back for something you'd already
 * funded from savings, that repayment should be understood as
 * displacing the savings draw (freeing it up), not stacking as extra
 * income on top of an unnecessarily-large savings withdrawal.
 *
 * Within each of those two groups, still date order (earliest first) —
 * this only changes the relative order BETWEEN a savings source and a
 * non-savings one, not the order among several contributions of the
 * same kind, which still resolves the same predictable way it always
 * did.
 *
 * Every place that allocates a shared cost across several
 * reimbursements — excess detection, the savings-vs-other breakdown,
 * the dashboard's reimbursed/funded-from-savings stats — goes through
 * this one function, so the priority rule can't drift out of sync
 * between them the way five separate copies of the same sort would. */
export function orderedReimbursements(expense: Transaction, all: Transaction[]): Transaction[] {
  const priority = (t: Transaction): number => (t.fundedFromAccountId ? 1 : 0)
  return reimbursementsFor(expense, all).sort((a, b) => {
    const byPriority = priority(a) - priority(b)
    return byPriority !== 0 ? byPriority : a.date.localeCompare(b.date)
  })
}

export function totalReimbursed(expense: Transaction, all: Transaction[]): number {
  return reimbursementsFor(expense, all).reduce((sum, t) => sum + t.amount, 0)
}

/** What an expense actually cost after reimbursement — floored at 0.
 *
 * Only nets out reimbursement from OTHER people/sources. Money funded
 * from one of the person's own accounts is deliberately NOT netted
 * here, even though the underlying link (an income transaction
 * pointing at the expense) is identical to a genuine external
 * reimbursement — confirmed via a real screenshot this was wrong: a
 * trip expense fully covered by a savings draw-down was showing as
 * "-$0.00" on its own transaction row, reading as if it cost nothing.
 * It did cost something — the account balance really went down to pay
 * for it — it just wasn't new money someone else handed back. Only
 * genuine outside reimbursement (a friend paying their share) removes
 * something from what this expense cost the person overall.
 *
 * `fundedFromAccountId` is what distinguishes the two: a reimbursing
 * transaction that carries it is a self-funded draw-down and is
 * excluded from the netting; anything else nets as before.
 * `includeSelfFunded` defaults to false (the old fully-netted
 * behavior) for the few callers — goal-contribution accounting —
 * where a transaction being reimbursed at all isn't a real scenario,
 * so there was no reason to pass it through just for this. */
export function netAmount(transaction: Transaction, all: Transaction[], includeSelfFunded: boolean = false): number {
  if (!transaction.isExpense) return transaction.amount
  // A transfer's own "reimbursement" (its linked income landing in
  // another of the person's own tracked accounts) is deliberately NOT
  // netted out here — confirmed via a real screenshot this was showing
  // a transfer's outbound side as "-$0.00" on the transaction list,
  // which reads as if the expense cost nothing. It didn't cost nothing;
  // the money genuinely moved, just to somewhere this person still owns
  // and tracks. Netting to zero only makes sense for a genuine
  // reimbursement, where the whole point IS that it didn't cost
  // anything extra. Safe to exclude here specifically: a transfer
  // always has categoryId null, so this change can't affect any
  // category's spend or Safe to Spend either way — it only fixes what
  // the transaction's own row displays.
  const reimbursed = reimbursementsFor(transaction, all)
    .filter((t) => !isAccountTransferLink(t, transaction))
    .filter((t) => includeSelfFunded || !t.fundedFromAccountId)
    .reduce((sum, t) => sum + t.amount, 0)
  if (reimbursed === 0) return transaction.amount
  return Math.max(transaction.amount - reimbursed, 0)
}

/**
 * If reimbursements linked to an expense add up to MORE than it cost, the
/**
 * If reimbursements linked to an expense add up to MORE than it cost, the
 * excess is real income, not a reimbursement — allocated in priority
 * order (see orderedReimbursements: other reimbursements first, then
 * self-funded) so with several sources chipping in, only the actual
 * overflow counts as excess, not an even split across everyone.
 */
export function totalExcessReimbursement(expense: Transaction, all: Transaction[]): number {
  if (!expense.isExpense) return 0
  const reimbursements = orderedReimbursements(expense, all)
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
/** Net spend for a category (+ subcategories) within the given month.
 *
 * Deliberately budget-relative, not the same "what did this actually
 * cost me" concept netAmount uses for a transaction row: a savings
 * draw-down IS excluded from this netting (categories intentionally not
 * passed to netAmount below), because this number feeds Safe to Spend
 * and every budget-vs-spent progress bar in the app. Confirmed by a
 * real regression while making the transaction-row display more
 * accurate elsewhere: if a savings-funded expense counted fully against
 * this month's budget too, the same dollar would reduce Safe to Spend
 * twice — once when it was originally set aside into savings, again
 * here when it's drawn back out to pay for something. The "How Safe to
 * Spend Works" breakdown on the dashboard exists specifically to
 * explain why a savings draw-down doesn't reduce this a second time;
 * this function is what makes that explanation actually true. */
export function netSpentForCategory(category: Category, allCategories: Category[], allTransactions: Transaction[], referenceDate: Date): number {
  const ids = categoryAndDescendantIds(category, allCategories)
  const relevant = allTransactions.filter((t) => t.categoryId && ids.has(t.categoryId) && isInSamePeriod(new Date(t.date), referenceDate))

  const expenses = relevant.filter((t) => t.isExpense).reduce((sum, t) => sum + netAmount(t, allTransactions), 0)
  const excess = relevant.filter((t) => t.isExpense).reduce((sum, t) => sum + totalExcessReimbursement(t, allTransactions), 0)
  const unlinkedIncome = relevant.filter((t) => isUnlinkedIncome(t)).reduce((sum, t) => sum + t.amount, 0)

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
      if (r.frequency === 'yearly') {
        // Same double-counting guard as monthly, just applied to the
        // month it's actually due rather than every month: without
        // this, the month a yearly bill's real transaction posts, Safe
        // to Spend counted BOTH the full real amount (via the category
        // it's budgeted under) AND that month's routine 1/12th reserve
        // on top of it — over-penalizing by the monthly-equivalent
        // share specifically in its own due month, confirmed directly
        // with a real $1200/year bill posting in October: reserve
        // stayed at $100 that month instead of dropping to $0 the way
        // monthly's own guard already does when ITS bill posts.
        const paid = paidOccurrencesThisPeriod(r, transactions, referenceDate)
        return paid > 0 ? sum : sum + r.amount / 12
      }
      if (r.frequency === 'weekly') {
        const fullReserve = (r.amount * 52) / 12
        const paid = paidOccurrencesThisPeriod(r, transactions, referenceDate)
        const alreadyCovered = Math.min(fullReserve, paid * r.amount)
        return sum + Math.max(0, fullReserve - alreadyCovered)
      }
      return sum
    }, 0)
}

export function computeDashboardTotals(categories: Category[], transactions: Transaction[], referenceDate: Date, recurring: RecurringTransaction[] = [], accounts: Account[] = []): DashboardTotals {
  const topLevel = categories.filter((c) => !c.parentId)
  const thisMonth = transactions.filter((t) => isInSamePeriod(new Date(t.date), referenceDate))

  // No more "exclude savings categories" filter here — a savings goal
  // is an account now, not a category, so every top-level category is
  // a genuine spending category and this is simply all of this
  // period's category-based spend.
  const spent = topLevel.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)

  const goalAccounts = accounts.filter((a) => isSavingsAccount(a))
  const saved = goalAccounts.reduce((sum, a) => sum + Math.max(0, goalAccountChangeInPeriod(a, transactions, referenceDate)), 0)

  const unlinkedIncome = thisMonth.filter((t) => isUnlinkedIncome(t)).reduce((sum, t) => sum + t.amount, 0)
  const excessFromLinked = thisMonth
    .filter((t) => isLinkedReimbursement(t))
    .reduce((sum, t) => sum + excessForReimbursement(t, transactions), 0)
  const income = unlinkedIncome + excessFromLinked

  const reimbursed = thisMonth
    .filter((t) => isGenuineReimbursement(t, transactions))
    .reduce((sum, t) => {
      let total = 0
      for (const expenseId of coveredExpenseIds(t)) {
        const expense = transactions.find((e) => e.id === expenseId)
        if (!expense) continue
        const reimbursements = orderedReimbursements(expense, transactions)
        let remaining = expense.amount
        for (const r of reimbursements) {
          const applied = Math.min(r.amount, Math.max(0, remaining))
          if (r.id === t.id) { total += applied; break }
          remaining -= applied
        }
      }
      return sum + total
    }, 0)
  const totalBudget = topLevel.reduce((sum, c) => sum + effectiveBudget(c, categories), 0)
  const totalNetBudgetedSpent = topLevel.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), 0)
  // Prorated recurring bills (yearly ones especially) reserve their
  // monthly-equivalent share year-round, not just in the month they're
  // actually due — otherwise an annual premium looks "free" for 11
  // months and then blows the budget the one month it lands.
  const monthlyRecurringReserve = monthlyEquivalentRecurringExpenses(recurring, transactions, referenceDate)
  // Money moved into a goal account this period is subtracted
  // explicitly here now — under the old category-based goal, a
  // contribution was itself a categorized expense transaction, so it
  // was already folded into totalNetBudgetedSpent with no separate
  // term needed. A real deposit into a goal account isn't necessarily
  // categorized at all (a transfer's own transactions always have
  // categoryId null), so nothing above would otherwise catch it: every
  // dollar moved into savings still needs to reduce Safe to Spend,
  // budgeted or not, exactly as it always has.
  const safeToSpend = totalBudget - totalNetBudgetedSpent - monthlyRecurringReserve - saved

  return { spent, income, reimbursed, saved, totalBudget, safeToSpend }
}

/** How much of this period's spending was covered by drawing down a
 * savings category, specifically — a sub-breakdown of what's already
 * folded into Net Spend So Far, not a separate deduction on top of it
 * (that would double count it). Exists purely for transparency: without
 * this, "why is my net spend lower than what I actually paid for
 * things" has no visible answer on the Safe to Spend breakdown, even
 * though the app is already doing the right thing underneath. */
export function fundedFromSavingsThisPeriod(transactions: Transaction[], referenceDate: Date): number {
  const thisMonth = transactions.filter((t) => isInSamePeriod(new Date(t.date), referenceDate))
  return thisMonth
    .filter((t) => isLinkedReimbursement(t))
    .filter((t) => !!t.fundedFromAccountId)
    .reduce((sum, t) => {
      let total = 0
      for (const expenseId of coveredExpenseIds(t)) {
        const expense = transactions.find((e) => e.id === expenseId)
        if (!expense) continue
        const reimbursements = orderedReimbursements(expense, transactions)
        let remaining = expense.amount
        for (const r of reimbursements) {
          const applied = Math.min(r.amount, Math.max(0, remaining))
          if (r.id === t.id) { total += applied; break }
          remaining -= applied
        }
      }
      return sum + total
    }, 0)
}

export interface AppliedReimbursement {
  transaction: Transaction
  expense: Transaction
  applied: number
}

export interface ReimbursementBreakdown {
  totalCost: number
  fundedFromSavings: number
  reimbursedByOthers: number
  outOfPocket: number
  savingsTransactions: AppliedReimbursement[]
  otherTransactions: AppliedReimbursement[]
}

/** Splits a set of expenses' total cost into where the money to cover
 * them actually came from — savings you'd already set aside, someone
 * else genuinely paying you back, or still truly out of your own
 * pocket. Built for a tag's "trip" or "event" view (where the person
 * wants to see the whole picture at once: what did this cost in total,
 * how much of that did I cover from savings, how much did others pay
 * back, and what's actually still mine to have paid), but takes a plain
 * list of expenses rather than being tag-specific, so it works for any
 * grouped set. Mirrors fundedFromSavingsThisPeriod's own per-expense
 * "how much of THIS SPECIFIC reimbursement actually got applied, in
 * order" logic, just generalized to accept any expense list instead of
 * a period filter, and further split into savings vs everything else
 * rather than only isolating savings.
 *
 * Also returns which specific transactions make up each total, not
 * just the sum — a person looking at "$300 reimbursed by others" with
 * no way to see which transaction that actually was has no way to
 * verify or trace it, which defeats the point of showing the number
 * at all. */
export function reimbursementBreakdown(expenses: Transaction[], all: Transaction[]): ReimbursementBreakdown {
  const totalCost = expenses.reduce((sum, e) => sum + e.amount, 0)
  let fundedFromSavings = 0
  let reimbursedByOthers = 0
  const savingsTransactions: AppliedReimbursement[] = []
  const otherTransactions: AppliedReimbursement[] = []

  for (const expense of expenses) {
    const reimbursements = orderedReimbursements(expense, all)
    let remaining = expense.amount
    for (const r of reimbursements) {
      const applied = Math.min(r.amount, Math.max(0, remaining))
      if (applied > 0.01) {
        const entry: AppliedReimbursement = { transaction: r, expense, applied }
        if (r.fundedFromAccountId) { fundedFromSavings += applied; savingsTransactions.push(entry) }
        else { reimbursedByOthers += applied; otherTransactions.push(entry) }
      }
      remaining -= applied
    }
  }

  const outOfPocket = Math.max(0, totalCost - fundedFromSavings - reimbursedByOthers)
  return { totalCost, fundedFromSavings, reimbursedByOthers, outOfPocket, savingsTransactions, otherTransactions }
}

export interface SavingsGivebackPlan {
  reductions: { transactionId: string; expenseId: string; reduceBy: number }[]
  totalGivenBack: number
}

/** When a new reimbursement is about to be applied to a set of expenses
 * and, combined with what's already been reimbursed by others, would
 * now cover more of the total cost than savings actually needs to —
 * works out which existing savings-funding transactions should shrink
 * (or disappear entirely) to give that freed-up amount back to savings,
 * since a friend's payment is meant to take priority over your own
 * savings as the funding source, not just pile up as unlinked excess
 * income on top of it.
 *
 * Reduces the MOST RECENTLY applied savings funding first — the newest
 * draw is the least "already spent" one — working backward through
 * older ones only if the newest alone isn't enough to free up the full
 * amount needed.
 *
 * Returns which EXPENSE's allocation on which transaction to reduce,
 * and by how much — not a new whole-transaction amount directly, since
 * a savings-funding transaction covering several different expenses at
 * once (multiAllocations) can't have its total amount blindly
 * overwritten without corrupting whichever OTHER expenses it also
 * covers. applySavingsGiveback (db.ts) is what actually knows how to
 * turn one of these reductions into the right write, whether the
 * target is a simple single-link transaction or one allocation inside
 * a shared one. */
export function planSavingsGiveback(expenses: Transaction[], all: Transaction[], incomingReimbursement: number): SavingsGivebackPlan {
  const breakdown = reimbursementBreakdown(expenses, all)
  const newTotalOther = breakdown.reimbursedByOthers + incomingReimbursement
  const idealSavings = Math.max(0, Math.round((breakdown.totalCost - newTotalOther) * 100) / 100)
  let toGiveBack = Math.max(0, Math.round((breakdown.fundedFromSavings - idealSavings) * 100) / 100)

  const reductions: SavingsGivebackPlan['reductions'] = []
  let totalGivenBack = 0

  const mostRecentFirst = [...breakdown.savingsTransactions].sort((a, b) => b.transaction.date.localeCompare(a.transaction.date))
  for (const entry of mostRecentFirst) {
    if (toGiveBack <= 0.01) break
    const reduceBy = Math.min(entry.applied, toGiveBack)
    reductions.push({ transactionId: entry.transaction.id, expenseId: entry.expense.id, reduceBy })
    totalGivenBack += reduceBy
    toGiveBack = Math.round((toGiveBack - reduceBy) * 100) / 100
  }

  return { reductions, totalGivenBack: Math.round(totalGivenBack * 100) / 100 }
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
  const topLevel = categories.filter((c) => !c.parentId)

  return topLevel
    .map((c) => ({ categoryId: c.id, name: c.name, color: c.color, amount: Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)) }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount)
}

export interface DayPoint {
  date: Date
  amount: number
}

/** Budget-relative daily spend for the "Last 14 Days" chart — same
 * savings-excluded concept as netSpentForCategory, deliberately, so
 * this chart's numbers and the Dashboard's Spent tile / Safe to Spend
 * never disagree for the same day. See netSpentForCategory. */
export function last14DaysSpend(transactions: Transaction[], referenceDate: Date = new Date()): DayPoint[] {
  const result: DayPoint[] = []
  for (let offset = 13; offset >= 0; offset--) {
    const day = new Date(referenceDate)
    day.setDate(day.getDate() - offset)
    const dayStr = day.toDateString()
    const total = transactions
      .filter((t) => t.isExpense && new Date(t.date).toDateString() === dayStr)
      .reduce((sum, t) => sum + netAmount(t, transactions), 0)
    result.push({ date: day, amount: total })
  }
  return result
}

export interface PeriodPoint {
  periodStart: Date
  amount: number
  budget?: number
}

/** Budget-relative monthly spend for the "Monthly Trend" chart — same
 * savings-excluded concept as netSpentForCategory (see there), and
 * specifically what PeriodDetail's own total must match when a bar
 * here gets tapped into. */
export function last6PeriodsSpend(transactions: Transaction[], referenceDate: Date = new Date()): PeriodPoint[] {
  const result: PeriodPoint[] = []
  for (let offset = 5; offset >= 0; offset--) {
    const period = periodOffsetBy(-offset, referenceDate)
    const total = transactions
      .filter((t) => t.isExpense && new Date(t.date) >= period.start && new Date(t.date) < period.end)
      .reduce((sum, t) => sum + netAmount(t, transactions), 0)
    result.push({ periodStart: period.start, amount: total })
  }
  return result
}

/** One category's spend against its budget across several past
 * periods — "was I over on Dining Out every month" is a question that
 * needed browsing six separate screens before this, one period at a
 * time, with nothing to directly compare them against each other. Uses
 * the category's CURRENT budget for every period shown, not whatever
 * it happened to be set to at the time — the app doesn't keep a
 * history of budget changes, so this is the honest simplification: how
 * would recent spending have measured up against today's budget, not a
 * perfect reconstruction of a number that was never stored per-period
 * in the first place. */
export function categoryTrend(category: Category, categories: Category[], transactions: Transaction[], referenceDate: Date = new Date(), periodsBack = 6): PeriodPoint[] {
  const budget = effectiveBudget(category, categories)
  const result: PeriodPoint[] = []
  for (let offset = periodsBack - 1; offset >= 0; offset--) {
    const period = periodOffsetBy(-offset, referenceDate)
    const periodMidpoint = new Date((period.start.getTime() + period.end.getTime()) / 2)
    const spent = Math.max(0, netSpentForCategory(category, categories, transactions, periodMidpoint))
    result.push({ periodStart: period.start, amount: spent, budget })
  }
  return result
}

/** Budget-relative net savings (income minus budget-relative spend) for
 * the "Net Savings Trend" chart, sitting directly under Monthly Trend —
 * uses the same savings-excluded spend concept as that chart (see
 * netSpentForCategory) so the two stay comparable month to month. */
export function last6PeriodsNetSavings(transactions: Transaction[], referenceDate: Date = new Date()): PeriodPoint[] {
  const result: PeriodPoint[] = []
  for (let offset = 5; offset >= 0; offset--) {
    const period = periodOffsetBy(-offset, referenceDate)
    const periodTx = transactions.filter((t) => new Date(t.date) >= period.start && new Date(t.date) < period.end)

    const spent = periodTx
      .filter((t) => t.isExpense)
      .reduce((sum, t) => sum + netAmount(t, transactions), 0)

    const unlinkedIncome = periodTx.filter((t) => isUnlinkedIncome(t)).reduce((sum, t) => sum + t.amount, 0)
    const excessFromLinked = periodTx
      .filter((t) => isLinkedReimbursement(t))
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

/** Unlike the budget-relative spend functions above, this deliberately
 * uses the savings-INCLUSIVE netAmount (categories passed through) — a
 * merchant total is "how much did I actually pay this merchant,"
 * matching what an individual transaction row shows, not a
 * budget-consumption figure. */
export function topMerchantsThisMonth(transactions: Transaction[], referenceDate: Date = new Date(), limit = 5): MerchantTotal[] {
  const thisMonth = transactions
    .filter((t) => t.isExpense && !!t.note.trim() && isInSamePeriod(new Date(t.date), referenceDate))
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
      existing.amount += netAmount(t, transactions, true)
    } else {
      map.set(key, { amount: netAmount(t, transactions, true), note: t.note.trim() })
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
/** Deliberately savings-INCLUSIVE (categories passed through) — a tag's
 * monthly total here must match TagDetail's own header for that same
 * tag, which is a trip-cost concept (real money spent, savings-funded
 * included), not a budget-consumption one. */
export function topTagsThisMonth(transactions: Transaction[], referenceDate: Date = new Date(), limit = 5): TagTotal[] {
  const thisMonth = transactions.filter((t) => t.isExpense && t.tags.length > 0 && isInSamePeriod(new Date(t.date), referenceDate))

  const map = new Map<string, { amount: number; count: number }>()
  for (const t of thisMonth) {
    const amount = netAmount(t, transactions, true)
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
/** Expenses where someone still owes you money — deliberately keyed on
 * a GENUINE reimbursement having started, not just any linked income at
 * all. Confirmed via direct testing this needed splitting out: an
 * expense funded partway from your own savings, with no friend
 * involved anywhere, was showing up here with the unfunded remainder
 * labeled as money "owed" to you — nobody owed anything, it was simply
 * the part you hadn't funded yet. The owed AMOUNT itself still nets out
 * everything already applied (a friend's partial payment and any
 * savings funding together), since what's actually left unaccounted
 * for is genuinely correct either way — only the question of whether
 * this expense belongs on the list at all needed the stricter, genuine
 * check. */
export function outstandingReimbursements(transactions: Transaction[]): OutstandingReimbursement[] {
  return transactions
    .filter((t) => t.isExpense)
    .map((t) => ({
      transaction: t,
      owed: t.amount - totalReimbursed(t, transactions),
      hasGenuineReimbursement: reimbursementsFor(t, transactions).some((r) => isGenuineReimbursement(r, transactions))
    }))
    .filter((r) => r.owed > 0.01 && r.hasGenuineReimbursement)
    .map(({ transaction, owed }) => ({ transaction, owed }))
    .sort((a, b) => b.owed - a.owed)
}

/** A transfer between two of the person's own tracked accounts uses the
 * exact same linking mechanism as a reimbursement (an income
 * transaction pointing at the expense it offsets) — deliberately, so it
 * inherits the same safe-deletion handling and the same automatic
 * exclusion from the Income stat, without a new field or new
 * calculation path to keep in sync.
 *
 * Originally identified purely by both sides having a DIFFERENT account
 * set. Confirmed via a real screenshot that signal alone is too broad:
 * TagDetail's bulk "Fund from Savings" and bulk "Reimburse" flows both
 * legitimately set a real accountId (the savings account, or wherever
 * the friend's money landed) that's very often different from the
 * expense's own account — which made ordinary reimbursements of real,
 * categorized spending get misread as transfers, silently excluded from
 * netAmount's netting (so a fully-reimbursed expense still showed its
 * full original cost) and from the category/tag breakdowns that rely on
 * netAmount too.
 *
 * The expense side's categoryId is the reliable extra signal: createTransfer
 * always leaves it null on both creation and every subsequent edit (the
 * transfer editor has no category field at all), while a real expense
 * being funded or reimbursed — the whole reason reimbursementsFor exists
 * — is a categorized purchase in the overwhelming normal case. Requiring
 * categoryId === null keeps genuine transfers (old and new) recognized
 * exactly as before, while no longer catching a categorized expense's
 * reimbursement just because it happened to be recorded on a different
 * account. */
export function isAccountTransferLink(reimbursingTx: Transaction, expenseTx: Transaction): boolean {
  return !!reimbursingTx.accountId && !!expenseTx.accountId && reimbursingTx.accountId !== expenseTx.accountId && expenseTx.categoryId === null
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
export function findFundedExpense(transaction: Transaction, all: Transaction[]): Transaction | null {
  if (transaction.isExpense || !transaction.reimbursesExpenseId) return null
  const expense = all.find((t) => t.id === transaction.reimbursesExpenseId)
  if (!expense) return null
  if (isAccountTransferLink(transaction, expense)) return null
  if (!transaction.fundedFromAccountId) return null
  return expense
}

/** Given either half of a "Fund from Savings" pair — the real
 * withdrawal on the goal account, or the offset that links it to the
 * expense it covers — finds the other half. Unlike a Transfer, these
 * two aren't connected by any explicit id (see fundExpensesFromAccount);
 * matched here by the same shared characteristics a genuine pair
 * always has, so every caller that needs this finds it the same way
 * rather than each re-deriving a slightly different version. Confirmed
 * via direct testing this needed to exist and be used everywhere the
 * pair can be deleted: without it, removing just one side — reachable
 * through ordinary swipe-to-delete, not just the dedicated funding-link
 * view — leaves the other side behind. For the offset, that's a
 * harmless dangling link; for the real withdrawal, it's a permanent,
 * invisible drain on the account's balance, since it's left with no
 * category and (once its own account is later deleted) potentially no
 * account either, making it unfindable through any normal screen. */
export function findFundingPair(transaction: Transaction, all: Transaction[]): Transaction | null {
  if (!transaction.isExpense && transaction.fundedFromAccountId) {
    return all.find((t) =>
      t.id !== transaction.id &&
      t.isExpense &&
      t.accountId === transaction.fundedFromAccountId &&
      t.categoryId === null &&
      !t.reimbursesExpenseId &&
      Math.abs(t.amount - transaction.amount) < 0.01 &&
      t.date === transaction.date
    ) ?? null
  }
  if (transaction.isExpense && transaction.categoryId === null && transaction.accountId) {
    return all.find((t) =>
      t.id !== transaction.id &&
      !t.isExpense &&
      t.fundedFromAccountId === transaction.accountId &&
      Math.abs(t.amount - transaction.amount) < 0.01 &&
      t.date === transaction.date
    ) ?? null
  }
  return null
}

export function repaysNote(transaction: Transaction, all: Transaction[], accounts: Account[] = []): string | null {
  if (transaction.isExpense) return null

  if (transaction.multiAllocations && transaction.multiAllocations.length > 0) {
    // Same savings-vs-reimbursement distinction as the single-expense
    // case below, just described once for the whole shared payment
    // rather than per expense — a person reading "covers 3 expenses"
    // still needs to know whether that money came from their own
    // account or someone else, the same way the single-link case
    // already makes that distinction.
    const count = transaction.multiAllocations.length
    if (transaction.fundedFromAccountId) {
      const fundedFrom = accounts.find((a) => a.id === transaction.fundedFromAccountId)
      return `funded from ${fundedFrom?.name ?? 'savings'} · covers ${count} expenses`
    }
    return `covers ${count} expenses`
  }

  if (!transaction.reimbursesExpenseId) return null
  const expense = all.find((e) => e.id === transaction.reimbursesExpenseId)
  if (!expense) return null
  // Distinguishes "I funded this from my own account" from "someone
  // else paid me back" — same underlying mechanism (an income
  // transaction linked to the expense it covers), but conceptually
  // different, and worth being explicit about rather than describing
  // both the same way just because they share one field.
  if (transaction.fundedFromAccountId) {
    const fundedFrom = accounts.find((a) => a.id === transaction.fundedFromAccountId)
    return `funded from ${fundedFrom?.name ?? 'savings'}`
  }
  if (isAccountTransferLink(transaction, expense)) {
    const fromAccount = accounts.find((a) => a.id === expense.accountId)
    return `transferred from ${fromAccount?.name ?? 'another account'}`
  }
  return `repays ${expense.note || 'transaction'}`
}

/** How much of THIS SPECIFIC reimbursement transaction is excess beyond
 * what the expense actually cost — allocated in priority order (see
 * orderedReimbursements), so with several sources chipping in, only the
 * actual overflow counts as excess, not an even split. Returns 0 if
 * this transaction isn't an excess-producing reimbursement at all. */
export function excessForReimbursement(transaction: Transaction, all: Transaction[]): number {
  if (transaction.isExpense || !transaction.reimbursesExpenseId) return 0
  const expense = all.find((e) => e.id === transaction.reimbursesExpenseId)
  if (!expense) return 0

  const reimbursements = orderedReimbursements(expense, all)
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
  // Distinguishes "funded from savings" / "transferred out" from a
  // genuine friend reimbursement — and, since paying on a card for a
  // shared cost you also part-fund from your own savings is a real,
  // normal combination (your own share from savings, everyone else's
  // share paying you back separately), specifically calls out the
  // savings portion when the two are genuinely mixed on the same
  // expense, rather than collapsing to the generic "reimbursed" wording
  // that would otherwise hide it entirely.
  //
  // Only the genuine-outside-reimbursement amount is ever phrased as
  // "− $Y reimbursed" — that's the only part netAmount actually
  // subtracts from what the row displays. Savings draw-downs and
  // transfers are both still real money spent, just not money someone
  // else gave back, so they're called out separately rather than
  // folded into that subtraction — confirmed via a real screenshot
  // this mattered: the old wording implied a fully savings-funded
  // expense net to $0, which no longer matches what the row shows.
  const linkedTransactions = reimbursementsFor(transaction, all)
  const savingsLinked = linkedTransactions.filter((t) => !!t.fundedFromAccountId)
  const transferLinked = linkedTransactions.filter((t) => isAccountTransferLink(t, transaction))
  const otherLinked = linkedTransactions.filter((t) => !savingsLinked.includes(t) && !transferLinked.includes(t))

  const savingsAmount = savingsLinked.reduce((sum, t) => sum + t.amount, 0)
  const transferAmount = transferLinked.reduce((sum, t) => sum + t.amount, 0)
  const otherAmount = otherLinked.reduce((sum, t) => sum + t.amount, 0)

  const asides: string[] = []
  if (savingsAmount > 0.01) asides.push(`${formatCurrency(savingsAmount)} from savings`)
  if (transferAmount > 0.01) asides.push(`${formatCurrency(transferAmount)} transferred out`)

  if (otherAmount > 0.01) {
    const suffix = asides.length > 0 ? ` (also ${asides.join(', ')})` : ''
    return `${formatCurrency(transaction.amount)} − ${formatCurrency(otherAmount)} reimbursed${suffix}`
  }
  // No genuine outside reimbursement — nothing here reduces the amount
  // shown, so no "−" subtraction is implied, just a plain statement of
  // where the (still fully spent) money came from.
  return asides.length > 0 ? asides.join(', ') : null
}

export interface BulkReimbursementAllocation {
  expenseId: string
  amount: number
}

/** Splits ONE lump-sum payment across several different, already-owed
 * expenses — the case a trip's cost being paid back all at once in a
 * single transfer, rather than the person who owes you settling each
 * expense separately, genuinely doesn't fit the existing one-income-
 * links-one-expense reimbursement flow. Deliberately still creates that
 * same familiar per-expense link underneath (one linked income
 * transaction per expense) rather than a new kind of link the rest of
 * the app doesn't know how to net, display, or exclude from Safe to
 * Spend — this only decides how much of the ONE payment each expense's
 * share is.
 *
 * Only ever allocates up to what's still actually owed on each expense
 * — one that's already been reimbursed some other way keeps whatever
 * headroom is left and no more. Allocates in the given order (typically
 * oldest first) and stops once the payment runs out, so a lump sum
 * smaller than the true total correctly covers the earliest expenses in
 * full rather than smearing a token amount across all of them — day to
 * day a shared trip is usually settled against what's ACTUALLY still
 * outstanding at the time, not a proportional shave off everything.
 * leftover is whatever's left of the payment once every expense is
 * fully covered (a lump sum larger than the true total), for the caller
 * to record separately as its own income rather than force onto an
 * expense that doesn't need it. */
export function splitBulkReimbursement(expenses: Transaction[], all: Transaction[], bulkAmount: number): { allocations: BulkReimbursementAllocation[]; leftover: number } {
  const allocations: BulkReimbursementAllocation[] = []
  let remaining = Math.round(bulkAmount * 100) / 100
  for (const expense of expenses) {
    if (remaining <= 0) break
    const owed = Math.round((expense.amount - totalReimbursed(expense, all)) * 100) / 100
    if (owed <= 0) continue
    const allocated = Math.min(owed, remaining)
    allocations.push({ expenseId: expense.id, amount: allocated })
    remaining = Math.round((remaining - allocated) * 100) / 100
  }
  return { allocations, leftover: Math.max(0, remaining) }
}

/** Whether this account has an explicit numeric target — used for
 * progress bars, pace projections, and off-pace/ready-to-renew
 * warnings, all of which need a real number to work with. Deliberately
 * NOT the test for whether money moving into an account should reduce
 * Safe to Spend — see isSavingsAccount for that, which was a real bug
 * fix: they're different questions, and this one used to incorrectly
 * stand in for both. */
export function isGoal(account: Account): boolean {
  return (account.goalTargetAmount ?? 0) > 0
}

/** Whether money moving into this account counts as being set aside —
 * type-based, not target-based. Confirmed via a real screenshot this
 * needed splitting from isGoal: a savings account created without a
 * specific dollar target (someone who just wants a general savings
 * pot, not a dated goal like a trip) is completely legitimate, but
 * isGoal alone would silently exclude it from Safe to Spend's
 * deduction entirely — a $2,000 transfer into it moved real money out
 * of what's available to spend, yet Safe to Spend didn't react at all.
 * Every savings-type account counts here, target or no target;
 * whether it ALSO has a specific numbered goal is a separate,
 * additional thing some of them have on top. */
export function isSavingsAccount(account: Account): boolean {
  return account.type === 'savings'
}

/** Cumulative progress toward a goal since goalStartDate (or the
 * account's entire history) — now just a read of the account's own
 * real balance, since a goal account's balance IS its progress. A
 * contribution is a real deposit, a draw-down (funding an expense) is
 * a real withdrawal, and accountBalanceAsOf already nets those
 * correctly with no separate bookkeeping needed here. */
export function goalProgress(account: Account, transactions: Transaction[], referenceDate: Date = new Date()): number {
  const current = accountBalanceAsOf(account, transactions, referenceDate)
  if (!account.goalStartDate) return Math.max(0, current)
  const goalStart = new Date(account.goalStartDate)
  const accountOpening = new Date(account.openingDate)
  // If the goal started at or before the account itself was opened,
  // there's no earlier baseline to subtract — the whole balance,
  // opening amount included, has accrued since the goal began.
  // Confirmed this was a real bug, not just a theoretical edge case:
  // it's the ordinary case whenever a goal account is created with its
  // goal already active from day one (the common path, including every
  // account the v9 migration creates from an old savings category) —
  // accountBalanceAsOf at any date before the account's own opening
  // trivially returns just the opening balance itself (no transactions
  // exist yet to adjust it), so subtracting that as if it were a
  // "starting point to exclude" silently zeroed out the entire opening
  // balance's worth of real progress.
  if (goalStart <= accountOpening) return Math.max(0, current)
  const dayBeforeStart = new Date(goalStart)
  dayBeforeStart.setDate(dayBeforeStart.getDate() - 1)
  const atStart = accountBalanceAsOf(account, transactions, dayBeforeStart)
  return Math.max(0, current - atStart)
}

export function goalProgressFraction(account: Account, transactions: Transaction[], referenceDate: Date = new Date()): number {
  const target = account.goalTargetAmount ?? 0
  if (target <= 0) return 0
  return Math.min(1, goalProgress(account, transactions, referenceDate) / target)
}

/** Projected completion date based on average monthly pace since the goal started. */
export function projectedGoalCompletionDate(account: Account, transactions: Transaction[], referenceDate: Date = new Date()): Date | null {
  const target = account.goalTargetAmount ?? 0
  if (target <= 0) return null
  const own = transactions.filter((t) => t.accountId === account.id)
  const earliestTx = own.reduce<Date | null>((earliest, t) => {
    const d = new Date(t.date)
    return !earliest || d < earliest ? d : earliest
  }, null)
  const start = account.goalStartDate ? new Date(account.goalStartDate) : (earliestTx ?? new Date(account.openingDate) ?? referenceDate)
  const monthsElapsed = Math.max(1 / 30, (referenceDate.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 30.44))
  const saved = goalProgress(account, transactions, referenceDate)
  if (saved <= 0 || monthsElapsed < 1) return null

  const monthlyPace = saved / monthsElapsed
  if (monthlyPace <= 0) return null
  const remaining = Math.max(0, target - saved)
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

/** All accounts combined into one figure — credit card balances
 * subtracted rather than added, since accountBalance deliberately
 * returns a credit card's balance as a positive "amount owed" (see its
 * own comments), correct for that account's own page but silently
 * wrong here if just summed in directly. The single shared source for
 * this: Dashboard's own net-worth line and the Insights screen's net
 * worth answer both build on this rather than each computing it
 * themselves, after finding they'd drifted into two separately
 * hand-written copies of the same formula. */
export function netWorthTotal(accounts: Account[], transactions: Transaction[]): number {
  let total = 0
  for (const a of accounts) {
    const balance = accountBalance(a, transactions)
    total += a.type === 'credit_card' ? -balance : balance
  }
  return total
}

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

/** How much a goal account's balance grew (or shrank) within the
 * budget period containing referenceDate — the account-based
 * replacement for what used to be a savings category's period spend.
 * Built entirely on accountBalanceAsOf's already-correct signed math
 * (deposits, withdrawals, and any transfer both count exactly as they
 * should there), so a real deposit, a real withdrawal to fund
 * something, and interest landing in the account all flow through
 * correctly with no extra special-casing needed here. */
/** How much a goal account's balance grew (or shrank) within the
 * budget period containing referenceDate — the account-based
 * replacement for what used to be a savings category's period spend.
 * Sums the period's own real deposits and withdrawals directly, rather
 * than subtracting two account-balance snapshots — confirmed that
 * subtraction approach was a real bug: it couldn't tell a genuine
 * contribution apart from a balance correction (matching the tracked
 * number to what the real bank shows), so fixing a stale balance on a
 * savings account made it look like new money had been saved that
 * period, when nothing was actually added. A correction is real and
 * still fully reflected in the account's own balance (accountBalance
 * itself must include it, or the correction would never take effect at
 * all) — it just isn't a *period's* worth of saving, which is what this
 * specific figure is asking. */
export function goalAccountChangeInPeriod(account: Account, transactions: Transaction[], referenceDate: Date): number {
  const period = periodContaining(referenceDate)
  const relevant = transactions.filter((t) =>
    t.accountId === account.id &&
    !t.isBalanceAdjustment &&
    new Date(t.date) >= period.start &&
    new Date(t.date) < period.end
  )
  const netFlow = relevant.reduce((sum, t) => sum + (t.isExpense ? -t.amount : t.amount), 0)
  return account.type === 'credit_card' ? -netFlow : netFlow
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

