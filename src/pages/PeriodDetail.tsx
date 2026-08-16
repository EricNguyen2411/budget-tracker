import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount, categoryAndDescendantIds } from '../calculations'
import TransactionEditor from '../components/TransactionEditor'
import { useSwipeBack } from '../useSwipeBack'
import SortMenuButton from '../components/SortMenuButton'
import CategoryFilterButton from '../components/CategoryFilterButton'

interface Props {
  title: string
  start: string // YYYY-MM-DD, inclusive
  end: string // YYYY-MM-DD, inclusive
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  initialCategoryId?: string
}

/** For chart taps — a specific day or month you tapped into. Deliberately
 * has no presets or date pickers (unlike Custom Date Range Report, which
 * is for picking an arbitrary range): the period is already known from
 * what you tapped, so showing it again would just be clutter. */
export default function PeriodDetail({ title, start, end, categories, transactions, onBack, onSave, onDelete, initialCategoryId }: Props) {
  useSwipeBack(onBack)
  const [categoryFilter, setCategoryFilter] = useState<string | null>(initialCategoryId ?? null)
  const [sort, setSort] = useState<'recent' | 'price'>('recent')
  const [editing, setEditing] = useState<Transaction | null>(null)

  const periodTransactions = useMemo(() => {
    // new Date("2026-08-03") is parsed as UTC midnight, not local
    // midnight — in a UTC+10 timezone that's actually 10am local, which
    // would silently exclude any transaction from earlier that morning
    // even though the chart itself (using accurate toDateString()
    // comparison) correctly counts it as part of that day's total.
    const [startY, startM, startD] = start.split('-').map(Number)
    const [endY, endM, endD] = end.split('-').map(Number)
    const startDate = new Date(startY, startM - 1, startD)
    const endDate = new Date(endY, endM - 1, endD + 1)
    return transactions.filter((t) => {
      const d = new Date(t.date)
      return d >= startDate && d < endDate
    })
  }, [transactions, start, end])

  const categoriesInPeriod = useMemo(() => {
    const ids = new Set(periodTransactions.map((t) => t.categoryId).filter((id): id is string => !!id))
    return categories.filter((c) => ids.has(c.id))
  }, [periodTransactions, categories])

  const filterCategory = categoryFilter ? categories.find((c) => c.id === categoryFilter) : null
  const filterIds = filterCategory ? categoryAndDescendantIds(filterCategory, categories) : null
  const filtered = filterIds ? periodTransactions.filter((t) => t.categoryId && filterIds.has(t.categoryId)) : periodTransactions
  const totalSpent = filtered.filter((t) => t.isExpense).reduce((s, t) => s + netAmount(t, transactions), 0)
  const filteredCategoryName = filterCategory?.name ?? null
  const sorted = [...filtered].sort((a, b) =>
    sort === 'recent' ? b.date.localeCompare(a.date) : netAmount(b, transactions) - netAmount(a, transactions)
  )
  const catById = new Map(categories.map((c) => [c.id, c]))

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{title}</h1>
        <SortMenuButton
          options={[{ value: 'recent', label: 'Newest First' }, { value: 'price', label: 'Highest Price First' }]}
          value={sort}
          onChange={setSort}
        />
      </div>

      <div className="card hero-card" style={{ marginBottom: 16 }}>
        <span className="hero-label">{filteredCategoryName ? `Spent on ${filteredCategoryName}` : 'Net Spent'}</span>
        <span className="hero-amount amount" style={{ fontSize: 32, color: 'var(--red)' }}>{formatCurrency(totalSpent)}</span>
      </div>

      {categoriesInPeriod.length > 1 && (
        <CategoryFilterButton categories={categoriesInPeriod} value={categoryFilter} onChange={setCategoryFilter} allLabel="All" />
      )}


      {sorted.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>Nothing here.</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {sorted.map((t, i) => {
          const cat = t.categoryId ? catById.get(t.categoryId) : undefined
          return (
            <button key={t.id} className="transaction-row" style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{t.note || cat?.name || 'Uncategorized'}</span>
                <span className="tx-category">{new Date(t.date).toLocaleDateString('en-AU')}</span>
              </div>
              <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                {t.isExpense ? '-' : '+'}{formatCurrency(netAmount(t, transactions))}
              </span>
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
