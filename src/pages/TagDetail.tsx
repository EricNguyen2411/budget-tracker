import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount } from '../calculations'
import { normalizeTag } from '../tags'
import { useSwipeBack } from '../useSwipeBack'
import { DonutChart } from '../components/Charts'
import TransactionEditor from '../components/TransactionEditor'

interface Props {
  tag: string
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onViewInTransactions: () => void
  onChanged: () => void
}

export default function TagDetail({ tag, categories, transactions, onBack, onSave, onDelete, onViewInTransactions, onChanged }: Props) {
  useSwipeBack(onBack)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const normalized = normalizeTag(tag)

  const tagged = useMemo(
    () => transactions.filter((t) => t.tags.some((tg) => normalizeTag(tg) === normalized)).sort((a, b) => b.date.localeCompare(a.date)),
    [transactions, normalized]
  )

  const expenseTotal = tagged.filter((t) => t.isExpense).reduce((sum, t) => sum + netAmount(t, transactions), 0)
  const incomeTotal = tagged.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)

  // Deliberately all-time / not period-scoped, unlike category
  // breakdowns elsewhere — a tag like a holiday or a trip doesn't care
  // where a budget cycle boundary happens to fall, and the whole point
  // is seeing the complete total for everything tagged, whenever it
  // happened.
  const dateRange = useMemo(() => {
    if (tagged.length === 0) return null
    const dates = tagged.map((t) => t.date).sort()
    return { first: dates[0], last: dates[dates.length - 1] }
  }, [tagged])

  const categoryBreakdown = useMemo(() => {
    const byCategory = new Map<string, { name: string; icon: string; color: string; amount: number }>()
    for (const t of tagged) {
      if (!t.isExpense) continue
      const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
      const key = cat?.id ?? 'none'
      const existing = byCategory.get(key) ?? { name: cat?.name ?? 'Uncategorized', icon: cat?.icon ?? '❓', color: cat?.color ?? '#5C6167', amount: 0 }
      existing.amount += netAmount(t, transactions)
      byCategory.set(key, existing)
    }
    return Array.from(byCategory.values()).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount)
  }, [tagged, categories, transactions])

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
  }

  if (editing) {
    return (
      <TransactionEditor
        transaction={editing}
        categories={categories}
        allTransactions={transactions}
        onSave={(data) => { onSave(data, editing.id); setEditing(null) }}
        onDelete={() => { onDelete(editing.id); setEditing(null) }}
        onClose={() => setEditing(null)}
        onChanged={onChanged}
      />
    )
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>#{normalized}</h1>
        <button onClick={onViewInTransactions} className="text-button" style={{ fontSize: 13 }}>List</button>
      </div>

      <div className="card hero-card" style={{ marginBottom: 16 }}>
        <span className="hero-label">Spent on #{normalized}</span>
        <span className="hero-amount amount" style={{ fontSize: 32 }}>{formatCurrency(expenseTotal)}</span>
        {incomeTotal > 0 && (
          <span style={{ fontSize: 13, color: 'var(--green)' }}>+{formatCurrency(incomeTotal)} income also tagged here</span>
        )}
        {dateRange && (
          <span style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
            {dateRange.first === dateRange.last ? formatDate(dateRange.first) : `${formatDate(dateRange.first)} – ${formatDate(dateRange.last)}`}
            {' · '}{tagged.length} transaction{tagged.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {categoryBreakdown.length > 1 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <span className="section-heading">By Category</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginTop: 12 }}>
            <DonutChart slices={categoryBreakdown.map((c) => ({ label: c.name, value: c.amount, color: c.color }))} size={110} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {categoryBreakdown.map((c) => (
                <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.icon} {c.name}</span>
                  <span className="amount" style={{ color: 'var(--text-dim)' }}>{formatCurrency(c.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {tagged.map((t, i) => {
          const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
          return (
            <button key={t.id} className="transaction-row" style={{ borderBottom: i < tagged.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{t.note || 'Uncategorized'}</span>
                <span className="tx-category">{formatDate(t.date)}{cat ? ` · ${cat.name}` : ''}</span>
              </div>
              <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                {t.isExpense ? '-' : '+'}{formatCurrency(netAmount(t, transactions))}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
