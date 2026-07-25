import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount, totalExcessReimbursement } from '../calculations'
import TransactionEditor from '../components/TransactionEditor'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onBack: () => void
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

export default function CustomRangeReport({ categories, transactions, onSave, onBack }: Props) {
  const now = new Date()
  const [start, setStart] = useState(isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)))
  const [end, setEnd] = useState(isoDate(now))
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [editing, setEditing] = useState<Transaction | null>(null)

  function applyPreset(preset: string) {
    const today = new Date()
    switch (preset) {
      case '7d': setStart(isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6))); setEnd(isoDate(today)); break
      case '30d': setStart(isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29))); setEnd(isoDate(today)); break
      case '90d': setStart(isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 89))); setEnd(isoDate(today)); break
      case 'thisMonth': setStart(isoDate(new Date(today.getFullYear(), today.getMonth(), 1))); setEnd(isoDate(today)); break
      case 'lastMonth': {
        const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1)
        const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0)
        setStart(isoDate(lastMonthStart)); setEnd(isoDate(lastMonthEnd))
        break
      }
      case 'ytd': setStart(isoDate(new Date(today.getFullYear(), 0, 1))); setEnd(isoDate(today)); break
    }
  }

  const rangeTransactions = useMemo(() => {
    const startDate = new Date(start)
    const endDate = new Date(end)
    endDate.setDate(endDate.getDate() + 1) // inclusive of the end day
    return transactions.filter((t) => {
      const d = new Date(t.date)
      return d >= startDate && d < endDate
    })
  }, [transactions, start, end])

  const totalSpent = rangeTransactions.filter((t) => t.isExpense).reduce((s, t) => s + netAmount(t, transactions), 0)
  const unlinkedIncome = rangeTransactions.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((s, t) => s + t.amount, 0)
  const excessFromLinked = rangeTransactions
    .filter((t) => !t.isExpense && t.reimbursesExpenseId)
    .reduce((s, t) => {
      const expense = transactions.find((e) => e.id === t.reimbursesExpenseId)
      return expense ? s + totalExcessReimbursement(expense, transactions) : s
    }, 0)
  const totalIncome = unlinkedIncome + excessFromLinked

  const categoryTotals = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of rangeTransactions.filter((t) => t.isExpense && t.categoryId)) {
      map.set(t.categoryId!, (map.get(t.categoryId!) ?? 0) + netAmount(t, transactions))
    }
    return Array.from(map.entries())
      .map(([id, amount]) => ({ category: categories.find((c) => c.id === id), amount }))
      .filter((x) => x.category)
      .sort((a, b) => b.amount - a.amount)
  }, [rangeTransactions])

  const displayedTransactions = categoryFilter
    ? rangeTransactions.filter((t) => t.categoryId === categoryFilter)
    : rangeTransactions
  const sorted = [...displayedTransactions].sort((a, b) => b.date.localeCompare(a.date))

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Custom Report</h1>
        <span style={{ width: 40 }} />
      </div>

      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
        {[
          { key: '7d', label: 'Last 7 Days' },
          { key: '30d', label: 'Last 30 Days' },
          { key: '90d', label: 'Last 90 Days' },
          { key: 'thisMonth', label: 'This Month' },
          { key: 'lastMonth', label: 'Last Month' },
          { key: 'ytd', label: 'Year to Date' }
        ].map((p) => (
          <button key={p.key} onClick={() => applyPreset(p.key)} style={{ whiteSpace: 'nowrap', fontSize: 12, padding: '6px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
            {p.label}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 16, display: 'flex', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label className="field-label">From</label>
          <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label className="field-label">To</label>
          <input type="date" value={end} min={start} max={isoDate(now)} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginBottom: 6 }}>
          <span>Net Spent</span>
          <span className="amount" style={{ color: 'var(--red)' }}>{formatCurrency(totalSpent)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
          <span>Income</span>
          <span className="amount" style={{ color: 'var(--green)' }}>{formatCurrency(totalIncome)}</span>
        </div>
      </div>

      {categoryTotals.length > 0 && (
        <>
          <span className="section-heading">By Category</span>
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            {categoryTotals.map(({ category, amount }, i) => (
              <button
                key={category!.id}
                className="transaction-row"
                style={{ borderBottom: i < categoryTotals.length - 1 ? '1px solid var(--border)' : 'none' }}
                onClick={() => setCategoryFilter(categoryFilter === category!.id ? null : category!.id)}
              >
                <div className="tx-icon" style={{ background: category!.color + '33' }}>{category!.icon}</div>
                <div className="tx-info"><span className="tx-note">{category!.name}</span></div>
                <span className="amount" style={{ color: 'var(--text-dim)' }}>{formatCurrency(amount)}</span>
                {categoryFilter === category!.id && <span style={{ color: 'var(--blue)', marginLeft: 8 }}>✓</span>}
              </button>
            ))}
          </div>
        </>
      )}

      <span className="section-heading">{categoryFilter ? categories.find((c) => c.id === categoryFilter)?.name : 'All'} Transactions</span>
      {sorted.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>Nothing in this date range.</p>}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {sorted.map((t, i) => (
          <button key={t.id} className="transaction-row" style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
            <div className="tx-info">
              <span className="tx-note">{t.note || 'Uncategorized'}</span>
              <span className="tx-category">{new Date(t.date).toLocaleDateString('en-AU')}</span>
            </div>
            <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
              {t.isExpense ? '-' : '+'}{formatCurrency(netAmount(t, transactions))}
            </span>
          </button>
        ))}
      </div>

      {editing && (
        <TransactionEditor
          transaction={editing}
          categories={categories}
          allTransactions={transactions}
          onSave={(data) => { onSave(data, editing.id); setEditing(null) }}
          onDelete={() => setEditing(null)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
