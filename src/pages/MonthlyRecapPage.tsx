import { useState } from 'react'
import type { Category, Transaction } from '../types'
import { buildMonthRecap, classify } from '../monthlyRecap'
import { formatCurrency } from '../calculations'
import { useSwipeBack } from '../useSwipeBack'
import RecapBucketDetail, { type RecapBucket } from './RecapBucketDetail'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSaveTransaction: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDeleteTransaction: (id: string) => void
  onOpenCategoryPeriod: (title: string, start: string, end: string, categoryId: string) => void
}

export default function MonthlyRecapPage({ categories, transactions, onBack, onSaveTransaction, onDeleteTransaction, onOpenCategoryPeriod }: Props) {
  useSwipeBack(onBack)
  const [monthOffset, setMonthOffset] = useState(-1) // default to last full month, not the still-in-progress current one
  const [openBucket, setOpenBucket] = useState<RecapBucket | null>(null)

  const now = new Date()
  const referenceDate = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
  const monthLabel = referenceDate.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })

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
          const monthStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1)
          const monthEnd = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0)
          onOpenCategoryPeriod(`${name} — ${monthLabel}`, monthStart.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10), categoryId)
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
        <button onClick={() => setMonthOffset((m) => m - 1)} style={{ fontSize: 18, color: 'var(--blue)', padding: '4px 12px' }}>‹</button>
        <span style={{ fontSize: 15, fontWeight: 600 }}>{monthLabel}</span>
        <button onClick={() => setMonthOffset((m) => m + 1)} disabled={monthOffset >= 0} style={{ fontSize: 18, color: monthOffset >= 0 ? 'var(--text-faint)' : 'var(--blue)', padding: '4px 12px' }}>›</button>
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
                  const monthStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1)
                  const monthEnd = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0)
                  onOpenCategoryPeriod(`${g.name} — ${monthLabel}`, monthStart.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10), g.categoryId)
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                    <span>{g.icon} {g.name}</span>
                    <span style={{ color: g.fraction >= 1 ? 'var(--green)' : g.onTrack === false ? 'var(--red)' : 'var(--text-dim)' }}>
                      {g.fraction >= 1 ? 'Reached!' : g.onTrack === false ? 'Behind pace' : g.onTrack === true ? 'On track' : `${Math.round(g.fraction * 100)}%`}
                    </span>
                  </div>
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${Math.min(1, g.fraction) * 100}%`, background: g.fraction >= 1 ? 'var(--green)' : 'var(--indigo)' }} />
                  </div>
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
                  const monthStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1)
                  const monthEnd = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0)
                  onOpenCategoryPeriod(`${c.name} — ${monthLabel}`, monthStart.toISOString().slice(0, 10), monthEnd.toISOString().slice(0, 10), c.categoryId)
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
