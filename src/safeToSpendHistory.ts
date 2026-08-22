import type { Category, Transaction, RecurringTransaction } from './types'
import { computeDashboardTotals, monthlyEquivalentRecurringExpenses, formatCurrency } from './calculations'
import { periodContaining, isInSamePeriod } from './budgetPeriod'

const STORAGE_KEY = 'budget-tracker-safe-to-spend-snapshot'

interface SnapshotTransaction {
  amount: number
  isExpense: boolean
  categoryId: string | null
  note: string
  reimbursesExpenseId: string | null
}

export interface PeriodSnapshot {
  periodKey: string
  safeToSpend: number
  totalBudget: number
  recurringReserve: number
  transactions: Record<string, SnapshotTransaction>
}

function periodKeyFor(referenceDate: Date): string {
  return periodContaining(referenceDate).start.toISOString().slice(0, 10)
}

/** Only transactions with a category actually move Safe to Spend —
 * netSpentForCategory filters by category membership, so an
 * uncategorized transaction contributes to no category's total and has
 * zero effect on the figure. Excluding them here keeps the diff focused
 * on things that could actually explain a change. */
export function computeSnapshot(categories: Category[], transactions: Transaction[], referenceDate: Date, recurring: RecurringTransaction[]): PeriodSnapshot {
  const totals = computeDashboardTotals(categories, transactions, referenceDate, recurring)
  const periodTx = transactions.filter((t) => t.categoryId && isInSamePeriod(new Date(t.date), referenceDate))
  const txMap: Record<string, SnapshotTransaction> = {}
  for (const t of periodTx) {
    txMap[t.id] = { amount: t.amount, isExpense: t.isExpense, categoryId: t.categoryId, note: t.note, reimbursesExpenseId: t.reimbursesExpenseId }
  }
  return {
    periodKey: periodKeyFor(referenceDate),
    safeToSpend: totals.safeToSpend,
    totalBudget: totals.totalBudget,
    recurringReserve: monthlyEquivalentRecurringExpenses(recurring),
    transactions: txMap
  }
}

export function loadSnapshot(): PeriodSnapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PeriodSnapshot
  } catch {
    return null
  }
}

export function saveSnapshot(snapshot: PeriodSnapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage full or unavailable — not worth surfacing an error for a
    // purely informational feature.
  }
}

export interface ChangeLine {
  icon: string
  text: string
  impact: number // signed dollars, positive = increased Safe to Spend — used for sorting by size, not claimed as an exact reconciliation (reimbursement floors and per-category clamping mean the individual lines are a best-effort explanation, not a guaranteed sum-to-total)
}

function signed(n: number): string {
  const formatted = formatCurrency(Math.abs(n))
  return n >= 0 ? `+${formatted}` : `-${formatted}`
}

function categoryName(categories: Category[], id: string | null): string {
  if (!id) return 'Uncategorized'
  return categories.find((c) => c.id === id)?.name ?? 'a since-deleted category'
}

/** Builds a human-readable "what changed since last time" list. Only
 * meaningful within the same budget period — comparing across a period
 * boundary would just report "everything is new" since the previous
 * period's transactions fall out of scope entirely, which isn't a
 * surprise worth explaining (a new period starting fresh is expected).
 */
export function diffSnapshots(prev: PeriodSnapshot, current: PeriodSnapshot, categories: Category[]): ChangeLine[] {
  if (prev.periodKey !== current.periodKey) return []
  const lines: ChangeLine[] = []
  const allIds = new Set([...Object.keys(prev.transactions), ...Object.keys(current.transactions)])

  for (const id of allIds) {
    const before = prev.transactions[id]
    const after = current.transactions[id]

    if (!before && after) {
      const impact = after.isExpense ? -after.amount : after.amount
      const label = after.reimbursesExpenseId ? 'Reimbursement' : after.isExpense ? 'New expense' : 'New income'
      const icon = after.reimbursesExpenseId ? '💸' : after.isExpense ? '➖' : '➕'
      lines.push({ icon, text: `${label}: "${after.note || categoryName(categories, after.categoryId)}" ${signed(impact)}`, impact })
    } else if (before && !after) {
      const impact = before.isExpense ? before.amount : -before.amount
      lines.push({ icon: '🗑️', text: `Removed: "${before.note || categoryName(categories, before.categoryId)}" ${signed(impact)}`, impact })
    } else if (before && after) {
      if (before.amount !== after.amount) {
        const impact = before.isExpense ? before.amount - after.amount : after.amount - before.amount
        lines.push({ icon: '✏️', text: `"${after.note || categoryName(categories, after.categoryId)}" changed: ${formatCurrency(before.amount)} → ${formatCurrency(after.amount)}`, impact })
      } else if (before.categoryId !== after.categoryId) {
        lines.push({ icon: '🔀', text: `"${after.note || 'A transaction'}" moved: ${categoryName(categories, before.categoryId)} → ${categoryName(categories, after.categoryId)}`, impact: 0 })
      } else if (before.isExpense !== after.isExpense) {
        lines.push({ icon: '🔁', text: `"${after.note || 'A transaction'}" changed from ${before.isExpense ? 'an expense' : 'income'} to ${after.isExpense ? 'an expense' : 'income'}`, impact: 0 })
      }
    }
  }

  if (prev.totalBudget !== current.totalBudget) {
    lines.push({ icon: '🎯', text: `Total budget changed: ${formatCurrency(prev.totalBudget)} → ${formatCurrency(current.totalBudget)}`, impact: current.totalBudget - prev.totalBudget })
  }
  if (prev.recurringReserve !== current.recurringReserve) {
    lines.push({ icon: '🔁', text: `Recurring bills reserve changed: ${formatCurrency(prev.recurringReserve)} → ${formatCurrency(current.recurringReserve)}`, impact: prev.recurringReserve - current.recurringReserve })
  }

  return lines.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
}
