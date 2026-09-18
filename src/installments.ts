import type { Transaction, InstallmentPlan, InstallmentFrequency } from './types'

/** Adds calendar months to `date`, targeting `anchorDay` as the
 * resulting day-of-month — clamped to that target month's actual last
 * day, never rolling over into the month after. See recurring.ts's
 * identical helper for the full story: native `Date#setMonth` treats
 * an out-of-range day as "roll into the next month", which drifts a
 * 31st-of-the-month due date further off course every single cycle
 * (Jan 31 -> Mar 3 -> Apr 3 -> ...) rather than clamping to Feb 28 and
 * bouncing back to the 31st every month that actually has one. */
function addMonthsToAnchor(date: Date, months: number, anchorDay: number): Date {
  const targetYear = date.getFullYear()
  const targetMonth = date.getMonth() + months
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate()
  const day = Math.min(anchorDay, daysInTargetMonth)
  return new Date(targetYear, targetMonth, day, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
}

function addInstallmentInterval(date: Date, frequency: InstallmentFrequency, anchorDay: number): Date {
  const d = new Date(date)
  if (frequency === 'weekly') d.setDate(d.getDate() + 7)
  if (frequency === 'fortnightly') d.setDate(d.getDate() + 14)
  if (frequency === 'monthly') return addMonthsToAnchor(date, 1, anchorDay)
  return d
}

/** Per-installment amounts, evenly split with the rounding remainder
 * absorbed by the LAST installment — matching how real BNPL providers
 * handle a total that doesn't divide evenly (e.g. $100 over 3 payments
 * is $33.33 / $33.33 / $33.34, not $33.33 / $33.33 / $33.33 which would
 * silently lose a cent, or $33.34 x 3 which would silently invent one). */
export function installmentAmounts(plan: InstallmentPlan): number[] {
  const base = Math.floor((plan.totalAmount / plan.numberOfInstallments) * 100) / 100
  const amounts = new Array(plan.numberOfInstallments).fill(base)
  const shortfall = Math.round((plan.totalAmount - base * plan.numberOfInstallments) * 100) / 100
  amounts[amounts.length - 1] = Math.round((base + shortfall) * 100) / 100
  return amounts
}

export function installmentDueDates(plan: InstallmentPlan): Date[] {
  const dates: Date[] = []
  const anchorDay = new Date(plan.firstDueDate).getDate()
  let cursor = new Date(plan.firstDueDate)
  for (let i = 0; i < plan.numberOfInstallments; i++) {
    dates.push(new Date(cursor))
    cursor = addInstallmentInterval(cursor, plan.frequency, anchorDay)
  }
  return dates
}

export interface InstallmentProgress {
  paidCount: number
  totalCount: number
  paidAmount: number
  remainingAmount: number
  nextDueDate: Date | null
  nextDueAmount: number | null
  isPaidOff: boolean
}

export function installmentProgress(plan: InstallmentPlan, transactions: Transaction[]): InstallmentProgress {
  const own = transactions.filter((t) => t.installmentPlanId === plan.id)
  const paidAmount = own.reduce((sum, t) => sum + t.amount, 0)
  const amounts = installmentAmounts(plan)
  const dueDates = installmentDueDates(plan)
  const remainingAmount = Math.max(0, Math.round((plan.totalAmount - paidAmount) * 100) / 100)
  // "How many installments has this plan gotten through" and "how many
  // real payments exist right now" are NOT the same question once a
  // generated payment has ever been deleted — confirmed directly:
  // processDueInstallments deliberately advances plan.nextInstallmentIndex
  // and never regenerates a slot once passed, specifically so deleting a
  // payment can't cause it to reappear as a duplicate later (see the
  // comment on that function). But this display was still recounting
  // existing transactions instead, so after a deletion it showed a
  // "next due" date and amount for the slot that was just deleted —
  // one the generator had already moved past and would never actually
  // create. Bootstrapped the same way processDueInstallments bootstraps
  // it, for a plan saved before this field existed.
  const nextIndex = plan.nextInstallmentIndex ?? own.length
  const paidCount = Math.min(nextIndex, plan.numberOfInstallments)
  const isPaidOff = paidCount >= plan.numberOfInstallments
  return {
    paidCount,
    totalCount: plan.numberOfInstallments,
    paidAmount,
    remainingAmount,
    nextDueDate: isPaidOff ? null : dueDates[paidCount],
    nextDueAmount: isPaidOff ? null : amounts[paidCount],
    isPaidOff
  }
}

/** Generates the actual transactions for any installment that's come
 * due and hasn't been created yet — the same "auto-generate real
 * transactions as they become due" mechanism processDueRecurring uses,
 * but for a fixed, known number of payments that stops rather than
 * continuing indefinitely.
 *
 * Advances from plan.nextInstallmentIndex, NOT from counting how many
 * matching transactions currently exist — confirmed directly that
 * counting existing transactions was a real bug: deleting a generated
 * payment (a genuine data-entry correction, or just not wanting it
 * tracked) dropped the count, and the very next time the app opened it
 * silently regenerated the "missing" payment, as if the deletion had
 * never happened. nextInstallmentIndex only ever moves forward, the
 * same way RecurringTransaction.nextDueDate does, so once an
 * installment has been attempted it's never attempted again regardless
 * of what happens to that transaction afterward. installmentProgress's
 * own paid count deliberately stays based on real existing
 * transactions, since that should reflect actual reality for display —
 * this counter's only job is preventing re-generation, not reporting
 * progress. */
export function processDueInstallments(
  plans: InstallmentPlan[],
  transactions: Transaction[],
  referenceDate: Date = new Date()
): { newTransactions: Omit<Transaction, 'id'>[]; updatedPlans: InstallmentPlan[] } {
  const newTransactions: Omit<Transaction, 'id'>[] = []
  const updatedPlans: InstallmentPlan[] = []
  for (const plan of plans) {
    if (!plan.isActive) continue
    // A plan saved before nextInstallmentIndex existed has no record of
    // how many installments were already generated — bootstrapped once
    // from actual existing transactions (matching the old
    // count-based behaviour) rather than assuming 0, which would
    // regenerate every already-paid installment as a duplicate the
    // first time this runs against an existing plan. Always persisted
    // below even when nothing new is due this pass, so the bootstrap
    // only ever happens once, not silently re-derived (and therefore
    // re-exposed to the exact deletion bug this exists to fix) every
    // time an old plan happens to have nothing due.
    const wasUnset = plan.nextInstallmentIndex === undefined
    let nextIndex = plan.nextInstallmentIndex ?? transactions.filter((t) => t.installmentPlanId === plan.id).length
    if (nextIndex >= plan.numberOfInstallments) {
      if (wasUnset) updatedPlans.push({ ...plan, nextInstallmentIndex: nextIndex })
      continue
    }
    const dueDates = installmentDueDates(plan)
    const amounts = installmentAmounts(plan)
    const startIndex = nextIndex
    // Catches up more than one missed payment in a single pass (e.g. the
    // app wasn't opened for a month and two fortnightly payments came
    // due in that time) rather than only ever advancing one payment per
    // visit, matching processDueRecurring's own catch-up behaviour.
    while (nextIndex < plan.numberOfInstallments && dueDates[nextIndex] <= referenceDate) {
      newTransactions.push({
        amount: amounts[nextIndex],
        note: `${plan.provider}: ${plan.note}`,
        date: dueDates[nextIndex].toISOString(),
        isExpense: true,
        categoryId: plan.categoryId,
        reimbursesExpenseId: null,
        tags: [],
        accountId: plan.accountId,
        installmentPlanId: plan.id
      })
      nextIndex++
    }
    if (nextIndex !== startIndex || wasUnset) {
      updatedPlans.push({ ...plan, nextInstallmentIndex: nextIndex })
    }
  }
  return { newTransactions, updatedPlans }
}
