import { useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount, excessForReimbursement, netSpentForCategory, effectiveBudget } from '../calculations'
import { isInSamePeriod } from '../budgetPeriod'
import { useSwipeBack } from '../useSwipeBack'
import TransactionEditor from '../components/TransactionEditor'

export type RecapBucket = 'income' | 'needs' | 'wants' | 'saved'

interface Props {
  bucket: RecapBucket
  monthLabel: string
  referenceDate: Date
  categories: Category[]
  transactions: Transaction[]
  classify: (c: Category) => 'need' | 'want' | 'unknown'
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onOpenCategory: (categoryId: string, name: string) => void
}

const BUCKET_TITLES: Record<RecapBucket, string> = {
  income: 'Income',
  needs: 'Needs',
  wants: 'Wants',
  saved: 'Saved'
}

export default function RecapBucketDetail({ bucket, monthLabel, referenceDate, categories, transactions, classify, onBack, onSave, onDelete, onOpenCategory }: Props) {
  useSwipeBack(onBack)
  const [editing, setEditing] = useState<Transaction | null>(null)

  const periodTx = transactions.filter((t) => isInSamePeriod(new Date(t.date), referenceDate))

  if (bucket === 'needs' || bucket === 'wants') {
    const wanted = bucket === 'needs' ? 'need' : 'want'
    const rows = categories
      .filter((c) => !c.parentId && !c.isSavingsCategory && classify(c) === wanted)
      .map((c) => ({ category: c, spent: Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate)), budget: effectiveBudget(c, categories) }))
      .filter((r) => r.spent > 0)
      .sort((a, b) => b.spent - a.spent)
    const total = rows.reduce((s, r) => s + r.spent, 0)

    return (
      <div className="screen">
        <div className="screen-header-row">
          <button onClick={onBack} className="text-button">‹ Back</button>
          <h1 className="screen-title" style={{ fontSize: 20 }}>{BUCKET_TITLES[bucket]}</h1>
          <span style={{ width: 40 }} />
        </div>
        <div className="card hero-card" style={{ marginBottom: 16 }}>
          <span className="hero-label">{BUCKET_TITLES[bucket]} — {monthLabel}</span>
          <span className="hero-amount amount" style={{ fontSize: 32 }}>{formatCurrency(total)}</span>
        </div>
        {rows.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>Nothing classified as a {wanted} this month.</p>}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {rows.map((r, i) => (
            <button key={r.category.id} className="transaction-row" style={{ borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => onOpenCategory(r.category.id, r.category.name)}>
              <div className="tx-icon" style={{ background: r.category.color + '33' }}>{r.category.icon}</div>
              <div className="tx-info">
                <span className="tx-note">{r.category.name}</span>
                <span className="tx-category">{total > 0 ? Math.round((r.spent / total) * 100) : 0}% of {wanted}s</span>
              </div>
              <span className="amount">{formatCurrency(r.spent)}</span>
              <span className="chevron">›</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  // income / saved — transaction-level detail
  const rows = periodTx.filter((t) => {
    if (bucket === 'saved') {
      const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
      return t.isExpense && cat?.isSavingsCategory
    }
    // income: unlinked income in full, plus the excess portion of any reimbursement
    if (t.isExpense) return false
    if (!t.reimbursesExpenseId) return true
    return excessForReimbursement(t, transactions) > 0
  })
  const total = rows.reduce((sum, t) => {
    if (bucket === 'income' && t.reimbursesExpenseId) return sum + excessForReimbursement(t, transactions)
    return sum + netAmount(t, transactions)
  }, 0)
  const catById = new Map(categories.map((c) => [c.id, c]))
  const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{BUCKET_TITLES[bucket]}</h1>
        <span style={{ width: 40 }} />
      </div>
      <div className="card hero-card" style={{ marginBottom: 16 }}>
        <span className="hero-label">{BUCKET_TITLES[bucket]} — {monthLabel}</span>
        <span className="hero-amount amount" style={{ fontSize: 32, color: bucket === 'saved' ? 'var(--indigo)' : 'var(--green)' }}>{formatCurrency(total)}</span>
      </div>
      {sorted.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>Nothing here this month.</p>}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {sorted.map((t, i) => {
          const cat = t.categoryId ? catById.get(t.categoryId) : undefined
          const isExcessOnly = bucket === 'income' && !!t.reimbursesExpenseId
          const displayAmount = isExcessOnly ? excessForReimbursement(t, transactions) : netAmount(t, transactions)
          return (
            <button key={t.id} className="transaction-row" style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{t.note || cat?.name || 'Uncategorized'}</span>
                <span className="tx-category">{new Date(t.date).toLocaleDateString('en-AU')}{isExcessOnly ? ' · excess from reimbursement' : ''}</span>
              </div>
              <span className="amount" style={{ color: 'var(--green)' }}>+{formatCurrency(displayAmount)}</span>
            </button>
          )
        })}
      </div>

      {editing && (
        <TransactionEditor
          transaction={editing}
          categories={categories}
          allTransactions={transactions}
          onSave={(data) => { onSave(data, editing.id); setEditing(null) }}
          onDelete={() => { onDelete(editing.id); setEditing(null) }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
