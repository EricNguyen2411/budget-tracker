import type { Transaction, RecurringTransaction, Category } from './types'
import { findDuplicates } from './duplicates'

export interface HealthFinding {
  icon: string
  title: string
  detail: string
  severity: 'info' | 'warning'
  transactions: Transaction[]
}

export function runHealthCheck(
  transactions: Transaction[],
  recurring: RecurringTransaction[],
  categories: Category[],
  referenceDate: Date = new Date()
): HealthFinding[] {
  const findings: HealthFinding[] = []

  const dupGroups = findDuplicates(transactions)
  if (dupGroups.length > 0) {
    const involved = dupGroups.flatMap((g) => g.transactions)
    findings.push({
      icon: '📑',
      title: `${dupGroups.length} possible duplicate group${dupGroups.length === 1 ? '' : 's'}`,
      detail: `${involved.length} transactions involved, matched by amount and date — open Duplicate Check to review and resolve them.`,
      severity: 'warning',
      transactions: involved
    })
  }

  const uncategorized = transactions.filter((t) => !t.categoryId)
  if (uncategorized.length >= 3) {
    findings.push({
      icon: '❓',
      title: `${uncategorized.length} uncategorized transactions`,
      detail: 'Not counted toward any budget or category total until they\u2019re assigned one.',
      severity: 'info',
      transactions: uncategorized
    })
  }

  const expenseAmounts = transactions.filter((t) => t.isExpense).map((t) => t.amount).sort((a, b) => a - b)
  if (expenseAmounts.length >= 10) {
    const median = expenseAmounts[Math.floor(expenseAmounts.length / 2)]
    if (median > 0) {
      const outliers = transactions.filter((t) => t.isExpense && t.amount > Math.max(median * 10, 300))
      if (outliers.length > 0) {
        findings.push({
          icon: '🚩',
          title: `${outliers.length} unusually large transaction${outliers.length === 1 ? '' : 's'}`,
          detail: 'Significantly bigger than your typical spend (over 10x the median) — worth confirming these amounts are correct.',
          severity: 'warning',
          transactions: outliers
        })
      }
    }
  }

  const transitKeywords = ['opal', 'transportfornsw', 'transport for nsw', 'tfnsw']
  const stalePendingFares = transactions.filter((t) => {
    if (!t.isExpense || t.amount > 2.0) return false
    const lower = t.note.toLowerCase()
    if (!transitKeywords.some((k) => lower.includes(k))) return false
    return referenceDate.getTime() - new Date(t.date).getTime() > 7 * 24 * 60 * 60 * 1000
  })
  if (stalePendingFares.length > 0) {
    findings.push({
      icon: '🚊',
      title: `${stalePendingFares.length} old pending transit fare${stalePendingFares.length === 1 ? '' : 's'}`,
      detail: 'Still showing a small placeholder amount from over a week ago — may need a manual update to the real fare.',
      severity: 'info',
      transactions: stalePendingFares
    })
  }

  const staleRecurring = recurring.filter((r) => r.isActive && referenceDate.getTime() - new Date(r.nextDueDate).getTime() > 45 * 24 * 60 * 60 * 1000)
  if (staleRecurring.length > 0) {
    findings.push({
      icon: '🔁',
      title: `${staleRecurring.length} recurring item${staleRecurring.length === 1 ? '' : 's'} overdue by 45+ days`,
      detail: 'Still marked active, but the due date is well in the past. Check Recurring to confirm these are still happening.',
      severity: 'warning',
      transactions: []
    })
  }

  const incomeInSavings = transactions.filter((t) => {
    if (t.isExpense || !t.categoryId) return false
    const cat = categories.find((c) => c.id === t.categoryId)
    return cat?.isSavingsCategory === true
  })
  if (incomeInSavings.length > 0) {
    findings.push({
      icon: '↔️',
      title: `${incomeInSavings.length} income transaction${incomeInSavings.length === 1 ? '' : 's'} in a savings category`,
      detail: 'Counted in Income, but NOT in Saved — Saved only tracks money moving out to savings (Expense direction). If these are contributions you made, switch them to Expense.',
      severity: 'warning',
      transactions: incomeInSavings
    })
  }

  return findings
}
