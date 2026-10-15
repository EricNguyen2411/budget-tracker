import type { Category, InstallmentPlan, RecurringTransaction, Transaction } from './types'
import {
  computeDashboardTotals, netAmount, totalExcessReimbursement, isUnlinkedIncome,
  categoryAndDescendantIds, matchingRecurringItem, paidOccurrencesThisPeriod, savingsCategoryIds,
  monthlyEquivalentRecurringExpenses
} from './calculations'
import { periodContaining, periodOffsetBy, type Period } from './budgetPeriod'
import { addInterval } from './recurring'
import { installmentAmounts, installmentDueDates, installmentProgress } from './installments'

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Whole local days from `a` to `b` (rounded, so a DST change inside the
 * range can't turn 17 days into 16.96 and truncate to 16). */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS)
}

function periodLengthDays(p: Period): number {
  return Math.max(1, dayDiff(p.start, p.end))
}

/** How much one transaction adds to (or, for a refund, takes off) a
 * period's Spent. Mirrors netSpentForCategory term for term — expense net
 * of genuine reimbursements, minus any excess reimbursement, minus an
 * unlinked refund filed under the category — so the daily series built
 * from it adds up to the same figure the dashboard shows. */
function spendDelta(t: Transaction, all: Transaction[]): number {
  if (t.isExpense) return netAmount(t, all) - totalExcessReimbursement(t, all)
  if (isUnlinkedIncome(t)) return -t.amount
  return 0
}

export interface DailySpend {
  /** What each day adds to Spent. Built so that adding the days up
   * reproduces the dashboard's rule exactly: each top-level category
   * counts for no less than zero, so a refund can only cancel out
   * spending in its own category, never reduce Spent below it. */
  perDay: number[]
  /** Plain net spend per day leaving out anything that matches a
   * recurring item or an installment plan — the "everyday" spending a
   * forecast can project forward from its pace, as opposed to bills
   * with known dates. */
  perDayVariable: number[]
}

export function dailySpendForPeriod(
  categories: Category[], transactions: Transaction[], period: Period, recurring: RecurringTransaction[] = []
): DailySpend {
  const days = periodLengthDays(period)
  const perDayVariable = new Array<number>(days).fill(0)
  const topLevel = categories.filter((c) => !c.parentId && !c.isSavingsCategory)
  const topOf = new Map<string, string>()
  for (const top of topLevel) for (const id of categoryAndDescendantIds(top, categories)) topOf.set(id, top.id)
  const byTop = new Map<string, number[]>()
  for (const t of transactions) {
    const top = t.categoryId ? topOf.get(t.categoryId) : undefined
    if (!top) continue
    const d = new Date(t.date)
    if (d < period.start || d >= period.end) continue
    const idx = dayDiff(period.start, d)
    if (idx < 0 || idx >= days) continue
    const delta = spendDelta(t, transactions)
    if (delta === 0) continue
    if (!byTop.has(top)) byTop.set(top, new Array<number>(days).fill(0))
    byTop.get(top)![idx] += delta
    const isBill = !!t.installmentPlanId || (t.isExpense && !!matchingRecurringItem(t, recurring))
    if (!isBill) perDayVariable[idx] += delta
  }
  const flooredTotal = new Array<number>(days).fill(0)
  for (const series of byTop.values()) {
    let run = 0
    for (let i = 0; i < days; i++) {
      run += series[i]
      flooredTotal[i] += Math.max(0, run)
    }
  }
  const perDay = flooredTotal.map((v, i) => v - (i === 0 ? 0 : flooredTotal[i - 1]))
  return { perDay, perDayVariable }
}

function cumulative(values: number[], upTo: number): number[] {
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < Math.min(values.length, upTo); i++) {
    sum += values[i]
    out.push(sum)
  }
  return out
}

/** Adds whatever the daily series can't see onto its last point, so the
 * line always ends exactly on the dashboard's Spent. The only source of a
 * gap is the dashboard flooring each category at zero (a category with
 * more refunds than spending can't reduce Spent below nothing) and any
 * transaction dated later in the period than today. */
function reconcileTo(series: number[], target: number): number[] {
  if (series.length === 0) return series
  const gap = target - series[series.length - 1]
  if (Math.abs(gap) < 0.005) return series
  const out = [...series]
  out[out.length - 1] += gap
  return out
}

export interface SpendingPace {
  periodStart: Date
  periodEnd: Date
  totalDays: number
  /** Days into the period, counting today. */
  elapsedDays: number
  /** Cumulative spend at the end of each day up to and including today. */
  current: number[]
  /** Cumulative spend across the whole previous period. */
  previous: number[]
  previousDays: number
  spentToDate: number
  previousAtSameDay: number | null
  /** Which day of the previous period that comparison point is — scaled by how far through the period we are, since periods differ in length. */
  previousComparedDay: number
  budget: number
  /** Where an even drip of the budget would be by today. */
  expectedToDate: number
  deltaVsPace: number | null
  deltaVsPrevious: number | null
}

export function spendingPace(categories: Category[], transactions: Transaction[], referenceDate: Date, recurring: RecurringTransaction[] = []): SpendingPace {
  const period = periodContaining(referenceDate)
  const totalDays = periodLengthDays(period)
  const elapsedDays = Math.min(totalDays, Math.max(1, dayDiff(period.start, referenceDate) + 1))

  const dash = computeDashboardTotals(categories, transactions, referenceDate, recurring)
  const cur = dailySpendForPeriod(categories, transactions, period, recurring)
  const current = reconcileTo(cumulative(cur.perDay, elapsedDays), dash.spent)

  const prevPeriod = periodOffsetBy(-1, referenceDate)
  const previousDays = periodLengthDays(prevPeriod)
  const prevRef = new Date(prevPeriod.start.getTime() + DAY_MS * 1.5)
  const prevDash = computeDashboardTotals(categories, transactions, prevRef, recurring)
  const prevDaily = dailySpendForPeriod(categories, transactions, prevPeriod, recurring)
  const previous = reconcileTo(cumulative(prevDaily.perDay, previousDays), prevDash.spent)

  const hasPreviousData = transactions.some((t) => {
    const d = new Date(t.date)
    return d >= prevPeriod.start && d < prevPeriod.end
  })
  // Periods differ in length (paydays move), so "same point" means the same
  // share of the way through, not the same day number: day 21 of 32 lines up
  // with about day 19 of a 29-day period.
  const previousComparedDay = Math.min(previousDays, Math.max(1, Math.round((elapsedDays / totalDays) * previousDays)))
  const previousAtSameDay = hasPreviousData && previous.length > 0
    ? previous[Math.min(previousComparedDay, previous.length) - 1]
    : null

  const budget = dash.totalBudget
  const expectedToDate = budget > 0 ? budget * (elapsedDays / totalDays) : 0
  const spentToDate = current[current.length - 1] ?? 0
  return {
    periodStart: period.start,
    periodEnd: period.end,
    totalDays,
    elapsedDays,
    current,
    previous,
    previousDays,
    spentToDate,
    previousAtSameDay,
    previousComparedDay,
    budget,
    expectedToDate,
    deltaVsPace: budget > 0 ? spentToDate - expectedToDate : null,
    deltaVsPrevious: previousAtSameDay === null ? null : spentToDate - previousAtSameDay
  }
}

export interface UpcomingBill {
  /** The recurring item's or installment plan's id. */
  id: string
  note: string
  amount: number
  date: Date
}

export interface PeriodForecast {
  /** False when there's nothing to project from (a brand-new period with no history at all). */
  available: boolean
  periodEnd: Date
  lastDay: Date
  daysLeft: number
  spentToDate: number
  /** Bills and installments with a known date still to land this period. */
  upcomingBills: UpcomingBill[]
  upcomingTotal: number
  /** Projected everyday (non-bill) spend per remaining day. */
  dailyRate: number
  rateSource: 'this-period' | 'blend' | 'last-period' | 'none'
  projectedEverydayRemaining: number
  projectedSpend: number
  budget: number
  /** Money set aside or committed to savings this period (as the dashboard counts it). */
  saved: number
  /** The monthly share still held back for recurring bills that DON'T land
   * this period (a yearly premium's 1/12th), exactly as Safe to Spend holds it. */
  reserveHeld: number
  /** Budget − projected spend − reserve held − saved: Safe to Spend as it
   * would stand on the last day. Negative means a projected overspend. */
  projectedLeftover: number
}

/** Bills with a real due date between tomorrow and the end of the period.
 * A recurring item that has already landed this period (matched by the
 * same merchant+amount rule the dashboard's reserve uses) isn't counted
 * again. Savings contributions are left out — they're in `saved`. */
export function upcomingBillsThisPeriod(
  categories: Category[], transactions: Transaction[], recurring: RecurringTransaction[],
  installmentPlans: InstallmentPlan[], referenceDate: Date
): UpcomingBill[] {
  const period = periodContaining(referenceDate)
  const today = startOfDay(referenceDate)
  const savingsIds = savingsCategoryIds(categories)
  const out: UpcomingBill[] = []

  for (const r of recurring) {
    if (!r.isActive || !r.isExpense || (r.categoryId && savingsIds.has(r.categoryId))) continue
    if ((r.frequency === 'monthly' || r.frequency === 'yearly') && paidOccurrencesThisPeriod(r, transactions, referenceDate) > 0) continue
    let d = new Date(r.nextDueDate)
    const anchor = r.anchorDay ?? d.getDate()
    let guard = 0
    while (guard++ < 60 && startOfDay(d) < period.end) {
      if (startOfDay(d) > today) out.push({ id: r.id, note: r.note, amount: r.amount, date: startOfDay(d) })
      d = addInterval(d, r.frequency, anchor)
    }
  }

  for (const plan of installmentPlans) {
    if (!plan.isActive) continue
    const progress = installmentProgress(plan, transactions)
    if (progress.isPaidOff) continue
    const dates = installmentDueDates(plan)
    const amounts = installmentAmounts(plan)
    for (let i = progress.paidCount; i < dates.length; i++) {
      const day = startOfDay(dates[i])
      if (day >= period.end) break
      if (day > today) out.push({ id: plan.id, note: `${plan.provider}: ${plan.note}`, amount: amounts[i], date: day })
    }
  }

  return out.sort((a, b) => a.date.getTime() - b.date.getTime())
}

export function periodForecast(
  categories: Category[], transactions: Transaction[], recurring: RecurringTransaction[],
  installmentPlans: InstallmentPlan[], referenceDate: Date
): PeriodForecast {
  const period = periodContaining(referenceDate)
  const totalDays = periodLengthDays(period)
  const elapsedDays = Math.min(totalDays, Math.max(1, dayDiff(period.start, referenceDate) + 1))
  const daysLeft = Math.max(0, totalDays - elapsedDays)
  const lastDay = new Date(period.end.getFullYear(), period.end.getMonth(), period.end.getDate() - 1)

  const dash = computeDashboardTotals(categories, transactions, referenceDate, recurring)
  const cur = dailySpendForPeriod(categories, transactions, period, recurring)
  const spentToDate = reconcileTo(cumulative(cur.perDay, elapsedDays), dash.spent).slice(-1)[0] ?? 0
  const variableToDate = cur.perDayVariable.slice(0, elapsedDays).reduce((s, v) => s + v, 0)

  const prevPeriod = periodOffsetBy(-1, referenceDate)
  const prevDays = periodLengthDays(prevPeriod)
  const prevDaily = dailySpendForPeriod(categories, transactions, prevPeriod, recurring)
  const prevHasData = transactions.some((t) => {
    const d = new Date(t.date)
    return d >= prevPeriod.start && d < prevPeriod.end
  })
  const prevRate = prevHasData ? Math.max(0, prevDaily.perDayVariable.reduce((s, v) => s + v, 0)) / prevDays : null
  const thisRate = Math.max(0, variableToDate) / elapsedDays

  // Early in a period a handful of days is a poor guide, so lean on last
  // period's pace and hand over to this period's own as it fills in
  // (fully by day 10).
  let dailyRate = 0
  let rateSource: PeriodForecast['rateSource'] = 'none'
  const thisHasData = transactions.some((t) => {
    const d = new Date(t.date)
    return d >= period.start && d < period.end && d < new Date(startOfDay(referenceDate).getTime() + DAY_MS)
  })
  if (prevRate === null) {
    dailyRate = thisRate
    rateSource = 'this-period'
  } else if (!thisHasData) {
    // Nothing logged yet this period isn't evidence of zero spending — fall back on last period's pace.
    dailyRate = prevRate
    rateSource = 'last-period'
  } else {
    const w = Math.min(1, elapsedDays / 10)
    dailyRate = w * thisRate + (1 - w) * prevRate
    rateSource = w >= 1 ? 'this-period' : w <= 0 ? 'last-period' : 'blend'
  }

  const upcomingBills = upcomingBillsThisPeriod(categories, transactions, recurring, installmentPlans, referenceDate)
  const upcomingTotal = upcomingBills.reduce((s, b) => s + b.amount, 0)
  const projectedEverydayRemaining = dailyRate * daysLeft
  const projectedSpend = spentToDate + upcomingTotal + projectedEverydayRemaining
  // Bills that land this period are in projectedSpend, so their share of
  // the dashboard's reserve is released; the rest stays held, like Safe to Spend.
  const landing = new Set(upcomingBills.map((b) => b.id))
  const reserveHeld = monthlyEquivalentRecurringExpenses(recurring.filter((r) => !landing.has(r.id)), transactions, referenceDate, categories)
  const available = transactions.some((t) => {
    const d = new Date(t.date)
    return (d >= period.start && d < period.end) || (prevHasData && d >= prevPeriod.start && d < prevPeriod.end)
  })

  return {
    available,
    periodEnd: period.end,
    lastDay,
    daysLeft,
    spentToDate,
    upcomingBills,
    upcomingTotal,
    dailyRate,
    rateSource,
    projectedEverydayRemaining,
    projectedSpend,
    budget: dash.totalBudget,
    saved: dash.saved,
    reserveHeld,
    projectedLeftover: dash.totalBudget - projectedSpend - reserveHeld - dash.saved
  }
}
