import { useMemo, useState } from 'react'
import type { Category, Transaction, RecurringTransaction } from '../types'
import { computeDashboardTotals, formatCurrency, daysRemainingInMonth, netSpentForCategory, effectiveBudget, isGoal, goalProgress, goalProgressFraction, projectedGoalCompletionDate, categoryBreakdown, last14DaysSpend, last6PeriodsSpend, last6PeriodsNetSavings, localDateInputValue, topMerchantsThisMonth, monthlyEquivalentRecurringExpenses } from '../calculations'
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

export default function Dashboard({ categories, transactions, recurring, onOpenCategory, onOpenStat, onOpenDateRange, onOpenMonthRecap, onOpenCategoryBreakdown, onOpenImport }: Props) {
  const now = new Date()
  const totals = useMemo(() => computeDashboardTotals(categories, transactions, now, recurring), [categories, transactions, recurring, now.toDateString()])
  const days = daysRemainingInMonth(now)
  const perDay = Math.max(0, totals.safeToSpend) / days
  const [showBreakdown, setShowBreakdown] = useState(false)
  const breakdownClose = useModalClose(() => setShowBreakdown(false))

  const topLevelForBudget = categories.filter((c) => !c.parentId)
  const totalBudget = topLevelForBudget.reduce((sum, c) => sum + effectiveBudget(c, categories), 0)
  // Spending categories only, for display — savings already gets its
  // own line below (Savings & Investments This Month), so folding it in
  // here too would show the same dollars twice even though the actual
  // Safe to Spend total underneath is unaffected either way.
  const netSpentSoFar = topLevelForBudget
    .filter((c) => !c.isSavingsCategory)
    .reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, now)), 0)
  // Prorated across the year rather than only counting what happens to
  // be due this exact month — an annual premium due in October still
  // needs a share set aside in March, otherwise it looks "free" for 11
  // months and blows the budget the one month it actually lands.
  const monthlyRecurringReserve = monthlyEquivalentRecurringExpenses(recurring)

  const topLevel = categories.filter((c) => !c.parentId && !c.isSavingsCategory)
  const budgetRows = topLevel
    .map((c) => ({ category: c, spent: netSpentForCategory(c, categories, transactions, now), budget: effectiveBudget(c, categories) }))
    .filter((r) => r.budget > 0)
    .sort((a, b) => b.spent / (b.budget || 1) - a.spent / (a.budget || 1))
    .slice(0, 5)

  const insights = useMemo(() => generateInsights(categories, transactions, now), [categories, transactions, now.toDateString()])
  const goalCategories = categories.filter((c) => !c.parentId && isGoal(c))

  const pieSlices = useMemo(() => categoryBreakdown(categories, transactions, now), [categories, transactions, now.toDateString()])
  const dailySpend = useMemo(() => last14DaysSpend(transactions, categories, now), [categories, transactions, now.toDateString()])
  const monthRecap = useMemo(() => buildMonthRecap(categories, transactions, now), [categories, transactions, now.toDateString()])
  const lastMonthDate = useMemo(() => new Date(now.getFullYear(), now.getMonth() - 1, 1), [now.toDateString()])
  const expectedIncome = useMemo(() => computeDashboardTotals(categories, transactions, lastMonthDate).income, [categories, transactions, lastMonthDate])
  const totalAllocated = useMemo(() => categories.filter((c) => !c.parentId).reduce((sum, c) => sum + effectiveBudget(c, categories), 0), [categories])
  const unallocated = expectedIncome - totalAllocated
  const monthRecapLabel = now.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
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

          goals: goalCategories.length > 0 && (
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
