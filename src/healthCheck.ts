import type { Transaction, RecurringTransaction, Category } from './types'
import { findDuplicates } from './duplicates'
import { goalProgress, projectedGoalCompletionDate, netSpentForCategory } from './calculations'
import { detectRecurring } from './recurring'
import { getSettings } from './budgetPeriod'
import { normalizeMerchantKey } from './merchantRules'

export interface HealthFinding {
  icon: string
  title: string
  detail: string
  severity: 'info' | 'warning'
  transactions: Transaction[]
  renewableCategoryIds?: string[]
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

  // Transport NSW (and Opal generally) authorizes contactless fares as
  // a small placeholder hold — confirmed via real NAB screenshots
  // earlier as an exact "Transport NSW (Contactless) -$1.00" line,
  // repeated across multiple days — then finalizes the REAL fare
  // separately once the trip is calculated, sometimes hours later,
  // sometimes the next day. Banks don't reliably update the original
  // transaction in place, so a small entry that's still sitting there
  // after a couple of days is very likely showing the placeholder
  // amount, not what actually got charged.
  //
  // Confirmed directly that the keyword list here never actually
  // matched that real format: "transport for nsw" requires the word
  // "for", which the real note doesn't have ("Transport NSW", no
  // "for") — so this check could never fire for the single most common
  // real-world case it exists to catch. Added the exact real pattern
  // rather than assuming the near-miss keywords already covered it.
  const transitKeywords = ['opal', 'transport nsw', 'transportfornsw', 'transport for nsw', 'tfnsw']
  const stalePendingFares = transactions.filter((t) => {
    if (!t.isExpense || t.amount > 2.0) return false
    const lower = t.note.toLowerCase()
    if (!transitKeywords.some((k) => lower.includes(k))) return false
    // Tightened from 7 days: Opal fares confirmed to typically finalize
    // within a day or two, not a week — 7 days left this sitting
    // unflagged for most of a week after the real fare had almost
    // certainly already posted.
    return referenceDate.getTime() - new Date(t.date).getTime() > 2 * 24 * 60 * 60 * 1000
  })
  if (stalePendingFares.length > 0) {
    findings.push({
      icon: '🚊',
      title: `${stalePendingFares.length} old pending transit fare${stalePendingFares.length === 1 ? '' : 's'}`,
      detail: 'Still showing a small placeholder amount from a couple of days ago or more — check your bank app for the real fare and update these.',
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

  // Two active recurring items with the same merchant name only matters
  // because of how matching actually works: matchingRecurringItem picks
  // the FIRST one found for any given real transaction, so a genuine
  // duplicate (the same subscription accidentally added twice) means
  // the second one can never be matched to anything — it just reserves
  // its full amount every period, forever, with no way for a real
  // charge to ever satisfy it. Surfaced here since nothing else would
  // ever explain why one subscription's reserve never clears.
  const recurringKeyGroups = new Map<string, RecurringTransaction[]>()
  for (const r of recurring) {
    if (!r.isActive) continue
    const key = `${r.isExpense}:${normalizeMerchantKey(r.note)}`
    if (!key || key === 'true:' || key === 'false:') continue
    if (!recurringKeyGroups.has(key)) recurringKeyGroups.set(key, [])
    recurringKeyGroups.get(key)!.push(r)
  }
  const duplicateRecurringNames = Array.from(recurringKeyGroups.values()).filter((group) => group.length > 1)
  if (duplicateRecurringNames.length > 0) {
    const names = duplicateRecurringNames.map((g) => g[0].note).join(', ')
    findings.push({
      icon: '👥',
      title: `${duplicateRecurringNames.length} recurring item${duplicateRecurringNames.length === 1 ? '' : 's'} listed more than once`,
      detail: `${names} — each has more than one active recurring entry with the same name. Only one can ever be matched to a real charge, so the other reserves its full amount every period without a way to clear. Worth checking whether one is a leftover duplicate.`,
      severity: 'warning',
      transactions: []
    })
  }

  const incomeInSavings = transactions.filter((t) => {
    if (t.isExpense || !t.categoryId) return false
    const cat = categories.find((c) => c.id === t.categoryId)
    // A reimbursement-linked income transaction here is a deliberate
    // "Fund from Savings" withdrawal (see TransactionEditor), not a
    // mistake — confirmed this would otherwise get flagged by this very
    // check and told to "switch to Expense," which is wrong advice that
    // would break a correctly-set-up funding link. Only an UNLINKED
    // income transaction sitting in a savings category is the real
    // pattern this warning exists to catch.
    return cat?.isSavingsCategory === true && !t.reimbursesExpenseId
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

  // Recurring annual goals (insurance, car registration) that have
  // either been fully funded or reached their target date — either way
  // it's time to renew into next year's cycle, since the bill is
  // presumably due now regardless of whether the full amount was saved.
  const goalsReadyToRenew = categories.filter((c) => {
    if (!c.isSavingsCategory || !c.goalRecurring || !c.goalTargetDate || c.goalTargetAmount <= 0) return false
    const reached = goalProgress(c, transactions) >= c.goalTargetAmount
    const dueDatePassed = new Date(c.goalTargetDate) <= referenceDate
    return reached || dueDatePassed
  })
  if (goalsReadyToRenew.length > 0) {
    findings.push({
      icon: '🔄',
      title: `${goalsReadyToRenew.length} annual goal${goalsReadyToRenew.length === 1 ? '' : 's'} ready to renew`,
      detail: goalsReadyToRenew.map((c) => c.name).join(', ') + ' — funded or due. Tap to roll each into next year\u2019s cycle (target date +1 year, progress tracking restarts fresh).',
      severity: 'info',
      transactions: [],
      renewableCategoryIds: goalsReadyToRenew.map((c) => c.id)
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
