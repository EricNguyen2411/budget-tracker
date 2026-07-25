import type { Category, Transaction } from '../types'
import { computeDashboardTotals, formatCurrency, daysRemainingInMonth, netSpentForCategory, effectiveBudget, isGoal, goalProgress, goalProgressFraction, projectedGoalCompletionDate, categoryBreakdown, last14DaysSpend, last6PeriodsSpend, last6PeriodsNetSavings } from '../calculations'
import { generateInsights } from '../insights'
import { DonutChart, BarChart } from '../components/Charts'
import { getHiddenWidgets } from '../dashboardWidgets'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onOpenCategory: (id: string) => void
  onOpenStat: (kind: 'spent' | 'income' | 'reimbursed' | 'saved') => void
  onOpenDateRange: (start: string, end: string) => void
}

export default function Dashboard({ categories, transactions, onOpenCategory, onOpenStat, onOpenDateRange }: Props) {
  const now = new Date()
  const totals = computeDashboardTotals(categories, transactions, now)
  const days = daysRemainingInMonth(now)
  const perDay = Math.max(0, totals.safeToSpend) / days

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
  const monthlyTrend = last6PeriodsSpend(categories, transactions, now)
  const netSavingsTrend = last6PeriodsNetSavings(categories, transactions, now)
  const hidden = getHiddenWidgets()

  return (
    <div className="screen">
      <h1 className="screen-title">Dashboard</h1>

      <div className="card hero-card">
        <span className="hero-label">Safe to Spend</span>
        <span className="hero-amount amount">{formatCurrency(totals.safeToSpend)}</span>
        <span className="hero-sub">{formatCurrency(perDay)}/day for {days} more day{days === 1 ? '' : 's'} this month</span>
      </div>

      <div className="stat-grid">
        <button className="card stat-card" style={{ textAlign: 'left' }} onClick={() => onOpenStat('spent')}>
          <span className="stat-label">Spent</span>
          <span className="stat-value amount" style={{ color: 'var(--red)' }}>{formatCurrency(totals.spent)}</span>
        </button>
        <button className="card stat-card" style={{ textAlign: 'left' }} onClick={() => onOpenStat('income')}>
          <span className="stat-label">Income</span>
          <span className="stat-value amount" style={{ color: 'var(--green)' }}>{formatCurrency(totals.income)}</span>
        </button>
        <button className="card stat-card" style={{ textAlign: 'left' }} onClick={() => onOpenStat('reimbursed')}>
          <span className="stat-label">Reimbursed</span>
          <span className="stat-value amount" style={{ color: 'var(--teal)' }}>{formatCurrency(totals.reimbursed)}</span>
        </button>
        {totals.saved > 0 && (
          <button className="card stat-card" style={{ textAlign: 'left' }} onClick={() => onOpenStat('saved')}>
            <span className="stat-label">Saved</span>
            <span className="stat-value amount" style={{ color: 'var(--indigo)' }}>{formatCurrency(totals.saved)}</span>
          </button>
        )}
      </div>

      {insights.length > 0 && !hidden.has('insights') && (
        <div className="card" style={{ marginTop: 16 }}>
          <span className="section-heading" style={{ margin: '0 0 10px' }}>✨ Insights</span>
          {insights.map((insight, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: i > 0 ? 10 : 0 }}>
              <span>{insight.icon}</span>
              <span style={{ fontSize: 13, lineHeight: 1.4 }}>{insight.text}</span>
            </div>
          ))}
        </div>
      )}

      {goalCategories.length > 0 && !hidden.has('goals') && (
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
      )}

      {budgetRows.length > 0 && !hidden.has('budgetVsActual') && (
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
      )}

      {pieSlices.length > 0 && !hidden.has('categoryPie') && (
        <div className="card" style={{ marginTop: 16 }}>
          <span className="section-heading" style={{ margin: '0 0 12px' }}>Spending by Category</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
            <DonutChart slices={pieSlices.map((s) => ({ label: s.name, value: s.amount, color: s.color }))} />
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
      )}

      {dailySpend.some((d) => d.amount > 0) && !hidden.has('last14Days') && (
        <div className="card" style={{ marginTop: 16 }}>
          <span className="section-heading" style={{ margin: '0 0 12px' }}>Last 14 Days</span>
          <BarChart data={dailySpend.map((d) => ({
            label: d.date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }),
            axisLabel: d.date.toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric' }),
            value: d.amount,
            onSelect: () => onOpenDateRange(d.date.toISOString().slice(0, 10), d.date.toISOString().slice(0, 10))
          }))} height={100} />
        </div>
      )}

      {monthlyTrend.some((d) => d.amount > 0) && !hidden.has('monthlyTrend') && (
        <div className="card" style={{ marginTop: 16 }}>
          <span className="section-heading" style={{ margin: '0 0 12px' }}>Monthly Trend</span>
          <BarChart data={monthlyTrend.map((d) => {
            const monthEnd = new Date(d.periodStart.getFullYear(), d.periodStart.getMonth() + 1, d.periodStart.getDate() - 1)
            return {
              label: d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
              axisLabel: d.periodStart.toLocaleDateString('en-AU', { month: 'short' }),
              value: d.amount,
              onSelect: () => onOpenDateRange(d.periodStart.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10))
            }
          })} height={100} />
        </div>
      )}

      {netSavingsTrend.some((d) => d.amount !== 0) && !hidden.has('netSavingsTrend') && (
        <div className="card" style={{ marginTop: 16 }}>
          <span className="section-heading" style={{ margin: '0 0 12px' }}>Net Savings Trend</span>
          <BarChart data={netSavingsTrend.map((d) => {
            const monthEnd = new Date(d.periodStart.getFullYear(), d.periodStart.getMonth() + 1, d.periodStart.getDate() - 1)
            return {
              label: d.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
              axisLabel: d.periodStart.toLocaleDateString('en-AU', { month: 'short' }),
              value: d.amount,
              onSelect: () => onOpenDateRange(d.periodStart.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10))
            }
          })} height={100} />
        </div>
      )}
    </div>
  )
}
