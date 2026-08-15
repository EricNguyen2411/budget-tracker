import { useState } from 'react'
import type { Category, Transaction, RecurringTransaction } from '../types'
import { computeDashboardTotals, formatCurrency, daysRemainingInMonth, netSpentForCategory, effectiveBudget, isGoal, goalProgress, goalProgressFraction, projectedGoalCompletionDate, categoryBreakdown, last14DaysSpend, last6PeriodsSpend, last6PeriodsNetSavings, localDateInputValue, topMerchantsThisMonth } from '../calculations'
import { generateInsights } from '../insights'
import { DonutChart, BarChart } from '../components/Charts'
import { getHiddenWidgets, getWidgetOrder, type WidgetId } from '../dashboardWidgets'
import { CameraIcon } from '../icons'
import { useModalClose } from '../useModalClose'
import { isInSamePeriod } from '../budgetPeriod'
import { buildMonthRecap } from '../monthlyRecap'

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

export default function Dashboard({ categories, transactions, recurring, onOpenCategory, onOpenStat, onOpenDateRange, onOpenMonthRecap, onOpenCategoryBreakdown, onOpenImport }: Props) {
  const now = new Date()
  const totals = computeDashboardTotals(categories, transactions, now)
  const days = daysRemainingInMonth(now)
  const perDay = Math.max(0, totals.safeToSpend) / days
  const [showBreakdown, setShowBreakdown] = useState(false)
  const breakdownClose = useModalClose(() => setShowBreakdown(false))

  const topLevelForBudget = categories.filter((c) => !c.parentId)
  const totalBudget = topLevelForBudget.reduce((sum, c) => sum + effectiveBudget(c, categories), 0)
  const netSpentSoFar = topLevelForBudget
    .filter((c) => !c.isSavingsCategory)
    .reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, now)), 0)
  const billsDueThisMonth = recurring
    .filter((r) => r.isActive && r.isExpense && isInSamePeriod(new Date(r.nextDueDate), now))
    .reduce((sum, r) => sum + r.amount, 0)

  const topLevel = categories.filter((c) => !c.parentId && !c.isSavingsCategory)
  const budgetRows = topLevel
    .map((c) => ({ category: c, spent: netSpentForCategory(c, categories, transactions, now), budget: effectiveBudget(c, categories) }))
    .filter((r) => r.budget > 0)
    .sort((a, b) => b.spent / (b.budget || 1) - a.spent / (a.budget || 1))
    .slice(0, 5)

  const insights = generateInsights(categories, transactions, now)
  const goalCategories = categories.filter((c) => !c.parentId && isGoal(c))

  const pieSlices = categoryBreakdown(categories, transactions, now)
  const dailySpend = last14DaysSpend(transactions, categories, now)
  const monthRecap = buildMonthRecap(categories, transactions, now)
  const monthRecapLabel = now.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
  const monthlyTrend = last6PeriodsSpend(categories, transactions, now)
  const netSavingsTrend = last6PeriodsNetSavings(categories, transactions, now)
  const hidden = getHiddenWidgets()
  const topMerchants = topMerchantsThisMonth(transactions, categories, now)

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
        <span className="hero-amount amount">{formatCurrency(totals.safeToSpend)}</span>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0' }}>
                <span style={{ fontSize: 14 }}>Bills Due This Month</span>
                <span className="amount" style={{ color: 'var(--amber)' }}>{formatCurrency(billsDueThisMonth)}</span>
              </div>
              <p className="hint" style={{ marginTop: 12 }}>
                Safe to Spend is your Monthly Budget minus Net Spend So Far, across every spending category — savings categories and bills are tracked separately and don't reduce it directly, but are shown here so you can see the full picture at a glance.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="stat-grid">
        <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(255, 69, 58, 0.08)', borderColor: 'rgba(255, 69, 58, 0.18)' }} onClick={() => onOpenStat('spent')}>
          <span className="stat-label">Spent</span>
          <span className="stat-value amount" style={{ color: 'var(--red)' }}>{formatCurrency(totals.spent)}</span>
        </button>
        <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(48, 209, 88, 0.08)', borderColor: 'rgba(48, 209, 88, 0.18)' }} onClick={() => onOpenStat('income')}>
          <span className="stat-label">Income</span>
          <span className="stat-value amount" style={{ color: 'var(--green)' }}>{formatCurrency(totals.income)}</span>
        </button>
        <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(100, 210, 255, 0.08)', borderColor: 'rgba(100, 210, 255, 0.18)' }} onClick={() => onOpenStat('reimbursed')}>
          <span className="stat-label">Reimbursed</span>
          <span className="stat-value amount" style={{ color: 'var(--teal)' }}>{formatCurrency(totals.reimbursed)}</span>
        </button>
        {totals.saved > 0 && (
          <button className="card stat-card" style={{ textAlign: 'left', background: 'rgba(94, 92, 230, 0.08)', borderColor: 'rgba(94, 92, 230, 0.18)' }} onClick={() => onOpenStat('saved')}>
            <span className="stat-label">Saved</span>
            <span className="stat-value amount" style={{ color: 'var(--indigo)' }}>{formatCurrency(totals.saved)}</span>
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
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${fraction * 100}%`, background: fraction >= 1 ? 'var(--green)' : c.color }} />
                    </div>
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
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${fraction * 100}%`, background: over ? 'var(--red)' : category.color }} />
                    </div>
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

          last14Days: dailySpend.some((d) => d.amount > 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Last 14 Days</span>
              <BarChart data={dailySpend.map((d) => ({
                label: d.date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }),
                axisLabel: d.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric' }),
                value: d.amount,
                onSelect: () => onOpenDateRange(d.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }), localDateInputValue(d.date), localDateInputValue(d.date))
              }))} height={100} preferredStep={200} />
            </div>
          ),

          monthlyTrend: monthlyTrend.some((d) => d.amount > 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Monthly Trend</span>
              <BarChart data={monthlyTrend.map((d) => {
                const monthEnd = new Date(d.periodStart.getFullYear(), d.periodStart.getMonth() + 1, d.periodStart.getDate() - 1)
                return {
                  label: d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
                  axisLabel: d.periodStart.toLocaleDateString('en-AU', { month: 'short' }),
                  value: d.amount,
                  onSelect: () => onOpenDateRange(d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }), localDateInputValue(d.periodStart), localDateInputValue(monthEnd))
                }
              })} height={100} preferredStep={2000} />
            </div>
          ),

          netSavingsTrend: netSavingsTrend.some((d) => d.amount !== 0) && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 12px' }}>Net Savings Trend</span>
              <BarChart data={netSavingsTrend.map((d) => {
                const monthEnd = new Date(d.periodStart.getFullYear(), d.periodStart.getMonth() + 1, d.periodStart.getDate() - 1)
                return {
                  label: d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
                  axisLabel: d.periodStart.toLocaleDateString('en-AU', { month: 'short' }),
                  value: d.amount,
                  onSelect: () => onOpenDateRange(d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }), localDateInputValue(d.periodStart), localDateInputValue(monthEnd))
                }
              })} height={100} preferredStep={2000} />
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
