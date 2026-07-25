import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount, totalExcessReimbursement } from '../calculations'
import { isInSamePeriod } from '../budgetPeriod'
import TransactionEditor from '../components/TransactionEditor'
import { useSwipeBack } from '../useSwipeBack'

export type StatKind = 'spent' | 'income' | 'reimbursed' | 'saved'

interface Props {
  kind: StatKind
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
}

const TITLES: Record<StatKind, string> = {
  spent: 'Spent',
  income: 'Income',
  reimbursed: 'Reimbursed',
  saved: 'Saved'
}

export default function TypedTransactions({ kind, categories, transactions, onBack, onSave, onDelete }: Props) {
  useSwipeBack(onBack)
  const [sort, setSort] = useState<'recent' | 'price'>('recent')
  const [editing, setEditing] = useState<Transaction | null>(null)

  const thisPeriod = useMemo(() => transactions.filter((t) => isInSamePeriod(new Date(t.date))), [transactions])

  const scoped = useMemo(() => {
    switch (kind) {
      case 'spent':
        return thisPeriod.filter((t) => {
          const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
          return t.isExpense && !cat?.isSavingsCategory
        })
      case 'saved':
        return thisPeriod.filter((t) => {
          const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
          return t.isExpense && cat?.isSavingsCategory
        })
      case 'income':
        return thisPeriod.filter((t) => !t.isExpense && !t.reimbursesExpenseId)
      case 'reimbursed':
        return thisPeriod.filter((t) => !t.isExpense && t.reimbursesExpenseId)
    }
  }, [thisPeriod, kind, categories])

  const total = scoped.reduce((sum, t) => {
    if (kind === 'reimbursed' && t.reimbursesExpenseId) {
      const expense = transactions.find((e) => e.id === t.reimbursesExpenseId)
      if (!expense) return sum
      // applied portion only, not any excess (which counts toward income instead)
      const excess = totalExcessReimbursement(expense, transactions)
      return sum + (t.amount - Math.min(excess, t.amount))
    }
    return sum + netAmount(t, transactions)
  }, 0)

  const sorted = [...scoped].sort((a, b) =>
    sort === 'recent' ? b.date.localeCompare(a.date) : netAmount(b, transactions) - netAmount(a, transactions)
  )

  const catById = new Map(categories.map((c) => [c.id, c]))

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{TITLES[kind]}</h1>
        <span style={{ width: 40 }} />
      </div>

      <div className="card" style={{ marginBottom: 16, textAlign: 'center' }}>
        <span className="hero-label">{TITLES[kind]} this period</span>
        <div className="hero-amount amount" style={{ fontSize: 32 }}>{formatCurrency(total)}</div>
      </div>

      <div className="segmented" style={{ marginBottom: 16 }}>
        <button className={sort === 'recent' ? 'segmented-active' : ''} onClick={() => setSort('recent')}>Recent</button>
        <button className={sort === 'price' ? 'segmented-active' : ''} onClick={() => setSort('price')}>Highest Price</button>
      </div>

      {sorted.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>Nothing here this period.</p>}

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
