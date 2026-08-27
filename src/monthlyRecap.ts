import type { Category, Transaction } from './types'
import {
  netSpentForCategory, effectiveBudget, computeDashboardTotals, formatCurrency,
  goalProgress, goalProgressFraction, projectedGoalCompletionDate, netAmount, totalExcessReimbursement
} from './calculations'
import { isInSamePeriod } from './budgetPeriod'

// Needs vs wants, per MoneySmart (ASIC)'s own categorization within the
// 50/30/20 framework: housing, food, utilities, transport and essential
// insurance are needs; dining out, entertainment, hobbies and
// discretionary shopping are wants. `needWantType` is now a required
// field on every non-savings category (enforced in the category
// editor), so the keyword guess below only ever matters for a category
// that existed before that was required and hasn't been re-saved since.
const NEED_KEYWORDS = ['rent', 'mortgage', 'housing', 'groceries', 'grocery', 'utilities', 'utility', 'transport', 'health', 'medical', 'insurance', 'bills', 'phone', 'internet']
const WANT_KEYWORDS = ['dining', 'restaurant', 'entertainment', 'shopping', 'hobbies', 'hobby', 'subscriptions', 'games', 'travel', 'holiday', 'fun', 'leisure']

/** A category's own need/want classification — checked on the category
 * ITSELF first (what actually matters, now that every spending category
 * is required to have one set), then its parent's (covers a
 * subcategory that predates the requirement and hasn't been individually
 * set yet), then finally a keyword guess from the name as a last resort. */
export function classify(category: Category, allCategories: Category[] = []): 'need' | 'want' | 'unknown' {
  if (category.needWantType) return category.needWantType
  if (category.parentId) {
    const parent = allCategories.find((c) => c.id === category.parentId)
    if (parent?.needWantType) return parent.needWantType
  }
  const name = category.name.toLowerCase()
  if (NEED_KEYWORDS.some((k) => name.includes(k))) return 'need'
  if (WANT_KEYWORDS.some((k) => name.includes(k))) return 'want'
  return 'unknown'
}

export function isLeaf(category: Category, allCategories: Category[]): boolean {
  return !allCategories.some((c) => c.parentId === category.id)
}

/** True for a savings/investment category, or a subcategory of one —
 * need/want doesn't mean anything for money being set aside rather than
 * spent, so these are excluded from the 50/30/20 split entirely
 * (matching how top-level savings categories were already excluded). */
export function isSavingsOrChildOfSavings(category: Category, allCategories: Category[]): boolean {
  if (category.isSavingsCategory) return true
  if (!category.parentId) return false
  const parent = allCategories.find((c) => c.id === category.parentId)
  return parent?.isSavingsCategory ?? false
}

/** A category's OWN spend only — unlike netSpentForCategory, does NOT
 * roll up subcategories. Needed because a parent category can have
 * transactions categorized directly to IT (not any specific
 * subcategory) alongside subcategories that have their own,
 * potentially different, classification — confirmed directly: using
 * netSpentForCategory (which rolls up) on only "leaf" categories was
 * silently dropping a parent's own direct spend entirely, since a
 * parent with children isn't a leaf. Summing this across EVERY
 * category (leaf or not) exactly reconstructs total spend with no
 * double-counting, since every transaction belongs to exactly one
 * category. */
export function directSpentForCategory(category: Category, transactions: Transaction[], referenceDate: Date): number {
  const relevant = transactions.filter((t) => t.categoryId === category.id && isInSamePeriod(new Date(t.date), referenceDate))
  const expenses = relevant.filter((t) => t.isExpense).reduce((sum, t) => sum + netAmount(t, transactions), 0)
  const excess = relevant.filter((t) => t.isExpense).reduce((sum, t) => sum + totalExcessReimbursement(t, transactions), 0)
  const unlinkedIncome = relevant.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)
  return expenses - excess - unlinkedIncome
}

export interface CategoryRecapRow {
  categoryId: string
  name: string
  icon: string
  spent: number
  budget: number
  classification: 'need' | 'want' | 'unknown'
}

export interface GoalRecapRow {
  categoryId: string
  name: string
  icon: string
  progress: number
  target: number
  fraction: number
  onTrack: boolean | null // null if no target date set, so pace can't be judged
}

export interface MonthRecap {
  income: number
  totalSpent: number
  totalSaved: number
  needsSpent: number
  wantsSpent: number
  needsPct: number
  wantsPct: number
  savedPct: number
  categories: CategoryRecapRow[]
  goals: GoalRecapRow[]
  suggestions: string[]
}

export function buildMonthRecap(categories: Category[], transactions: Transaction[], referenceDate: Date = new Date()): MonthRecap {
  const totals = computeDashboardTotals(categories, transactions, referenceDate)
  const topLevel = categories.filter((c) => !c.parentId)
  const spendingCats = topLevel.filter((c) => !c.isSavingsCategory)
  const savingsCats = topLevel.filter((c) => c.isSavingsCategory)

  const categoryRows: CategoryRecapRow[] = spendingCats
    .map((c) => ({
      categoryId: c.id,
      name: c.name,
      icon: c.icon,
      spent: Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)),
      budget: effectiveBudget(c, categories),
      classification: classify(c, categories)
    }))
    .filter((r) => r.spent > 0 || r.budget > 0)

  // Computed separately from the display rows above, at the level of
  // EACH category's own direct spend (not "leaf" categories, and not
  // netSpentForCategory's rollup) — confirmed directly this matters: a
  // parent with subcategories can also have transactions categorized
  // straight to IT, and those need counting under the PARENT's own
  // classification even while a differently-classified subcategory's
  // spend counts separately under its own. Summing every category's own
  // direct spend this way has no double-counting (each transaction
  // belongs to exactly one category) and is what makes a subcategory's
  // own Need/Want setting actually matter instead of being silently
  // governed by its parent.
  const classifiable = categories.filter((c) => !isSavingsOrChildOfSavings(c, categories))
  const needsSpent = classifiable
    .filter((c) => classify(c, categories) === 'need')
    .reduce((s, c) => s + Math.max(0, directSpentForCategory(c, transactions, referenceDate)), 0)
  const wantsSpent = classifiable
    .filter((c) => classify(c, categories) === 'want')
    .reduce((s, c) => s + Math.max(0, directSpentForCategory(c, transactions, referenceDate)), 0)
  // Unclassified categories aren't forced into either bucket — better to
  // leave the split honestly incomplete than silently miscategorize
  // spending into the wrong benchmark.

  const income = totals.income
  const needsPct = income > 0 ? needsSpent / income : 0
  const wantsPct = income > 0 ? wantsSpent / income : 0
  const savedPct = income > 0 ? totals.saved / income : 0

  const goalRows: GoalRecapRow[] = savingsCats
    .filter((c) => c.goalTargetAmount > 0)
    .map((c) => {
      const progress = goalProgress(c, transactions)
      const fraction = goalProgressFraction(c, transactions)
      let onTrack: boolean | null = null
      if (c.goalTargetDate) {
        const projected = projectedGoalCompletionDate(c, transactions, referenceDate)
        onTrack = projected ? projected <= new Date(c.goalTargetDate) : null
      }
      return { categoryId: c.id, name: c.name, icon: c.icon, progress, target: c.goalTargetAmount, fraction, onTrack }
    })

  const suggestions = buildSuggestions({ needsPct, wantsPct, savedPct, categoryRows, goalRows, income })

  return {
    income,
    totalSpent: totals.spent,
    totalSaved: totals.saved,
    needsSpent,
    wantsSpent,
    needsPct,
    wantsPct,
    savedPct,
    categories: categoryRows.sort((a, b) => b.spent - a.spent),
    goals: goalRows,
    suggestions
  }
}

function buildSuggestions(args: {
  needsPct: number
  wantsPct: number
  savedPct: number
  categoryRows: CategoryRecapRow[]
  goalRows: GoalRecapRow[]
  income: number
}): string[] {
  const { needsPct, wantsPct, savedPct, categoryRows, goalRows, income } = args
  const suggestions: string[] = []
  if (income <= 0) return suggestions

  // The 50/30/20 split (needs/wants/savings), the framework MoneySmart
  // (ASIC) itself recommends as a starting point — with the Sydney/
  // Melbourne-specific caveat that housing commonly pushes needs well
  // past 50% here, in which case the adjustment should come from wants,
  // never from cutting savings to zero.
  if (wantsPct > 0.35) {
    const overBudgetWants = categoryRows
      .filter((r) => r.classification === 'want' && r.budget > 0 && r.spent > r.budget)
      .sort((a, b) => (b.spent - b.budget) - (a.spent - a.budget))
    const worst = overBudgetWants[0]
    suggestions.push(
      worst
        ? `Discretionary spending ("wants") was ${Math.round(wantsPct * 100)}% of income this month — above the ~30% guideline. ${worst.name} ran ${formatCurrency(worst.spent - worst.budget)} over its budget and is the single biggest place to pull back, rather than reducing savings.`
        : `Discretionary spending ("wants") was ${Math.round(wantsPct * 100)}% of income this month — above the ~30% guideline. Worth trimming a discretionary category next month rather than reducing savings, which does more long-term work.`
    )
  }

  if (Math.round(needsPct * 100) > 50 && wantsPct <= 0.35) {
    suggestions.push(
      `Essential spending ("needs") was ${Math.round(needsPct * 100)}% of income — above the textbook 50%, though this is common in Sydney specifically once rent is factored in, and isn't necessarily a problem on its own if it's mostly housing.`
    )
  }

  if (savedPct < 0.1) {
    suggestions.push(`Saved ${Math.round(savedPct * 100)}% of income this month, below the ~20% guideline. If a want category has room, redirecting even a small amount there compounds meaningfully toward your goals over time.`)
  } else if (savedPct >= 0.2) {
    suggestions.push(`Saved ${Math.round(savedPct * 100)}% of income this month — at or above the 20% guideline. Strong month.`)
  }

  for (const g of goalRows) {
    if (g.fraction >= 1) continue
    if (g.onTrack === false) {
      suggestions.push(`${g.name} is currently behind pace for its target date — consider bumping the monthly contribution, or adjusting the target date to match a realistic pace.`)
    }
  }

  const consistentlyOver = categoryRows.filter((r) => r.budget > 0 && r.spent > r.budget * 1.15)
  for (const r of consistentlyOver.slice(0, 2)) {
    suggestions.push(`${r.name} ran ${formatCurrency(r.spent - r.budget)} over its ${formatCurrency(r.budget)} budget. If this happens most months, the budget itself may be set too low rather than spending being the problem — worth raising it to match reality rather than feeling behind every month.`)
  }

  return suggestions.slice(0, 5)
}
