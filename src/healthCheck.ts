import type { Transaction, RecurringTransaction, Category } from './types'
import { findDuplicates } from './duplicates'
import { goalProgress, projectedGoalCompletionDate, netSpentForCategory } from './calculations'
import { detectRecurring } from './recurring'
import { getSettings } from './budgetPeriod'

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

  // Goals with a target date that's either already passed without being
  // reached, or on a pace that won't get there in time — surfaced here
  // since Month in Review only shows this for the current month, and
  // it's easy to lose track of a goal you're not actively looking at.
  const goalsOffPace = categories.filter((c) => {
    if (!c.isSavingsCategory || !c.goalTargetDate || c.goalTargetAmount <= 0) return false
    if (goalProgress(c, transactions) >= c.goalTargetAmount) return false
    const target = new Date(c.goalTargetDate)
    if (target < referenceDate) return true // target date already passed, goal not reached
    const projected = projectedGoalCompletionDate(c, transactions, referenceDate)
    return projected !== null && projected > target
  })
  if (goalsOffPace.length > 0) {
    findings.push({
      icon: '🎯',
      title: `${goalsOffPace.length} savings goal${goalsOffPace.length === 1 ? '' : 's'} behind pace`,
      detail: goalsOffPace.map((c) => c.name).join(', ') + ' — at the current contribution rate, won\u2019t reach the target by the date set. Increase the monthly amount or push the date out.',
      severity: 'warning',
      transactions: []
    })
  }

  // Categories that have real spending this period but no budget set —
  // easy to miss since Budgets only shows categories that already have
  // one, so a forgotten category never surfaces there on its own.
  const unbudgeted = categories.filter((c) => {
    if (c.parentId || c.isSavingsCategory || c.monthlyBudget > 0) return false
    return netSpentForCategory(c, categories, transactions, referenceDate) > 0
  })
  if (unbudgeted.length > 0) {
    findings.push({
      icon: '📊',
      title: `${unbudgeted.length} categor${unbudgeted.length === 1 ? 'y has' : 'ies have'} spending but no budget`,
      detail: unbudgeted.map((c) => c.name).join(', ') + ' — has activity this period but no budget set, so Budget vs Actual has nothing to compare it against.',
      severity: 'info',
      transactions: []
    })
  }

  // Recurring-looking patterns that haven't actually been added as
  // recurring yet — the Recurring page only shows this if you go look;
  // surfacing it here means you're more likely to actually see it.
  const recurringSuggestions = detectRecurring(transactions, recurring, getSettings().dismissedRecurringSuggestions, referenceDate)
  if (recurringSuggestions.length > 0) {
    findings.push({
      icon: '✨',
      title: `${recurringSuggestions.length} transaction${recurringSuggestions.length === 1 ? ' looks' : 's look'} recurring but ${recurringSuggestions.length === 1 ? "isn't" : "aren't"} set up`,
      detail: recurringSuggestions.map((s) => s.displayName).join(', ') + ' — showing up on a regular pattern. Add these in Recurring so they\u2019re tracked and forecasted properly.',
      severity: 'info',
      transactions: []
    })
  }

  return findings
}
