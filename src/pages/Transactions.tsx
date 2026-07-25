import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount } from '../calculations'
import { transactionsWithSimilarName } from '../duplicates'
import TransactionEditor from '../components/TransactionEditor'
import { PlusIcon } from '../icons'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
}

function dayLabel(date: Date): string {
  const today = new Date()
  const isToday = date.toDateString() === today.toDateString()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()
  if (isToday) return 'Today'
  if (isYesterday) return 'Yesterday'
  const sameYear = date.getFullYear() === today.getFullYear()
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric' })
}

export default function TransactionsPage({ categories, transactions, onSave, onDelete }: Props) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all')
  const [unlinkedOnly, setUnlinkedOnly] = useState(false)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [creating, setCreating] = useState(false)
  const [similarPrompt, setSimilarPrompt] = useState<{ note: string; categoryId: string; matches: Transaction[] } | null>(null)

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  const filtered = transactions.filter((t) => {
    if (filter === 'income' && t.isExpense) return false
    if (filter === 'expense' && !t.isExpense) return false
    if (filter === 'income' && unlinkedOnly && t.reimbursesExpenseId) return false
    if (search) {
      const cat = t.categoryId ? categoryById.get(t.categoryId)?.name ?? '' : ''
      const haystack = (t.note + ' ' + cat).toLowerCase()
      if (!haystack.includes(search.toLowerCase())) return false
    }
    return true
  })

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>()
    for (const t of filtered) {
      const d = new Date(t.date)
      const key = d.toDateString()
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(t)
    }
    return Array.from(map.entries())
      .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
      .map(([key, txs]) => ({ label: dayLabel(new Date(key)), transactions: txs }))
  }, [filtered])

  return (
    <div className="screen">
      <div className="screen-header-row">
        <h1 className="screen-title">Transactions</h1>
        <button className="round-icon-button" onClick={() => setCreating(true)}><PlusIcon /></button>
      </div>

      <input
        type="text"
        placeholder="Search notes or categories"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: 12 }}
      />

      <div className="segmented" style={{ marginBottom: filter === 'income' ? 10 : 16 }}>
        <button className={filter === 'all' ? 'segmented-active' : ''} onClick={() => setFilter('all')}>All</button>
        <button className={filter === 'income' ? 'segmented-active' : ''} onClick={() => setFilter('income')}>Income</button>
        <button className={filter === 'expense' ? 'segmented-active' : ''} onClick={() => setFilter('expense')}>Expenses</button>
      </div>

      {filter === 'income' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13, color: 'var(--text-dim)' }}>
          <input type="checkbox" checked={unlinkedOnly} onChange={(e) => setUnlinkedOnly(e.target.checked)} style={{ width: 16, height: 16 }} />
          <span>Only unlinked (no reimbursement)</span>
        </div>
      )}

      {groups.length === 0 && (
        <p style={{ color: 'var(--text-dim)', textAlign: 'center', marginTop: 40 }}>No transactions yet. Tap + to add one.</p>
      )}

      {groups.map((group) => (
        <div key={group.label} style={{ marginBottom: 20 }}>
          <span className="day-heading">{group.label}</span>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {group.transactions.map((t, i) => {
              const category = t.categoryId ? categoryById.get(t.categoryId) : undefined
              const amount = netAmount(t, transactions)
              return (
                <button
                  key={t.id}
                  className="transaction-row"
                  style={{ borderBottom: i < group.transactions.length - 1 ? '1px solid var(--border)' : 'none' }}
                  onClick={() => setEditing(t)}
                >
                  <div className="tx-icon" style={{ background: (category?.color ?? '#5C6167') + '33' }}>
                    {category?.icon ?? '❓'}
                  </div>
                  <div className="tx-info">
                    <span className="tx-note">{t.note || category?.name || 'Uncategorized'}</span>
                    <span className="tx-category">{category?.name ?? 'Uncategorized'}</span>
                  </div>
                  <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                    {t.isExpense ? '-' : '+'}{formatCurrency(amount)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {(editing || creating) && (
        <TransactionEditor
          transaction={editing}
          categories={categories}
          allTransactions={transactions}
          onSave={(data) => {
            const existingId = editing?.id ?? null
            onSave(data, existingId)
            if (data.categoryId && data.note.trim()) {
              const matches = transactionsWithSimilarName(data.note, data.categoryId, existingId, transactions)
              if (matches.length > 0) {
                setSimilarPrompt({ note: data.note, categoryId: data.categoryId, matches })
              }
            }
            setEditing(null)
            setCreating(false)
          }}
          onDelete={editing ? () => { onDelete(editing.id); setEditing(null) } : undefined}
          onClose={() => { setEditing(null); setCreating(false) }}
        />
      )}

      {similarPrompt && (
        <div className="modal-backdrop" onClick={() => setSimilarPrompt(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ padding: 20 }}>
            <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
              {similarPrompt.matches.length} other transaction{similarPrompt.matches.length === 1 ? '' : 's'} look{similarPrompt.matches.length === 1 ? 's' : ''} similar to "{similarPrompt.note}" but aren't categorized the same way. Categorize {similarPrompt.matches.length === 1 ? 'it' : 'them'} too?
            </p>
            <button
              className="list-button"
              style={{ width: '100%', textAlign: 'center', background: 'var(--green)', color: '#0B0D10', borderRadius: 10, padding: 12, fontWeight: 600, marginBottom: 8 }}
              onClick={async () => {
                for (const t of similarPrompt.matches) {
                  await onSave({ ...t, categoryId: similarPrompt.categoryId }, t.id)
                }
                setSimilarPrompt(null)
              }}
            >
              Categorize {similarPrompt.matches.length}
            </button>
            <button className="list-button" style={{ width: '100%', textAlign: 'center', color: 'var(--text-dim)' }} onClick={() => setSimilarPrompt(null)}>Not Now</button>
          </div>
        </div>
      )}
    </div>
  )
}
