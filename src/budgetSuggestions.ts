import type { Category, Transaction, Account } from './types'
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

export interface AccountGoalSuggestion {
  accountId: string
  suggestedAmount: number
  explanation: string
}

/** How much a savings goal needs THIS month to stay on pace for its
 * target date — the actual gap divided by the actual months remaining,
 * not a generic percentage. A goal with no target date just gets a
 * flat share of whatever's left in the savings pool instead. */
function monthlyContributionNeeded(account: Account, transactions: Transaction[], referenceDate: Date): number | null {
  const target = account.goalTargetAmount ?? 0
  if (!account.goalTargetDate || target <= 0) return null
  const remaining = target - goalProgress(account, transactions, referenceDate)
  if (remaining <= 0) return 0
  const targetDate = new Date(account.goalTargetDate)
  const monthsLeft = Math.max(1, (targetDate.getFullYear() - referenceDate.getFullYear()) * 12 + (targetDate.getMonth() - referenceDate.getMonth()))
  return remaining / monthsLeft
}

/** Suggests a monthly budget per top-level category, plus a monthly
 * contribution per goal account, from a total monthly income figure
 * and a savings amount the user has chosen themselves — not a fixed
 * percentage guess, since how much someone wants to set aside is a
 * personal decision (especially with specific goals like a phone or a
 * holiday), not something to impose. Goal accounts with a target date
 * get their pace-based need first; anything left in the savings pool
 * splits evenly across the rest. Spending categories then split
 * whatever's left of income after savings, weighted by the
 * ABS-grounded proportions above. Categories no longer carry a savings
 * concept themselves, so every one of them is a spending category here
 * — the split against goal accounts happens entirely separately. */
export function suggestBudgets(categories: Category[], accounts: Account[], totalMonthlyIncome: number, savingsAmount: number, transactions: Transaction[] = [], referenceDate: Date = new Date()): { categorySuggestions: BudgetSuggestion[]; accountSuggestions: AccountGoalSuggestion[] } {
  const topLevel = categories.filter((c) => !c.parentId)
  const goalAccounts = accounts.filter((a) => (a.goalTargetAmount ?? 0) > 0)

  const accountSuggestions: AccountGoalSuggestion[] = []

  const withPace = goalAccounts.map((a) => ({ account: a, need: monthlyContributionNeeded(a, transactions, referenceDate) }))
  const paceTotal = withPace.reduce((sum, s) => sum + (s.need ?? 0), 0)
  const leftoverForUnpaced = Math.max(0, savingsAmount - paceTotal)
  const unpacedCount = withPace.filter((s) => s.need === null).length

  for (const { account, need } of withPace) {
    if (need !== null) {
      accountSuggestions.push({
        accountId: account.id,
        suggestedAmount: Math.round(need),
        explanation: `pace needed to reach ${account.goalTargetDate ? new Date(account.goalTargetDate).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }) : 'its target'}`
      })
    } else {
      const share = unpacedCount > 0 ? leftoverForUnpaced / unpacedCount : 0
      accountSuggestions.push({ accountId: account.id, suggestedAmount: Math.round(share), explanation: 'even share of remaining savings — no target date set' })
    }
  }

  const categorySuggestions: BudgetSuggestion[] = []
  const remaining = Math.max(0, totalMonthlyIncome - savingsAmount)
  const totalWeight = topLevel.reduce((sum, c) => sum + weightFor(c.name), 0)
  for (const c of topLevel) {
    const weight = weightFor(c.name)
    const share = totalWeight > 0 ? weight / totalWeight : 0
    categorySuggestions.push({
      categoryId: c.id,
      suggestedAmount: Math.round(remaining * share),
      explanation: `${Math.round(share * 100)}% of what's left after savings, based on ABS average household spending patterns`
    })
  }

  return { categorySuggestions, accountSuggestions }
}
