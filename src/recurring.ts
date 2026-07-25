import type { Transaction, RecurringTransaction, RecurrenceFrequency } from './types'

export interface RecurringSuggestion {
  merchantKey: string
  displayName: string
  averageAmount: number
  isExpense: boolean
  frequency: RecurrenceFrequency
  occurrenceCount: number
  lastDate: Date
  suggestedNextDueDate: Date
  categoryId: string | null
}

function merchantKey(note: string): string {
  return note.trim().toLowerCase()
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
  const counts = new Map<string, number>()
  for (const t of transactions) {
    if (!t.categoryId) continue
    counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [id, count] of counts) {
    if (count > bestCount) { best = id; bestCount = count }
  }
  return best
}

function addInterval(date: Date, frequency: RecurrenceFrequency): Date {
  const d = new Date(date)
  if (frequency === 'weekly') d.setDate(d.getDate() + 7)
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1)
  if (frequency === 'yearly') d.setFullYear(d.getFullYear() + 1)
  return d
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
  const recent = transactions.filter((t) => new Date(t.date) >= cutoff && !t.reimbursesExpenseId)

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
      categoryId: mostCommonCategoryId(sorted)
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
    let guardCount = 0
    while (nextDue <= now && guardCount < 24) {
      newTransactions.push({
        amount: item.amount,
        note: item.note,
        date: nextDue.toISOString(),
        isExpense: item.isExpense,
        categoryId: item.categoryId,
        reimbursesExpenseId: null
      })
      nextDue = addInterval(nextDue, item.frequency)
      guardCount++
    }
    updatedRecurring.push({ ...item, nextDueDate: nextDue.toISOString() })
  }

  return { newTransactions, updatedRecurring }
}

export function frequencyLabel(f: RecurrenceFrequency): string {
  return f === 'weekly' ? 'Weekly' : f === 'monthly' ? 'Monthly' : 'Yearly'
}
