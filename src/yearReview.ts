import type { Category, Transaction } from './types'
import {
  computeDashboardTotals, netSpentForCategory, netAmount, netSavedThisPeriod, categoryAndDescendantIds
} from './calculations'
import { periodContaining, type Period } from './budgetPeriod'
import { normalizeMerchantKey } from './merchantRules'
import { dayDiff } from './forecast'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface YearMonth {
  /** Short month name the period is filed under (the month holding its 15th). */
  label: string
  start: Date
  end: Date
  spent: number
  income: number
  saved: number
  hasData: boolean
  /** False for a period that hasn't started yet. */
  started: boolean
}

export interface YearCategoryRow {
  categoryId: string
  name: string
  icon: string
  color: string
  amount: number
  share: number
}

export interface YearMerchantRow {
  name: string
  amount: number
  count: number
}

export interface YearReview {
  year: number
  months: YearMonth[]
  income: number
  spent: number
  saved: number
  /** Income − spent − saved: what was neither spent nor set aside. */
  leftOver: number
  savingsRate: number | null
  averageMonthlySpend: number
  monthsCounted: number
  topCategories: YearCategoryRow[]
  topMerchants: YearMerchantRow[]
  biggestExpense: { note: string; amount: number; date: Date; categoryName: string } | null
  priciestMonth: YearMonth | null
  quietestMonth: YearMonth | null
  noSpendDays: number
  daysTracked: number
  transactionCount: number
  /** Spending for the same months of the year before, or null if there's nothing recorded then. */
  previousYearSpent: number | null
  rangeStart: Date
  rangeEnd: Date
}

/** The calendar years that have any transactions in them, newest first
 * (always including the current year so the screen is never empty). */
export function yearsWithData(transactions: Transaction[], now: Date): number[] {
  const years = new Set<number>([now.getFullYear()])
  for (const t of transactions) years.add(new Date(t.date).getFullYear())
  return [...years].filter((y) => y <= now.getFullYear()).sort((a, b) => b - a)
}

/** What two purchases must share to count as the same merchant. Normally
 * the app's own merchant key, but bank-transfer text ("WITHDRAWAL-OSKO
 * PAYMENT 123 J SMITH") collapses to one generic key for every payee, which
 * would merge payments to different people into a single "merchant" — so
 * those are grouped by the full cleaned wording (payee included) instead. */
export function merchantGroupKey(note: string): string {
  const key = normalizeMerchantKey(note)
  if (!key) return ''
  if (/^(withdrawalosko|osko|withdrawal|transfer|payment|direct|deposit|internet)\b/.test(key)) {
    return note.toLowerCase().replace(/[-']/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3).join(' ')
  }
  return key
}

function monthPeriods(year: number): { ref: Date; period: Period }[] {
  const out: { ref: Date; period: Period }[] = []
  for (let m = 0; m < 12; m++) {
    const ref = new Date(year, m, 15)
    out.push({ ref, period: periodContaining(ref) })
  }
  return out
}

function spentIn(categories: Category[], transactions: Transaction[], ref: Date): number {
  return computeDashboardTotals(categories, transactions, ref).spent
}

export function yearReview(categories: Category[], transactions: Transaction[], year: number, now: Date): YearReview {
  const periods = monthPeriods(year)
  const topLevel = categories.filter((c) => !c.parentId && !c.isSavingsCategory)

  const months: YearMonth[] = periods.map(({ ref, period }) => {
    const totals = computeDashboardTotals(categories, transactions, ref)
    const hasData = transactions.some((t) => {
      const d = new Date(t.date)
      return d >= period.start && d < period.end
    })
    return {
      label: MONTH_ABBR[ref.getMonth()],
      start: period.start,
      end: period.end,
      spent: totals.spent,
      income: totals.income,
      saved: netSavedThisPeriod(categories, transactions, ref),
      hasData,
      started: period.start <= now
    }
  })

  // A period that only holds stray entries (no spending, income or saving) isn't a month worth averaging over.
  const counted = months.filter((m) => m.started && m.hasData && (m.spent > 0 || m.income > 0 || m.saved !== 0))
  const income = counted.reduce((s, m) => s + m.income, 0)
  const spent = counted.reduce((s, m) => s + m.spent, 0)
  const saved = counted.reduce((s, m) => s + m.saved, 0)

  // Category totals use the same per-category, floored-at-zero rule the
  // dashboard's Spent uses, month by month, so they add back up to `spent`.
  const catTotals = new Map<string, number>()
  for (const { ref, period } of periods) {
    if (period.start > now) continue
    for (const c of topLevel) {
      const v = Math.max(0, netSpentForCategory(c, categories, transactions, ref))
      if (v > 0) catTotals.set(c.id, (catTotals.get(c.id) ?? 0) + v)
    }
  }
  const catSum = [...catTotals.values()].reduce((s, v) => s + v, 0)
  const topCategories: YearCategoryRow[] = [...catTotals.entries()]
    .map(([id, amount]) => {
      const c = categories.find((x) => x.id === id)!
      return { categoryId: id, name: c.name, icon: c.icon, color: c.color, amount, share: catSum > 0 ? amount / catSum : 0 }
    })
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6)

  const rangeStart = periods[0].period.start
  const rangeEnd = periods[11].period.end
  const spendingIds = new Set<string>()
  for (const c of topLevel) for (const id of categoryAndDescendantIds(c, categories)) spendingIds.add(id)
  const catById = new Map(categories.map((c) => [c.id, c]))

  const yearExpenses = transactions.filter((t) => {
    if (!t.isExpense || !t.categoryId || !spendingIds.has(t.categoryId)) return false
    const d = new Date(t.date)
    return d >= rangeStart && d < rangeEnd && d <= now
  })

  const merchants = new Map<string, { amount: number; count: number; names: Map<string, number> }>()
  let biggest: YearReview['biggestExpense'] = null
  for (const t of yearExpenses) {
    const net = netAmount(t, transactions)
    if (net > 0 && (!biggest || net > biggest.amount)) {
      biggest = { note: t.note || catById.get(t.categoryId!)?.name || 'Expense', amount: net, date: new Date(t.date), categoryName: catById.get(t.categoryId!)?.name ?? '' }
    }
    const key = merchantGroupKey(t.note)
    if (!key) continue
    const m = merchants.get(key) ?? { amount: 0, count: 0, names: new Map() }
    m.amount += net
    m.count += 1
    m.names.set(t.note.trim(), (m.names.get(t.note.trim()) ?? 0) + 1)
    merchants.set(key, m)
  }
  const topMerchants: YearMerchantRow[] = [...merchants.values()]
    .map((m) => ({
      name: [...m.names.entries()].sort((a, b) => b[1] - a[1])[0][0],
      amount: m.amount,
      count: m.count
    }))
    .filter((m) => m.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)

  // Days with nothing spent, over the stretch actually covered by data.
  const firstTx = transactions
    .map((t) => new Date(t.date))
    .filter((d) => d >= rangeStart && d < rangeEnd && d <= now)
    .sort((a, b) => a.getTime() - b.getTime())[0]
  let noSpendDays = 0
  let daysTracked = 0
  if (firstTx) {
    const last = now < new Date(rangeEnd.getTime() - 1) ? now : new Date(rangeEnd.getTime() - 1)
    daysTracked = dayDiff(firstTx, last) + 1
    const spendDays = new Set<number>(yearExpenses.map((t) => dayDiff(firstTx, new Date(t.date))))
    noSpendDays = Math.max(0, daysTracked - [...spendDays].filter((i) => i >= 0 && i < daysTracked).length)
  }

  const withSpend = counted.filter((m) => m.spent > 0)
  const priciestMonth = withSpend.length > 0 ? withSpend.reduce((a, b) => (b.spent > a.spent ? b : a)) : null
  // A month still in progress would always look "quietest", so only
  // finished months compete for that.
  const finished = withSpend.filter((m) => m.end <= now)
  const quietestMonth = finished.length > 1 ? finished.reduce((a, b) => (b.spent < a.spent ? b : a)) : null

  // Same months, a year earlier.
  let previousYearSpent: number | null = null
  const prevPeriods = monthPeriods(year - 1)
  let prevAny = false
  let prevSum = 0
  months.forEach((m, i) => {
    if (!counted.includes(m)) return
    const p = prevPeriods[i]
    if (transactions.some((t) => { const d = new Date(t.date); return d >= p.period.start && d < p.period.end })) prevAny = true
    prevSum += spentIn(categories, transactions, p.ref)
  })
  if (prevAny) previousYearSpent = prevSum

  return {
    year,
    months,
    income,
    spent,
    saved,
    leftOver: income - spent - saved,
    savingsRate: income > 0 ? saved / income : null,
    averageMonthlySpend: counted.length > 0 ? spent / counted.length : 0,
    monthsCounted: counted.length,
    topCategories,
    topMerchants,
    biggestExpense: biggest,
    priciestMonth,
    quietestMonth,
    noSpendDays,
    daysTracked,
    transactionCount: transactions.filter((t) => { const d = new Date(t.date); return d >= rangeStart && d < rangeEnd && d <= now }).length,
    previousYearSpent,
    rangeStart,
    rangeEnd
  }
}
