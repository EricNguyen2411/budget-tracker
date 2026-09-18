import type { Transaction, RecurringTransaction, RecurrenceFrequency } from './types'
import { normalizeMerchantKey } from './merchantRules'

export interface RecurringSuggestion {
  merchantKey: string
  displayName: string
  averageAmount: number
  isExpense: boolean
  frequency: RecurrenceFrequency
  occurrenceCount: number
  lastDate: Date
  suggestedNextDueDate: Date
  anchorDay: number
  categoryId: string | null
  accountId: string | null
}

function merchantKey(note: string): string {
  return normalizeMerchantKey(note)
}

function classifyFrequency(averageGapDays: number, gaps: number[]): RecurrenceFrequency | null {
  const maxDeviation = Math.max(...gaps.map((g) => Math.abs(g - averageGapDays)))
  const allowedDeviation = Math.max(4, averageGapDays * 0.35)
  if (maxDeviation > allowedDeviation) return null

  if (averageGapDays >= 5 && averageGapDays <= 10) return 'weekly'
  if (averageGapDays >= 25 && averageGapDays <= 36) return 'monthly'
  if (averageGapDays >= 340 && averageGapDays <= 390) return 'yearly'
  return null
}

function mostCommonCategoryId(transactions: Transaction[]): string | null {
  return mostCommonValue(transactions.map((t) => t.categoryId))
}

function mostCommonAccountId(transactions: Transaction[]): string | null {
  return mostCommonValue(transactions.map((t) => t.accountId))
}

function mostCommonValue(values: (string | null)[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [id, count] of counts) {
    if (count > bestCount) { best = id; bestCount = count }
  }
  return best
}

/** Adds calendar months (or years, via a 12-multiple) to `date`, always
 * targeting `anchorDay` as the resulting day-of-month — clamped to the
 * actual last day of that target month, never rolling over into the
 * next one. Confirmed directly this matters: a bill anchored on the
 * 31st, stepped monthly with plain `Date#setMonth`, drifted to the 3rd
 * within a couple of cycles (Jan 31 -> Feb 31 doesn't exist, so native
 * rollover silently becomes Mar 3 -> Mar 3 + 1 month = Apr 3 -> ...),
 * compounding further every cycle rather than settling anywhere near
 * the intended date. Using the ORIGINAL anchor day each time (not
 * `date`'s own, possibly-already-clamped day) is what makes a 31st-of-
 * the-month bill correctly return to the 31st in every month that has
 * one, rather than getting stuck at 28 forever the first time it
 * clamps for February. */
function addMonthsToAnchor(date: Date, months: number, anchorDay: number): Date {
  const targetYear = date.getFullYear()
  const targetMonth = date.getMonth() + months
  const daysInTargetMonth = new Date(targetYear, targetMonth + 1, 0).getDate()
  const day = Math.min(anchorDay, daysInTargetMonth)
  return new Date(targetYear, targetMonth, day, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
}

function addInterval(date: Date, frequency: RecurrenceFrequency, anchorDay: number = date.getDate()): Date {
  if (frequency === 'weekly') { const d = new Date(date); d.setDate(d.getDate() + 7); return d }
  if (frequency === 'monthly') return addMonthsToAnchor(date, 1, anchorDay)
  if (frequency === 'yearly') return addMonthsToAnchor(date, 12, anchorDay)
  return new Date(date)
}

export function detectRecurring(
  transactions: Transaction[],
  existingRecurring: RecurringTransaction[],
  dismissedKeys: string[],
  referenceDate: Date = new Date()
): RecurringSuggestion[] {
  const existingKeys = new Set(existingRecurring.map((r) => merchantKey(r.note)))
  const dismissed = new Set(dismissedKeys)

  const cutoff = new Date(referenceDate)
  cutoff.setMonth(cutoff.getMonth() - 18)
  const recent = transactions.filter((t) => new Date(t.date) >= cutoff && !t.reimbursesExpenseId && !(t.multiAllocations && t.multiAllocations.length > 0))

  const grouped = new Map<string, Transaction[]>()
  for (const t of recent) {
    const key = merchantKey(t.note)
    if (!key) continue
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(t)
  }

  const suggestions: RecurringSuggestion[] = []

  for (const [key, group] of grouped) {
    if (existingKeys.has(key) || dismissed.has(key)) continue
    if (group.length < 3) continue

    const sorted = [...group].sort((a, b) => a.date.localeCompare(b.date))
    const directions = new Set(sorted.map((t) => t.isExpense))
    if (directions.size !== 1) continue
    const isExpense = sorted[0].isExpense

    const amounts = sorted.map((t) => t.amount)
    const averageAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length
    const amountTolerance = Math.max(2, averageAmount * 0.15)
    if (!amounts.every((a) => Math.abs(a - averageAmount) <= amountTolerance)) continue

    const gaps: number[] = []
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()) / (1000 * 60 * 60 * 24))
    }
    const averageGapDays = gaps.reduce((s, g) => s + g, 0) / gaps.length
    const frequency = classifyFrequency(averageGapDays, gaps)
    if (!frequency) continue

    const lastDate = new Date(sorted[sorted.length - 1].date)
    const daysSinceLast = (referenceDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
    const expectedGap = frequency === 'weekly' ? 7 : frequency === 'monthly' ? 30.44 : 365.25
    if (daysSinceLast > expectedGap * 1.75) continue

    suggestions.push({
      merchantKey: key,
      displayName: sorted[sorted.length - 1].note,
      averageAmount,
      isExpense,
      frequency,
      occurrenceCount: sorted.length,
      lastDate,
      suggestedNextDueDate: addInterval(lastDate, frequency),
      anchorDay: lastDate.getDate(),
      categoryId: mostCommonCategoryId(sorted),
      accountId: mostCommonAccountId(sorted)
    })
  }

  return suggestions.sort((a, b) => b.occurrenceCount - a.occurrenceCount)
}

/** Creates due transactions for active recurring items and advances their due dates, capped at 24 catch-up iterations per item. */
export function processDueRecurring(
  recurring: RecurringTransaction[],
  now: Date = new Date()
): { newTransactions: Omit<Transaction, 'id'>[]; updatedRecurring: RecurringTransaction[] } {
  const newTransactions: Omit<Transaction, 'id'>[] = []
  const updatedRecurring: RecurringTransaction[] = []

  for (const item of recurring) {
    if (!item.isActive) { updatedRecurring.push(item); continue }
    let nextDue = new Date(item.nextDueDate)
    // Bootstrapped once from this item's own current nextDueDate for a
    // record saved before anchorDay existed — same pattern as
    // InstallmentPlan.nextInstallmentIndex. Persisted below even when
    // nothing is due this pass, so every subsequent cycle steps from
    // the SAME anchor rather than re-deriving it from whatever day
    // nextDueDate happens to be (which, post-fix, stays correct, but
    // re-deriving would silently reintroduce the drift bug for any
    // record still carrying an already-drifted nextDueDate from before
    // this fix).
    const anchorDay = item.anchorDay ?? new Date(item.nextDueDate).getDate()
    let guardCount = 0
    while (nextDue <= now && guardCount < 24) {
      newTransactions.push({
        amount: item.amount,
        note: item.note,
        date: nextDue.toISOString(),
        isExpense: item.isExpense,
        categoryId: item.categoryId,
        reimbursesExpenseId: null,
        tags: [],
        accountId: item.accountId ?? null
      })
      nextDue = addInterval(nextDue, item.frequency, anchorDay)
      guardCount++
    }
    updatedRecurring.push({ ...item, nextDueDate: nextDue.toISOString(), anchorDay })
  }

  return { newTransactions, updatedRecurring }
}

export function frequencyLabel(f: RecurrenceFrequency): string {
  return f === 'weekly' ? 'Weekly' : f === 'monthly' ? 'Monthly' : 'Yearly'
}
