import type { Category, Transaction } from '../types'
import { categoryTrend, formatCurrency } from '../calculations'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  category: Category
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
}

export default function CategoryTrendPage({ category, categories, transactions, onBack }: Props) {
  useSwipeBack(onBack)
  const points = categoryTrend(category, categories, transactions, new Date(), 6)
  const budget = points[0]?.budget ?? 0
  const maxValue = Math.max(budget, ...points.map((p) => p.amount), 1)
  const overCount = points.filter((p) => budget > 0 && p.amount > budget).length

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{category.icon} {category.name} — 6 Months</h1>
        <span style={{ width: 40 }} />
      </div>

      {budget > 0 ? (
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
          {overCount === 0
            ? `Under its ${formatCurrency(budget)} budget every one of the last 6 periods.`
            : `Over its ${formatCurrency(budget)} budget in ${overCount} of the last 6 periods.`}
        </p>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
          No budget set for this category — showing spend only, nothing to compare it against.
        </p>
      )}

      <div className="card" style={{ paddingBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 160, marginTop: 8 }}>
          {points.map((p, i) => {
            const over = budget > 0 && p.amount > budget
            const heightPct = Math.max(2, (p.amount / maxValue) * 100)
            return (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 10, color: over ? 'var(--red)' : 'var(--text-faint)', marginBottom: 4 }}>
                  {p.amount >= 1000 ? `${(p.amount / 1000).toFixed(1)}k` : Math.round(p.amount)}
                </span>
                <div
                  style={{
                    width: '100%',
                    height: `${heightPct}%`,
                    background: over ? 'var(--red)' : category.color,
                    borderRadius: 4,
                    minHeight: 3,
                    transition: 'height 0.4s ease'
                  }}
                />
                <span style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 6 }}>
                  {p.periodStart.toLocaleDateString('en-AU', { month: 'short' })}
                </span>
              </div>
            )
          })}
        </div>
        {budget > 0 && (() => {
          const linePct = Math.min(100, (budget / maxValue) * 100)
          return (
            <div style={{ position: 'relative', height: 0 }}>
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: `${160 * (linePct / 100) + 26}px`, borderTop: '1px dashed var(--text-faint)' }} />
            </div>
          )
        })()}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: 16 }}>
        {points.map((p, i) => {
          const over = budget > 0 && p.amount > budget
          return (
            <div key={i} className="transaction-row" style={{ borderBottom: i < points.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div className="tx-info">
                <span className="tx-note">{p.periodStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</span>
              </div>
              <span className="amount tx-amount" style={{ color: over ? 'var(--red)' : 'var(--text-dim)' }}>
                {formatCurrency(p.amount)}{budget > 0 ? ` / ${formatCurrency(budget)}` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
