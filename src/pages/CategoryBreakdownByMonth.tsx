import { useState } from 'react'
import type { Category, Transaction } from '../types'
import { categoryBreakdown, formatCurrency, localDateInputValue } from '../calculations'
import { periodOffsetBy, getSettings, getCycleConfig, isCustomCycle } from '../budgetPeriod'
import { DonutChart } from '../components/Charts'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onOpenPeriod: (title: string, start: string, end: string, categoryId?: string) => void
}

export default function CategoryBreakdownByMonth({ categories, transactions, onBack, onOpenPeriod }: Props) {
  useSwipeBack(onBack)
  const [monthOffset, setMonthOffset] = useState(0)

  const now = new Date()
  const settings = getSettings()
  // Confirmed a real, separate bug here: building referenceDate as "day
  // 1 of (this calendar month + offset)" doesn't reliably land in the
  // period actually containing today once a custom cycle is in play —
  // for a cycle starting the 25th (or any late-month cycle, including
  // "last business day"), day 1 of the current calendar month falls in
  // the PREVIOUS cycle whenever today's date is past the cycle's start
  // day, so this screen's default view silently showed last cycle
  // instead of the current one. periodOffsetBy resolves the actual
  // target period directly from today, which is correct for any cycle
  // mode — and a date safely inside that period (its start + 1 day) is
  // then used as referenceDate wherever one is needed for calculations.
  const period = periodOffsetBy(monthOffset, now, getCycleConfig())
  const referenceDate = new Date(period.start.getTime() + 24 * 60 * 60 * 1000)
  const { start, end } = period
  // `end` from periodOffsetBy is EXCLUSIVE (the instant the next period
  // starts), but onOpenPeriod's `end` is consumed as INCLUSIVE by
  // PeriodDetail.tsx — confirmed the same off-by-one-day mismatch
  // affected Month in Review's drill-down too. endInclusive is the
  // actual last day belonging to this period.
  const endInclusive = new Date(end.getTime() - 86400000)

  const slices = categoryBreakdown(categories, transactions, referenceDate)
  const total = slices.reduce((sum, s) => sum + s.amount, 0)

  const monthLabel = isCustomCycle(settings)
    ? `${start.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – ${endInclusive.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : referenceDate.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Spending by Category</h1>
        <span style={{ width: 40 }} />
      </div>

      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={() => setMonthOffset((m) => m - 1)} style={{ fontSize: 18, color: 'var(--blue)', padding: '13px 12px' }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{monthLabel}</span>
        <button onClick={() => setMonthOffset((m) => m + 1)} disabled={monthOffset >= 0} style={{ fontSize: 18, color: monthOffset >= 0 ? 'var(--text-faint)' : 'var(--blue)', padding: '13px 12px' }}>›</button>
      </div>

      {slices.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>No spending recorded for this period.</p>}

      {slices.length > 0 && (
        <div className="card">
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <span className="hero-label">Total Spent</span>
            <div className="amount" style={{ fontSize: 28, fontWeight: 700 }}>{formatCurrency(total)}</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <DonutChart slices={slices.map((s) => ({ label: s.name, value: s.amount, color: s.color }))} size={180} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {slices.map((s) => (
              <button
                key={s.categoryId}
                className="transaction-row"
                onClick={() => onOpenPeriod(
                  `${s.name} — ${monthLabel}`,
                  localDateInputValue(start),
                  localDateInputValue(endInclusive),
                  s.categoryId
                )}
              >
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.color, flexShrink: 0 }} />
                <div className="tx-info">
                  <span className="tx-note">{s.name}</span>
                  <span className="tx-category">{total > 0 ? Math.round((s.amount / total) * 100) : 0}% of spending</span>
                </div>
                <span className="amount">{formatCurrency(s.amount)}</span>
                <span className="chevron">›</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
