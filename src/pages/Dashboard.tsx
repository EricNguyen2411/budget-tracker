import { useEffect, useMemo, useState } from 'react'
import type { Category, Transaction, RecurringTransaction } from '../types'
import { computeDashboardTotals, formatCurrency, daysRemainingInMonth, netSpentForCategory, effectiveBudget, isGoal, goalProgress, goalProgressFraction, projectedGoalCompletionDate, categoryBreakdown, last14DaysSpend, last6PeriodsSpend, last6PeriodsNetSavings, localDateInputValue, topMerchantsThisMonth, monthlyEquivalentRecurringExpenses, fundedFromSavingsThisPeriod } from '../calculations'
import { computeSnapshot, loadSnapshot, saveSnapshot, diffSnapshots, type ChangeLine } from '../safeToSpendHistory'
import { periodContaining, referenceDateOffsetBy, getSettings, getCycleConfig, isCustomCycle } from '../budgetPeriod'
import { generateInsights } from '../insights'
import { DonutChart, BarChart } from '../components/Charts'
import { getHiddenWidgets, getWidgetOrder, type WidgetId } from '../dashboardWidgets'
import { CameraIcon } from '../icons'
import { useModalClose } from '../useModalClose'
import { buildMonthRecap } from '../monthlyRecap'
import AnimatedProgressBar from '../components/AnimatedProgressBar'
import AnimatedNumber from '../components/AnimatedNumber'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  onOpenCategory: (id: string) => void
  onOpenStat: (kind: 'spent' | 'income' | 'reimbursed' | 'saved') => void
  onOpenDateRange: (title: string, start: string, end: string) => void
  onOpenMonthRecap: () => void
  onOpenCategoryBreakdown: () => void
  onOpenImport: (files: FileList) => void
  onOpenRecurring: () => void
}

/** Compares the last two COMPLETE periods, deliberately excluding the
 * final entry when it represents the current, still-in-progress
 * period — last6PeriodsSpend/last6PeriodsNetSavings both include the
 * current month as their last data point, and comparing an
 * in-progress month against a full one would show a misleading swing
 * purely because the month isn't over yet, not because spending
 * actually changed. */
function trendSummary(periods: { periodStart: Date; amount: number }[], noun: string, now: Date): React.ReactNode {
  if (periods.length < 2) return null
  const currentPeriod = periods[periods.length - 1]
  const previousPeriod = periods[periods.length - 2]
  if (previousPeriod.amount === 0) return null
  const pctChange = ((currentPeriod.amount - previousPeriod.amount) / Math.abs(previousPeriod.amount)) * 100
  const up = pctChange > 0
  const color = noun === 'spending' ? (up ? 'var(--red)' : 'var(--green)') : (up ? 'var(--green)' : 'var(--red)')
  const currentEnd = new Date(currentPeriod.periodStart.getFullYear(), currentPeriod.periodStart.getMonth() + 1, currentPeriod.periodStart.getDate())
  const isInProgress = now < currentEnd
  const currentLabel = currentPeriod.periodStart.toLocaleDateString('en-AU', { month: 'short' }) + (isInProgress ? ' so far' : '')
  const previousLabel = previousPeriod.periodStart.toLocaleDateString('en-AU', { month: 'short' })
  return (
    <span>
      <span style={{ color, fontWeight: 600 }}>{up ? '↑' : '↓'} {Math.abs(pctChange).toFixed(0)}%</span>
      {' '}{noun}: {currentLabel} vs {previousLabel}
    </span>
  )
}

export default function Dashboard({ categories, transactions, recurring, onOpenCategory, onOpenStat, onOpenDateRange, onOpenMonthRecap, onOpenCategoryBreakdown, onOpenImport, onOpenRecurring }: Props) {
  const now = new Date()
  const totals = useMemo(() => computeDashboardTotals(categories, transactions, now, recurring), [categories, transactions, recurring, now.toDateString()])
  const days = daysRemainingInMonth(now)
  const perDay = Math.max(0, totals.safeToSpend) / days
  const [showBreakdown, setShowBreakdown] = useState(false)
  const breakdownClose = useModalClose(() => setShowBreakdown(false))

  // "Why did this change?" — compares Safe to Spend's inputs against a
  // snapshot saved the last time this screen was open, so a number that
  // moved between visits comes with an explanation instead of just
  // silently being different. Runs once per mount (returning to this
  // tab counts as "a visit") rather than on every re-render — comparing
  // against a snapshot from a second ago would have nothing to show.
  const [changeSummary, setChangeSummary] = useState<{ lines: ChangeLine[]; totalDelta: number } | null>(null)
  const [showChanges, setShowChanges] = useState(false)
  const changesClose = useModalClose(() => setShowChanges(false))
  useEffect(() => {
    const current = computeSnapshot(categories, transactions, now, recurring)
    const prev = loadSnapshot()
    if (prev) {
      const lines = diffSnapshots(prev, current, categories)
      const totalDelta = current.safeToSpend - prev.safeToSpend
      if (lines.length > 0) {
        setChangeSummary({ lines, totalDelta })
      }
    }
    saveSnapshot(current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const topLevelForBudget = categories.filter((c) => !c.parentId)
  const totalBudget = topLevelForBudget.reduce((sum, c) => sum + effectiveBudget(c, categories), 0)
  // Spending categories only, for display — savings already gets its
  // own line below (Savings & Investments This Month), so folding it in
  // here too would show the same dollars twice even though the actual
  // Safe to Spend total underneath is unaffected either way.
  const netSpentSoFar = topLevelForBudget
    .filter((c) => !c.isSavingsCategory)
    .reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, now)), 0)
  // A sub-breakdown of what's already folded into netSpentSoFar above,
  // not a separate deduction — purely so "why is my net spend lower
  // than what I actually paid for things" has a visible answer.
  const fundedFromSavings = fundedFromSavingsThisPeriod(categories, transactions, now)
  // Prorated across the year rather than only counting what happens to
  // be due this exact month — an annual premium due in October still
  // needs a share set aside in March, otherwise it looks "free" for 11
  // months and blows the budget the one month it actually lands.
  const monthlyRecurringReserve = monthlyEquivalentRecurringExpenses(recurring, transactions, now)

  const topLevel = categories.filter((c) => !c.parentId && !c.isSavingsCategory)
  const budgetRows = topLevel
    .map((c) => ({ category: c, spent: netSpentForCategory(c, categories, transactions, now), budget: effectiveBudget(c, categories) }))
    .filter((r) => r.budget > 0)
    .sort((a, b) => b.spent / (b.budget || 1) - a.spent / (a.budget || 1))
    .slice(0, 5)

  // Due within the next 14 days, soonest first — genuinely upcoming
  // rather than already-overdue (Health Check is where overdue items
  // get flagged, so this stays focused on "what's coming"). Compared at
  // day granularity, not exact timestamp — confirmed a real bug here: a
  // due date is conventionally stored at midnight, so comparing it
  // directly against `now` (which has a real time-of-day) meant a bill
  // due "today" silently dropped out of the list the moment any time
  // had passed since midnight, even though "today" is exactly what this
  // widget should be showing.
  const UPCOMING_WINDOW_DAYS = 14
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const upcomingCutoff = new Date(todayStart.getTime() + UPCOMING_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const upcomingBills = recurring
    .filter((r) => {
      if (!r.isActive) return false
      const due = new Date(r.nextDueDate)
      const dueStart = new Date(due.getFullYear(), due.getMonth(), due.getDate())
      return dueStart >= todayStart && dueStart <= upcomingCutoff
    })
    .sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate))
    .slice(0, 5)

  const insights = useMemo(() => generateInsights(categories, transactions, now), [categories, transactions, now.toDateString()])
  const goalCategories = categories.filter((c) => !c.parentId && isGoal(c))
  // A savings category with no target amount — an ongoing pool like
  // "Travel Savings" rather than a goal with an end point — was
  // completely invisible on the dashboard before this: isGoal() (and so
  // the widget above) explicitly requires a target > 0. Confirmed via
  // testing this leaves genuinely no way to see an open-ended balance
  // anywhere on the dashboard, even though the balance itself was
  // already being tracked correctly underneath (goalProgress works
  // fine with or without a target).
  const openEndedSavingsCategories = categories.filter((c) => !c.parentId && c.isSavingsCategory && c.goalTargetAmount <= 0 && goalProgress(c, transactions) > 0)

  const pieSlices = useMemo(() => categoryBreakdown(categories, transactions, now), [categories, transactions, now.toDateString()])
  const dailySpend = useMemo(() => last14DaysSpend(transactions, categories, now), [categories, transactions, now.toDateString()])
  const monthRecap = useMemo(() => buildMonthRecap(categories, transactions, now), [categories, transactions, now.toDateString()])
  const needsWantsPct = useMemo(() => {
    if (monthRecap.income <= 0) return { needs: 0, wants: 0, saved: 0 }
    return {
      needs: (monthRecap.needsSpent / monthRecap.income) * 100,
      wants: (monthRecap.wantsSpent / monthRecap.income) * 100,
      saved: (monthRecap.totalSaved / monthRecap.income) * 100
    }
  }, [monthRecap])
  // Confirmed a real bug: "day 1 of the previous calendar month" is NOT
  // always the same period as "the previous full budget cycle" once a
  // custom cycle start day is in play — e.g. with a 25th-of-the-month
  // cycle and today being Aug 30 (in the Aug25–Sep25 cycle), the naive
  // calendar-month subtraction lands on Jul 1, which resolves to the
  // Jun25–Jul25 cycle — a whole cycle further back than intended,
  // silently understating "last month's" income by an entire pay
  // period. referenceDateOffsetBy is the cycle-aware equivalent,
  // already used correctly elsewhere (insights.ts).
  const lastMonthDate = useMemo(() => referenceDateOffsetBy(-1, now), [now.toDateString()])
  const expectedIncome = useMemo(() => computeDashboardTotals(categories, transactions, lastMonthDate).income, [categories, transactions, lastMonthDate])
  const totalAllocated = useMemo(() => categories.filter((c) => !c.parentId).reduce((sum, c) => sum + effectiveBudget(c, categories), 0), [categories])
  const unallocated = expectedIncome - totalAllocated
  const cycleSettings = useMemo(() => getSettings(), [])
  const currentPeriodForLabel = useMemo(() => periodContaining(now, getCycleConfig()), [now.toDateString()])
  // A plain "August 2026" label is misleading once a custom cycle start
  // day means the reviewed window doesn't actually align with a
  // calendar month (it might be mostly late-July, for instance) — shown
  // as an explicit date range instead whenever that's the case, same
  // pattern as Spending by Category.
  const monthRecapLabel = isCustomCycle(cycleSettings)
    ? `${currentPeriodForLabel.start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – ${new Date(currentPeriodForLabel.end.getTime() - 86400000).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : now.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
  const monthlyTrend = useMemo(() => last6PeriodsSpend(categories, transactions, now), [categories, transactions, now.toDateString()])
  const netSavingsTrend = useMemo(() => last6PeriodsNetSavings(categories, transactions, now), [categories, transactions, now.toDateString()])
  const hidden = getHiddenWidgets()
  const topMerchants = useMemo(() => topMerchantsThisMonth(transactions, categories, now), [categories, transactions, now.toDateString()])

  return (
    <div className="screen">
      <div className="screen-header-row" style={{ marginBottom: 4 }}>
        <h1 className="screen-title" style={{ margin: 0 }}>Dashboard</h1>
        <label className="dashboard-import-btn" aria-label="Import statement from photo">
          <CameraIcon />
          <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => { if (e.target.files && e.target.files.length > 0) onOpenImport(e.target.files) }} />
        </label>
      </div>

      {changeSummary && (
        <button
          onClick={() => setShowChanges(true)}
          style={{
            width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '10px 14px', borderRadius: 10, background: 'var(--surface-2)', marginBottom: 12, fontSize: 13
          }}
        >
          <span>
            Safe to Spend {changeSummary.totalDelta >= 0 ? 'went up' : 'went down'} by{' '}
            <strong style={{ color: changeSummary.totalDelta >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {formatCurrency(Math.abs(changeSummary.totalDelta))}
            </strong>{' '}
            since you were last here
          </span>
          <span style={{ color: 'var(--blue)', fontWeight: 600, flexShrink: 0, marginLeft: 8 }}>Why?</span>
        </button>
      )}

      <div className="card hero-card">
        <span className="hero-label">Safe to Spend</span>
        <span className="hero-amount amount"><AnimatedNumber value={totals.safeToSpend} format={formatCurrency} /></span>
        <span className="hero-sub">{formatCurrency(perDay)}/day for {days} more day{days === 1 ? '' : 's'} this month</span>
        <button style={{ color: 'var(--blue)', fontSize: 13, marginTop: 8 }} onClick={() => setShowBreakdown(true)}>How is this calculated?</button>
      </div>

      {showBreakdown && (
        <div className={`modal-backdrop${breakdownClose.closing ? ' modal-closing' : ''}`} onClick={() => breakdownClose.requestClose()}>
          <div className={`modal-sheet${breakdownClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">How Safe to Spend Works</span>
              <button className="text-button text-button-primary" onClick={() => breakdownClose.requestClose()}>Done</button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14 }}>Monthly Budget</span>
                <span className="amount">{formatCurrency(totalBudget)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14 }}>Net Spend So Far</span>
                <span className="amount" style={{ color: 'var(--red)' }}>−{formatCurrency(netSpentSoFar)}</span>
              </div>
              {fundedFromSavings > 0 && (
                <div style={{ padding: '4px 0 10px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-dim)', paddingLeft: 14 }}>↳ includes {formatCurrency(fundedFromSavings)} funded from savings</span>
                  </div>
                  <p className="hint" style={{ marginTop: 4, paddingLeft: 14 }}>Not new spending — money already set aside in an earlier period, so it doesn't reduce Safe to Spend a second time.</p>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 14 }}>Savings & Investments This Month</span>
                <span className="amount" style={{ color: 'var(--indigo)' }}>{formatCurrency(totals.saved)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0' }}>
                <span style={{ fontSize: 14, minWidth: 0 }}>Recurring & Subscriptions (Monthly Reserve)</span>
                <span className="amount" style={{ color: 'var(--red)', flexShrink: 0 }}>−{formatCurrency(monthlyRecurringReserve)}</span>
              </div>
              <p className="hint" style={{ marginTop: 4 }}>Yearly and weekly recurring items are prorated to a monthly share here (an annual premium becomes 1/12th), reserved year-round rather than only in the month it's actually due — so Safe to Spend already has it set aside.</p>
              <p className="hint" style={{ marginTop: 12 }}>
                Safe to Spend is Monthly Budget minus Net Spend So Far minus Savings & Investments minus the Recurring & Subscriptions reserve — four separate deductions, each shown as its own line below rather than folded into another, so nothing is counted twice. Savings contributions reduce it because money set aside isn't available to spend on anything else; yearly recurring items (an annual insurance premium) are prorated into a monthly share so they're reserved for year-round, not just the month they're actually due.
              </p>
            </div>
          </div>
        </div>
      )}

      {showChanges && changeSummary && (
        <div className={`modal-backdrop${changesClose.closing ? ' modal-closing' : ''}`} onClick={() => changesClose.requestClose()}>
          <div className={`modal-sheet${changesClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">What Changed</span>
              <button className="text-button text-button-primary" onClick={() => changesClose.requestClose()}>Done</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 14 }}>
                Since you were last here, Safe to Spend {changeSummary.totalDelta >= 0 ? 'increased' : 'decreased'} by{' '}
                <strong style={{ color: changeSummary.totalDelta >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatCurrency(Math.abs(changeSummary.totalDelta))}</strong>.
                Here's what changed — the biggest contributors first:
              </p>
              {changeSummary.lines.slice(0, 8).map((line, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderBottom: i < Math.min(changeSummary.lines.length, 8) - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ fontSize: 16, flexShrink: 0 }}>{line.icon}</span>
                  <span style={{ fontSize: 13.5, flex: 1 }}>{line.text}</span>
                </div>
              ))}
              {changeSummary.lines.length > 8 && (
                <p className="hint" style={{ marginTop: 8 }}>+ {changeSummary.lines.length - 8} more change{changeSummary.lines.length - 8 === 1 ? '' : 's'}.</p>
              )}
              <p className="hint" style={{ marginTop: 12 }}>
                Individual amounts here are each change's own effect — with reimbursements and category budgets interacting, they're a best-effort explanation rather than a figure guaranteed to add up exactly to the total above.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(255, 69, 58, 0.08)', borderColor: 'rgba(255, 69, 58, 0.18)' }} onClick={() => onOpenStat('spent')}>
          <span className="stat-label">Spent</span>
          <span className="stat-value amount" style={{ color: 'var(--red)' }}><AnimatedNumber value={totals.spent} format={formatCurrency} /></span>
        </button>
        <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(48, 209, 88, 0.08)', borderColor: 'rgba(48, 209, 88, 0.18)' }} onClick={() => onOpenStat('income')}>
          <span className="stat-label">Income</span>
          <span className="stat-value amount" style={{ color: 'var(--green)' }}><AnimatedNumber value={totals.income} format={formatCurrency} /></span>
        </button>
        <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(100, 210, 255, 0.08)', borderColor: 'rgba(100, 210, 255, 0.18)' }} onClick={() => onOpenStat('reimbursed')}>
          <span className="stat-label">Reimbursed</span>
          <span className="stat-value amount" style={{ color: 'var(--teal)' }}><AnimatedNumber value={totals.reimbursed} format={formatCurrency} /></span>
        </button>
        {totals.saved > 0 && (
          <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(94, 92, 230, 0.08)', borderColor: 'rgba(94, 92, 230, 0.18)' }} onClick={() => onOpenStat('saved')}>
            <span className="stat-label">Saved</span>
            <span className="stat-value amount" style={{ color: 'var(--indigo)' }}><AnimatedNumber value={totals.saved} format={formatCurrency} /></span>
          </button>
        )}
      </div>

      {(() => {
        const widgetElements: Partial<Record<WidgetId, React.ReactNode>> = {
          insights: insights.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 10px' }}>✨ Insights</span>
              {insights.map((insight, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: i > 0 ? 10 : 0 }}>
                  <span>{insight.icon}</span>
                  <span style={{ fontSize: 13, lineHeight: 1.4 }}>{insight.text}</span>
                </div>
              ))}
            </div>
          ),

          goals: (goalCategories.length > 0 || openEndedSavingsCategories.length > 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 10px' }}>🎯 Savings Goals</span>
              {goalCategories.map((c) => {
                const fraction = goalProgressFraction(c, transactions)
                const progress = goalProgress(c, transactions)
                const projected = fraction < 1 ? projectedGoalCompletionDate(c, transactions, now) : null
                return (
                  <button key={c.id} style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 12 }} onClick={() => onOpenCategory(c.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                      <span>{c.icon} {c.name}</span>
                      <span style={{ color: fraction >= 1 ? 'var(--green)' : 'var(--text-dim)' }}>
                        {fraction >= 1 ? 'Reached!' : `${Math.round(fraction * 100)}%`}
                      </span>
                    </div>
                    <AnimatedProgressBar fraction={fraction} color={fraction >= 1 ? 'var(--green)' : c.color} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
                      <span className="amount">{formatCurrency(progress)} of {formatCurrency(c.goalTargetAmount)}</span>
                      {projected && <span>~{projected.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</span>}
                    </div>
                  </button>
                )
              })}
              {openEndedSavingsCategories.map((c) => {
                const balance = goalProgress(c, transactions)
                return (
                  <button key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', textAlign: 'left', marginTop: 12 }} onClick={() => onOpenCategory(c.id)}>
                    <span style={{ fontSize: 13 }}>{c.icon} {c.name}</span>
                    <span className="amount" style={{ fontSize: 15, fontWeight: 600 }}>{formatCurrency(balance)} saved</span>
                  </button>
                )
              })}
            </div>
          ),

          budgetVsActual: budgetRows.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading">Budget vs Actual</span>
              {budgetRows.map(({ category, spent, budget }) => {
                const fraction = Math.min(1, spent / budget)
                const over = spent > budget
                return (
                  <button key={category.id} style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 12 }} onClick={() => onOpenCategory(category.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                      <span>{category.icon} {category.name}</span>
                      <span className="amount" style={{ color: 'var(--text-dim)' }}>{formatCurrency(spent)} / {formatCurrency(budget)}</span>
                    </div>
                    <AnimatedProgressBar fraction={fraction} color={over ? 'var(--red)' : category.color} />
                  </button>
                )
              })}
            </div>
          ),

          categoryPie: pieSlices.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Spending by Category</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                <button onClick={onOpenCategoryBreakdown} style={{ flexShrink: 0 }}>
                  <DonutChart slices={pieSlices.map((s) => ({ label: s.name, value: s.amount, color: s.color }))} />
                </button>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {pieSlices.slice(0, 6).map((s) => (
                    <button key={s.categoryId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, width: '100%', textAlign: 'left' }} onClick={() => onOpenCategory(s.categoryId)}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
                      <span className="amount" style={{ color: 'var(--text-dim)' }}>{formatCurrency(s.amount)}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ),

          monthRecap: monthRecap.income > 0 && (
            <button className="card" style={{ marginTop: 16, display: 'block', width: '100%', textAlign: 'left' }} onClick={onOpenMonthRecap}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span className="section-heading" style={{ margin: 0 }}>Month in Review — {monthRecapLabel}</span>
                <span className="chevron">›</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Needs</div>
                  <div className="amount" style={{ fontSize: 15 }}>{formatCurrency(monthRecap.needsSpent)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Wants</div>
                  <div className="amount" style={{ fontSize: 15 }}>{formatCurrency(monthRecap.wantsSpent)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Saved</div>
                  <div className="amount" style={{ fontSize: 15, color: 'var(--indigo)' }}>{formatCurrency(monthRecap.totalSaved)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Net</div>
                  <div className="amount" style={{ fontSize: 15, color: (monthRecap.income - monthRecap.totalSaved - monthRecap.needsSpent - monthRecap.wantsSpent) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {formatCurrency(monthRecap.income - monthRecap.totalSaved - monthRecap.needsSpent - monthRecap.wantsSpent)}
                  </div>
                </div>
              </div>
              {monthRecap.suggestions[0] && (
                <p className="hint" style={{ margin: 0 }}>💡 {monthRecap.suggestions[0]}</p>
              )}
            </button>
          ),

          needsWantsRatio: monthRecap.income > 0 && (needsWantsPct.needs + needsWantsPct.wants + needsWantsPct.saved > 0) && (
            <button className="card" style={{ marginTop: 16, display: 'block', width: '100%', textAlign: 'left' }} onClick={onOpenMonthRecap}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <span className="section-heading" style={{ margin: 0 }}>Needs vs Wants</span>
                <span className="chevron">›</span>
              </div>
              <div style={{ display: 'flex', width: '100%', height: 10, borderRadius: 5, overflow: 'hidden', background: 'var(--surface-2)' }}>
                {needsWantsPct.needs > 0 && <div style={{ width: `${needsWantsPct.needs}%`, background: 'var(--blue)' }} />}
                {needsWantsPct.wants > 0 && <div style={{ width: `${needsWantsPct.wants}%`, background: 'var(--purple)' }} />}
                {needsWantsPct.saved > 0 && <div style={{ width: `${needsWantsPct.saved}%`, background: 'var(--indigo)' }} />}
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12 }}>
                <span><span style={{ color: 'var(--blue)' }}>●</span> Needs {Math.round(needsWantsPct.needs)}% <span style={{ color: 'var(--text-faint)' }}>(~50% guide)</span></span>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 12 }}>
                <span><span style={{ color: 'var(--purple)' }}>●</span> Wants {Math.round(needsWantsPct.wants)}% <span style={{ color: 'var(--text-faint)' }}>(~30% guide)</span></span>
              </div>
              <div style={{ display: 'flex', gap: 16, marginTop: 4, fontSize: 12 }}>
                <span><span style={{ color: 'var(--indigo)' }}>●</span> Saved {Math.round(needsWantsPct.saved)}% <span style={{ color: 'var(--text-faint)' }}>(~20% guide)</span></span>
              </div>
            </button>
          ),

          upcomingBills: upcomingBills.length > 0 && (
            <button className="card" style={{ marginTop: 16, display: 'block', width: '100%', textAlign: 'left' }} onClick={onOpenRecurring}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span className="section-heading" style={{ margin: 0 }}>Upcoming Bills</span>
                <span className="chevron">›</span>
              </div>
              {upcomingBills.map((r) => {
                const cat = r.categoryId ? categories.find((c) => c.id === r.categoryId) : null
                const due = new Date(r.nextDueDate)
                const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate())
                const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
                const daysUntil = Math.round((dueDay.getTime() - nowDay.getTime()) / (24 * 60 * 60 * 1000))
                const whenLabel = daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `in ${daysUntil} days`
                return (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                    <div className="tx-icon" style={{ width: 30, height: 30, background: (cat?.color ?? '#5C6167') + '33', flexShrink: 0 }}>{cat?.icon ?? '🔁'}</div>
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.note}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{whenLabel}</div>
                    </div>
                    <span className="amount" style={{ fontSize: 13 }}>{formatCurrency(r.amount)}</span>
                  </div>
                )
              })}
            </button>
          ),

          unallocatedFunds: expectedIncome > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <span className="section-heading" style={{ margin: 0 }}>Unallocated Funds</span>
              </div>
              <div className="hero-amount amount" style={{ fontSize: 26, color: unallocated < 0 ? 'var(--red)' : unallocated === 0 ? 'var(--green)' : 'var(--text)' }}>
                {formatCurrency(Math.abs(unallocated))}
              </div>
              <p className="hint" style={{ marginTop: 4, marginBottom: 0 }}>
                {unallocated > 0 && `Of ~${formatCurrency(expectedIncome)} expected this month, this much isn't assigned to any budget or savings category yet — give it a job, even if that's just adding it to savings.`}
                {unallocated === 0 && `Every dollar of your ~${formatCurrency(expectedIncome)} expected income is assigned to a category. That's zero-based budgeting.`}
                {unallocated < 0 && `Categories are budgeted for ${formatCurrency(totalAllocated)} total — more than the ~${formatCurrency(expectedIncome)} expected this month. Worth trimming something back.`}
              </p>
            </div>
          ),

          last14Days: dailySpend.some((d) => d.amount > 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Last 14 Days</span>
              <BarChart
                data={dailySpend.map((d) => ({
                  label: d.date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }),
                  axisLabel: d.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric' }),
                  value: d.amount,
                  onSelect: () => onOpenDateRange(d.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }), localDateInputValue(d.date), localDateInputValue(d.date))
                }))}
                height={100}
                preferredStep={200}
                defaultSummary={`Averaging ${formatCurrency(dailySpend.reduce((s, d) => s + d.amount, 0) / dailySpend.length)}/day`}
              />
            </div>
          ),

          monthlyTrend: monthlyTrend.some((d) => d.amount > 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Monthly Trend</span>
              <BarChart
                data={monthlyTrend.map((d) => {
                  const monthEnd = new Date(d.periodStart.getFullYear(), d.periodStart.getMonth() + 1, d.periodStart.getDate() - 1)
                  return {
                    label: d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
                    axisLabel: d.periodStart.toLocaleDateString('en-AU', { month: 'short' }),
                    value: d.amount,
                    onSelect: () => onOpenDateRange(d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }), localDateInputValue(d.periodStart), localDateInputValue(monthEnd))
                  }
                })}
                height={100}
                preferredStep={2000}
                defaultSummary={trendSummary(monthlyTrend, 'spending', now)}
              />
            </div>
          ),

          netSavingsTrend: netSavingsTrend.some((d) => d.amount !== 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Net Savings Trend</span>
              <BarChart
                data={netSavingsTrend.map((d) => {
                  const monthEnd = new Date(d.periodStart.getFullYear(), d.periodStart.getMonth() + 1, d.periodStart.getDate() - 1)
                  return {
                    label: d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
                    axisLabel: d.periodStart.toLocaleDateString('en-AU', { month: 'short' }),
                    value: d.amount,
                    onSelect: () => onOpenDateRange(d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }), localDateInputValue(d.periodStart), localDateInputValue(monthEnd))
                  }
                })}
                height={100}
                preferredStep={2000}
                defaultSummary={trendSummary(netSavingsTrend, 'net savings', now)}
              />
            </div>
          ),

          topMerchants: topMerchants.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Top Merchants This Month</span>
              {topMerchants.map((m, i) => (
                <div key={m.note} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                  <span style={{ color: 'var(--text-faint)', fontSize: 13, width: 16 }}>{i + 1}</span>
                  <span style={{ flex: 1, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.note}</span>
                  <span className="amount" style={{ color: 'var(--text-dim)' }}>{formatCurrency(m.amount)}</span>
                </div>
              ))}
            </div>
          )
        }

        return getWidgetOrder()
          .filter((id) => !hidden.has(id) && widgetElements[id])
          .map((id) => <div key={id}>{widgetElements[id]}</div>)
      })()}
    </div>
  )
}
