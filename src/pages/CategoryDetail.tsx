import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount, netSpentForCategory, effectiveBudget, isGoal, goalProgress, goalProgressFraction, projectedGoalCompletionDate, reimbursementNote, repaysNote } from '../calculations'
import { isInSamePeriod } from '../budgetPeriod'
import TransactionEditor from '../components/TransactionEditor'
import AnimatedProgressBar from '../components/AnimatedProgressBar'
import { useSwipeBack } from '../useSwipeBack'
import SortMenuButton from '../components/SortMenuButton'

interface Props {
  category: Category
  allCategories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onOpenCategory: (category: Category) => void
}

export default function CategoryDetail({ category, allCategories, transactions, onBack, onSave, onDelete, onOpenCategory }: Props) {
  useSwipeBack(onBack)
  const [showAllTime, setShowAllTime] = useState(false)
  const [sort, setSort] = useState<'recent' | 'price'>('recent')
  const [editing, setEditing] = useState<Transaction | null>(null)

  const subcategories = allCategories.filter((c) => c.parentId === category.id)
  const categoryIds = new Set([category.id, ...subcategories.map((s) => s.id)])

  const relevant = useMemo(() => {
    const base = transactions.filter((t) => t.categoryId && categoryIds.has(t.categoryId))
    return showAllTime ? base : base.filter((t) => isInSamePeriod(new Date(t.date)))
  }, [transactions, showAllTime, category.id])

  const sorted = [...relevant].sort((a, b) =>
    sort === 'recent' ? b.date.localeCompare(a.date) : netAmount(b, transactions) - netAmount(a, transactions)
  )
  const budget = effectiveBudget(category, allCategories)
  const spent = Math.max(0, netSpentForCategory(category, allCategories, transactions, new Date()))
  const goal = isGoal(category)

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{category.icon} {category.name}</h1>
        <SortMenuButton
          options={[{ value: 'recent', label: 'Newest First' }, { value: 'price', label: 'Highest Price First' }]}
          value={sort}
          onChange={setSort}
        />
      </div>

      {goal && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
            <span>{goalProgressFraction(category, transactions) >= 1 ? 'Goal reached!' : 'Goal progress'}</span>
            <span style={{ color: goalProgressFraction(category, transactions) >= 1 ? 'var(--green)' : 'var(--text-dim)' }}>
              {Math.round(goalProgressFraction(category, transactions) * 100)}%
            </span>
          </div>
          <AnimatedProgressBar fraction={goalProgressFraction(category, transactions)} color={category.color} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
            <span className="amount">{formatCurrency(goalProgress(category, transactions))} of {formatCurrency(category.goalTargetAmount)}</span>
            {(() => {
              const p = projectedGoalCompletionDate(category, transactions)
              return p ? <span>~{p.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</span> : null
            })()}
          </div>
        </div>
      )}

      {!goal && budget > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
            <span>Spent this period</span>
            <span className="amount" style={{ color: spent > budget ? 'var(--red)' : 'var(--text-dim)' }}>{formatCurrency(spent)} / {formatCurrency(budget)}</span>
          </div>
          <AnimatedProgressBar fraction={budget > 0 ? spent / budget : 0} color={spent > budget ? 'var(--red)' : category.color} />
        </div>
      )}

      {subcategories.length > 0 && (
        <>
          <span className="section-heading">Subcategories</span>
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            {subcategories.map((s, i) => {
              const subSpent = Math.max(0, netSpentForCategory(s, allCategories, transactions, new Date()))
              return (
                <button key={s.id} className="transaction-row" style={{ borderBottom: i < subcategories.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => onOpenCategory(s)}>
                  <div className="tx-icon" style={{ background: s.color + '33' }}>{s.icon}</div>
                  <div className="tx-info"><span className="tx-note">{s.name}</span></div>
                  <span className="amount" style={{ color: 'var(--text-dim)' }}>{formatCurrency(subSpent)}</span>
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="segmented" style={{ marginBottom: 16 }}>
        <button className={!showAllTime ? 'segmented-active' : ''} onClick={() => setShowAllTime(false)}>This Period</button>
        <button className={showAllTime ? 'segmented-active' : ''} onClick={() => setShowAllTime(true)}>All Time</button>
      </div>

      {sorted.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>Nothing logged {showAllTime ? '' : 'this period'} yet.</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {sorted.map((t, i) => (
          <button key={t.id} className="transaction-row" style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
            <div className="tx-info">
              <span className="tx-note">{t.note || 'Uncategorized'}</span>
              <span className="tx-category">{new Date(t.date).toLocaleDateString('en-AU')}{repaysNote(t, transactions) && ` · ${repaysNote(t, transactions)}`}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
              {reimbursementNote(t, transactions) && (
                <span className="amount" style={{ fontSize: 12, color: 'var(--text-faint)', textDecoration: 'line-through' }}>
                  {formatCurrency(t.amount)}
                </span>
              )}
              <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                {t.isExpense ? '-' : '+'}{formatCurrency(netAmount(t, transactions))}
              </span>
            </div>
          </button>
        ))}
      </div>

      {editing && (
        <TransactionEditor
          transaction={editing}
          categories={allCategories}
          allTransactions={transactions}
          onSave={(data) => { onSave(data, editing.id); setEditing(null) }}
          onDelete={() => { onDelete(editing.id); setEditing(null) }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
