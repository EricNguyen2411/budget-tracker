import { useState } from 'react'
import type { Category, Transaction } from '../types'
import { buildMonthRecap, classify } from '../monthlyRecap'
import { formatCurrency, localDateInputValue } from '../calculations'
import { periodOffsetBy, getSettings, getCycleConfig, isCustomCycle } from '../budgetPeriod'
import { useSwipeBack } from '../useSwipeBack'
import RecapBucketDetail, { type RecapBucket } from './RecapBucketDetail'
import AnimatedProgressBar from '../components/AnimatedProgressBar'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSaveTransaction: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDeleteTransaction: (id: string) => void
  onOpenCategoryPeriod: (title: string, start: string, end: string, categoryId: string) => void
  initialMonthOffset?: number
}

export default function MonthlyRecapPage({ categories, transactions, onBack, onSaveTransaction, onDeleteTransaction, onOpenCategoryPeriod, initialMonthOffset = -1 }: Props) {
  useSwipeBack(onBack)
  const [monthOffset, setMonthOffset] = useState(initialMonthOffset) // last full month by default when opened standalone; the Dashboard widget passes 0 to stay on the month it already showed
  const [openBucket, setOpenBucket] = useState<RecapBucket | null>(null)

  const now = new Date()
  const settings = getSettings()
  // Confirmed a real, separate bug: building referenceDate as "day 1 of
  // (this calendar month + offset)" doesn't reliably land in the period
  // actually containing today once a custom cycle is in play — for a
  // late-month cycle (a fixed day past the 1st, or "last business
  // day"), day 1 of the current calendar month falls in the PREVIOUS
  // cycle whenever today's date is past the cycle's own start day, so
  // offset=0 could silently show last cycle instead of the current
  // one. periodOffsetBy resolves the actual target period directly
  // from today, correct for any cycle mode — a date safely inside that
  // period (its start + 1 day) is then used as referenceDate wherever
  // one is needed for calculations.
  const period = periodOffsetBy(monthOffset, now, getCycleConfig())
  const referenceDate = new Date(period.start.getTime() + 24 * 60 * 60 * 1000)
  const { start: periodStart, end: periodEnd } = period
  // periodOffsetBy's `end` is EXCLUSIVE (the instant the next period
  // starts) — but onOpenCategoryPeriod's `end` string is documented and
  // consumed as INCLUSIVE (see PeriodDetail.tsx). Passing periodEnd
  // through unadjusted would silently include one extra day belonging
  // to the NEXT cycle. periodEndInclusive is periodEnd minus one day —
  // the actual last day that belongs to this period.
  const periodEndInclusive = new Date(periodEnd.getTime() - 86400000)
  const monthLabel = isCustomCycle(settings)
    ? `${periodStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – ${periodEndInclusive.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}`
    : referenceDate.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })

  const recap = buildMonthRecap(categories, transactions, referenceDate)

  if (openBucket) {
    return (
      <RecapBucketDetail
        bucket={openBucket}
        monthLabel={monthLabel}
        referenceDate={referenceDate}
        categories={categories}
        transactions={transactions}
        classify={classify}
        onBack={() => setOpenBucket(null)}
        onSave={onSaveTransaction}
        onDelete={onDeleteTransaction}
        onOpenCategory={(categoryId, name) => {
          onOpenCategoryPeriod(`${name} — ${monthLabel}`, localDateInputValue(periodStart), localDateInputValue(periodEndInclusive), categoryId)
        }}
      />
    )
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Month in Review</h1>
        <span style={{ width: 40 }} />
      </div>

      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button onClick={() => setMonthOffset((m) => m - 1)} style={{ fontSize: 18, color: 'var(--blue)', padding: '13px 12px' }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{monthLabel}</span>
        <button onClick={() => setMonthOffset((m) => m + 1)} disabled={monthOffset >= 0} style={{ fontSize: 18, color: monthOffset >= 0 ? 'var(--text-faint)' : 'var(--blue)', padding: '13px 12px' }}>›</button>
      </div>

      {recap.income <= 0 ? (
        <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>No income recorded this period — add your payslip for {monthLabel} to see a full recap.</p>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <button style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 10 }} onClick={() => setOpenBucket('income')}>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Income</span>
              <span className="amount" style={{ color: 'var(--green)' }}>{formatCurrency(recap.income)}</span>
            </button>
            <button style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 10 }} onClick={() => setOpenBucket('needs')}>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Needs — {Math.round(recap.needsPct * 100)}% <span style={{ color: 'var(--text-faint)' }}>(~50% guide)</span></span>
              <span className="amount">{formatCurrency(recap.needsSpent)}</span>
            </button>
            <button style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 10 }} onClick={() => setOpenBucket('wants')}>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Wants — {Math.round(recap.wantsPct * 100)}% <span style={{ color: 'var(--text-faint)' }}>(~30% guide)</span></span>
              <span className="amount">{formatCurrency(recap.wantsSpent)}</span>
            </button>
            <button style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }} onClick={() => setOpenBucket('saved')}>
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Saved — {Math.round(recap.savedPct * 100)}% <span style={{ color: 'var(--text-faint)' }}>(~20% guide)</span></span>
              <span className="amount" style={{ color: 'var(--indigo)' }}>{formatCurrency(recap.totalSaved)}</span>
            </button>

            {(() => {
              const netAmount = recap.income - recap.totalSaved - recap.needsSpent - recap.wantsSpent
              const unclassified = recap.totalSpent - recap.needsSpent - recap.wantsSpent
              return (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>Net (Income − Saved − Needs − Wants)</span>
                    <span className="amount" style={{ fontWeight: 600, color: netAmount >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatCurrency(netAmount)}</span>
                  </div>
                  {unclassified > 1 && (
                    <p className="hint" style={{ marginTop: 6 }}>Includes {formatCurrency(unclassified)} of spending not classified as a need or want, so it's folded into this figure rather than subtracted separately — set Need/Want on those categories for a more precise number.</p>
                  )}
                </div>
              )
            })()}
          </div>

          {recap.suggestions.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 10px' }}>💡 Suggestions</span>
              {recap.suggestions.map((s, i) => (
                <p key={i} style={{ fontSize: 13, lineHeight: 1.5, marginTop: i > 0 ? 10 : 0 }}>{s}</p>
              ))}
              <p className="hint" style={{ marginTop: 12 }}>Based on the 50/30/20 budgeting framework (MoneySmart/ASIC) and your own spending patterns this month — a general guide, not personal financial advice.</p>
            </div>
          )}

          {recap.goals.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 10px' }}>🎯 Savings Goals</span>
              {recap.goals.map((g) => (
                <button key={g.categoryId} style={{ display: 'block', width: '100%', textAlign: 'left', marginTop: 10 }} onClick={() => {
                  onOpenCategoryPeriod(`${g.name} — ${monthLabel}`, localDateInputValue(periodStart), localDateInputValue(periodEndInclusive), g.categoryId)
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                    <span>{g.icon} {g.name}</span>
                    <span style={{ color: g.fraction >= 1 ? 'var(--green)' : g.onTrack === false ? 'var(--red)' : 'var(--text-dim)' }}>
                      {g.fraction >= 1 ? 'Reached!' : g.onTrack === false ? 'Behind pace' : g.onTrack === true ? 'On track' : `${Math.round(g.fraction * 100)}%`}
                    </span>
                  </div>
                  <AnimatedProgressBar fraction={g.fraction} color={g.fraction >= 1 ? 'var(--green)' : 'var(--indigo)'} />
                  <div className="amount" style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>{formatCurrency(g.progress)} of {formatCurrency(g.target)}</div>
                </button>
              ))}
            </div>
          )}

          <div className="card">
            <span className="section-heading" style={{ margin: '0 0 10px' }}>By Category</span>
            {recap.categories.map((c) => {
              const over = c.budget > 0 && c.spent > c.budget
              return (
                <button key={c.categoryId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '8px 0' }} onClick={() => {
                  onOpenCategoryPeriod(`${c.name} — ${monthLabel}`, localDateInputValue(periodStart), localDateInputValue(periodEndInclusive), c.categoryId)
                }}>
                  <span style={{ fontSize: 13 }}>{c.icon} {c.name}</span>
                  <span className="amount" style={{ fontSize: 13, color: over ? 'var(--red)' : 'var(--text)' }}>
                    {formatCurrency(c.spent)}{c.budget > 0 ? ` / ${formatCurrency(c.budget)}` : ''}
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
