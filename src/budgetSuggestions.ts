import type { Category, Transaction } from './types'
import { goalProgress } from './calculations'

// Relative weights for spending categories, grounded in the ABS
// Household Expenditure Survey (housing ~20%, food ~17%, transport
// ~15% — together accounting for roughly half of typical household
// spending) and Finder's 2025 analysis of more recent ABS data, which
// confirms broadly the same proportions still hold (rent/dwelling the
// largest single category, recreation and dining out next). These are
// national averages, not a target — a starting point to adjust from,
// not a rule.
const SPENDING_WEIGHTS: Record<string, number> = {
  rent: 22, housing: 22, mortgage: 22,
  groceries: 17, grocery: 17,
  transport: 15, petrol: 15, fuel: 15,
  entertainment: 10, recreation: 10,
  'dining out': 9, dining: 9, restaurants: 9,
  health: 6, medical: 6,
  utilities: 5, bills: 5,
  shopping: 5, clothing: 5,
  travel: 4, holiday: 4, holidays: 4,
  other: 7
}

function weightFor(categoryName: string): number {
  const key = categoryName.toLowerCase().trim()
  return SPENDING_WEIGHTS[key] ?? 5 // reasonable default for an unrecognized category
}

export interface BudgetSuggestion {
  categoryId: string
  suggestedAmount: number
  explanation: string
}

/** How much a savings goal needs THIS month to stay on pace for its
 * target date — the actual gap divided by the actual months remaining,
 * not a generic percentage. A category with no target date just gets a
 * flat share of whatever's left in the savings pool instead. */
function monthlyContributionNeeded(category: Category, transactions: Transaction[], referenceDate: Date): number | null {
  if (!category.goalTargetDate || category.goalTargetAmount <= 0) return null
  const remaining = category.goalTargetAmount - goalProgress(category, transactions)
  if (remaining <= 0) return 0
  const target = new Date(category.goalTargetDate)
  const monthsLeft = Math.max(1, (target.getFullYear() - referenceDate.getFullYear()) * 12 + (target.getMonth() - referenceDate.getMonth()))
  return remaining / monthsLeft
}

/** Suggests a monthly budget per top-level category from a total
 * monthly income figure and a savings amount the user has chosen
 * themselves — not a fixed percentage guess, since how much someone
 * wants to set aside is a personal decision (especially with specific
 * goals like a phone or a holiday), not something to impose. Savings
 * categories with a target date get their pace-based need first;
 * anything left in the savings pool splits evenly across the rest.
 * Spending categories then split whatever's left of income after
 * savings, weighted by the ABS-grounded proportions above. */
export function suggestBudgets(categories: Category[], totalMonthlyIncome: number, savingsAmount: number, transactions: Transaction[] = [], referenceDate: Date = new Date()): BudgetSuggestion[] {
  const topLevel = categories.filter((c) => !c.parentId)
  const savingsCats = topLevel.filter((c) => c.isSavingsCategory)
  const spendingCats = topLevel.filter((c) => !c.isSavingsCategory)

  const suggestions: BudgetSuggestion[] = []

  const withPace = savingsCats.map((c) => ({ category: c, need: monthlyContributionNeeded(c, transactions, referenceDate) }))
  const paceTotal = withPace.reduce((sum, s) => sum + (s.need ?? 0), 0)
  const leftoverForUnpaced = Math.max(0, savingsAmount - paceTotal)
  const unpacedCount = withPace.filter((s) => s.need === null).length

  for (const { category, need } of withPace) {
    if (need !== null) {
      suggestions.push({
        categoryId: category.id,
        suggestedAmount: Math.round(need),
        explanation: `pace needed to reach ${category.goalTargetDate ? new Date(category.goalTargetDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : 'its target'}`
      })
    } else {
      const share = unpacedCount > 0 ? leftoverForUnpaced / unpacedCount : 0
      suggestions.push({ categoryId: category.id, suggestedAmount: Math.round(share), explanation: 'even share of remaining savings — no target date set' })
    }
  }

  const remaining = Math.max(0, totalMonthlyIncome - savingsAmount)
  const totalWeight = spendingCats.reduce((sum, c) => sum + weightFor(c.name), 0)
  for (const c of spendingCats) {
    const weight = weightFor(c.name)
    const share = totalWeight > 0 ? weight / totalWeight : 0
    suggestions.push({
      categoryId: c.id,
      suggestedAmount: Math.round(remaining * share),
      explanation: `${Math.round(share * 100)}% of what's left after savings, based on ABS average household spending patterns`
    })
  }

  return suggestions
}
