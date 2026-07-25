import type { Category } from './types'

// Savings gets a flat share of the total first, then remaining spending
// categories split the rest proportionally by these relative weights —
// not percentages of the total, weights against whatever's left after
// savings. Matches the native app's "pay yourself first" ordering.
const SAVINGS_SHARE_OF_TOTAL = 0.15

const SPENDING_WEIGHTS: Record<string, number> = {
  rent: 28, housing: 28, mortgage: 28,
  groceries: 10,
  'dining out': 5, dining: 5,
  transport: 10,
  utilities: 6,
  entertainment: 4,
  shopping: 4,
  health: 4,
  travel: 3,
  other: 5
}

function weightFor(categoryName: string): number {
  const key = categoryName.toLowerCase().trim()
  return SPENDING_WEIGHTS[key] ?? 3 // reasonable default for an unrecognized category
}

export interface BudgetSuggestion {
  categoryId: string
  suggestedAmount: number
  explanation: string
}

/** Suggests a monthly budget per top-level category from a total monthly
 * income figure — savings categories get a flat share of the total
 * first, then spending categories split what's left proportionally by
 * their relative weight, not equally. */
export function suggestBudgets(categories: Category[], totalMonthlyIncome: number): BudgetSuggestion[] {
  const topLevel = categories.filter((c) => !c.parentId)
  const savingsCats = topLevel.filter((c) => c.isSavingsCategory)
  const spendingCats = topLevel.filter((c) => !c.isSavingsCategory)

  const suggestions: BudgetSuggestion[] = []

  const savingsTotal = totalMonthlyIncome * SAVINGS_SHARE_OF_TOTAL
  const perSavingsCategory = savingsCats.length > 0 ? savingsTotal / savingsCats.length : 0
  for (const c of savingsCats) {
    suggestions.push({
      categoryId: c.id,
      suggestedAmount: Math.round(perSavingsCategory),
      explanation: `${Math.round((SAVINGS_SHARE_OF_TOTAL / savingsCats.length) * 100)}% of total income`
    })
  }

  const remaining = totalMonthlyIncome - savingsTotal
  const totalWeight = spendingCats.reduce((sum, c) => sum + weightFor(c.name), 0)
  for (const c of spendingCats) {
    const weight = weightFor(c.name)
    const share = totalWeight > 0 ? weight / totalWeight : 0
    suggestions.push({
      categoryId: c.id,
      suggestedAmount: Math.round(remaining * share),
      explanation: `${Math.round(share * 100)}% of what's left after savings`
    })
  }

  return suggestions
}
