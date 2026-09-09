import { useMemo, useState } from 'react'
import type { Category, Transaction, Account } from '../types'
import { formatCurrency, netAmount, repaysNote, excessForReimbursement, netSpentForCategory } from '../calculations'
import { isInSamePeriod } from '../budgetPeriod'
import TransactionEditor from '../components/TransactionEditor'
import { useSwipeBack } from '../useSwipeBack'
import SortMenuButton from '../components/SortMenuButton'

export type StatKind = 'spent' | 'income' | 'reimbursed' | 'saved'

interface Props {
  kind: StatKind
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onChanged: () => void
  accounts?: Account[]
}

const TITLES: Record<StatKind, string> = {
  spent: 'Spent',
  income: 'Income',
  reimbursed: 'Reimbursed',
  saved: 'Saved'
}

export default function TypedTransactions({ kind, categories, transactions, onBack, onSave, onDelete, onChanged, accounts = [] }: Props) {
  useSwipeBack(onBack)
  const [sort, setSort] = useState<'recent' | 'price'>('recent')
  const [editing, setEditing] = useState<Transaction | null>(null)
  const now = useMemo(() => new Date(), [])

  const thisPeriod = useMemo(() => transactions.filter((t) => isInSamePeriod(new Date(t.date), now)), [transactions, now])

  const scoped = useMemo(() => {
    switch (kind) {
      case 'spent':
        // Includes unlinked income under a spending category too (a
        // refund, cashback, etc. logged as plain income rather than a
        // reimbursement) — not just expenses. Confirmed via direct
        // testing that excluding it here was a real bug: the dashboard
        // stat nets that income against the category's spend (correctly
        // clamped at zero so a big refund can't drag the whole total
        // negative), but this screen's own total previously ignored it
        // completely, so tapping "Spent" could show a different number
        // than the tile you tapped.
        //
        // Confirmed via a SEPARATE real-app screenshot that the fix
        // above needs its own guard: income only belongs in this list
        // when it's actually filed under a specific non-savings
        // category (the thing whose total it's offsetting) — a plain
        // uncategorized transaction like a salary deposit has no
        // category at all, doesn't affect any category's total, and
        // was incorrectly showing up in this list before this guard.
        return thisPeriod.filter((t) => {
          const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
          if (t.isExpense) return !cat?.isSavingsCategory
          return !!cat && !cat.isSavingsCategory && !t.reimbursesExpenseId
        })
      case 'saved':
        return thisPeriod.filter((t) => {
          const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
          if (!cat?.isSavingsCategory) return false
          return t.isExpense || !t.reimbursesExpenseId
        })
      case 'income':
        // Also includes the EXCESS portion of an over-reimbursement (paid
        // back more than the expense cost) — confirmed via direct testing
        // this is counted in the dashboard's Income figure but was
        // previously invisible here, since the filter excluded every
        // reimbursement-linked transaction outright regardless of
        // whether part of it was genuine excess income.
        return thisPeriod.filter((t) => !t.isExpense && (!t.reimbursesExpenseId || excessForReimbursement(t, transactions) > 0))
      case 'reimbursed':
        return thisPeriod.filter((t) => !t.isExpense && t.reimbursesExpenseId)
    }
  }, [thisPeriod, kind, categories, transactions])

  // Computed the SAME way as the dashboard stat this screen was opened
  // from — reusing netSpentForCategory's per-category clamp directly,
  // rather than re-deriving a total from the transaction list above,
  // guarantees the two numbers can't drift apart the way they were
  // confirmed to before this fix.
  const total = useMemo(() => {
    if (kind === 'spent' || kind === 'saved') {
      const topLevel = categories.filter((c) => !c.parentId && (kind === 'saved') === c.isSavingsCategory)
      return topLevel.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, now)), 0)
    }
    if (kind === 'income') {
      const unlinkedIncome = thisPeriod.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)
      const excessFromLinked = thisPeriod.filter((t) => !t.isExpense && t.reimbursesExpenseId).reduce((sum, t) => sum + excessForReimbursement(t, transactions), 0)
      return unlinkedIncome + excessFromLinked
    }
    // reimbursed
    return scoped.reduce((sum, t) => {
      if (t.reimbursesExpenseId) {
        const excess = excessForReimbursement(t, transactions)
        return sum + (t.amount - excess)
      }
      return sum + netAmount(t, transactions)
    }, 0)
  }, [kind, categories, transactions, now, thisPeriod, scoped])

  // For the Income list specifically, a reimbursement-linked transaction
  // only appears here because part of it was excess (see the scoped
  // filter above) — showing the full repayment amount on its row would
  // overstate what it actually contributes to the total shown above,
  // confirmed via a real screenshot: a $130 repayment where only $30
  // was excess displayed as "+$130.00" right under a total that had
  // only added $30 of it, so the rows didn't add up to the header. Used
  // for both the row display and the "highest price" sort, so neither
  // one quietly disagrees with the other.
  function rowAmount(t: Transaction): number {
    if (kind === 'income' && t.reimbursesExpenseId) return excessForReimbursement(t, transactions)
    return netAmount(t, transactions)
  }

  const sorted = [...scoped].sort((a, b) =>
    sort === 'recent' ? b.date.localeCompare(a.date) : rowAmount(b) - rowAmount(a)
  )

  const catById = new Map(categories.map((c) => [c.id, c]))

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{TITLES[kind]}</h1>
        <SortMenuButton
          options={[{ value: 'recent', label: 'Newest First' }, { value: 'price', label: 'Highest Price First' }]}
          value={sort}
          onChange={setSort}
        />
      </div>

      <div className="card" style={{ marginBottom: 16, textAlign: 'center' }}>
        <span className="hero-label">{TITLES[kind]} this period</span>
        <div className="hero-amount amount" style={{ fontSize: 32 }}>{formatCurrency(total)}</div>
      </div>

      {sorted.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>Nothing here this period.</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {sorted.map((t, i) => {
          const cat = t.categoryId ? catById.get(t.categoryId) : undefined
          const isExcessOnlyRow = kind === 'income' && !!t.reimbursesExpenseId
          return (
            <button key={t.id} className="transaction-row" style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{t.note || cat?.name || 'Uncategorized'}</span>
                <span className="tx-category">{new Date(t.date).toLocaleDateString('en-AU')}{repaysNote(t, transactions, categories, accounts) && ` · ${repaysNote(t, transactions, categories, accounts)}`}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                {!isExcessOnlyRow && rowAmount(t) !== t.amount && (
                  <span className="amount" style={{ fontSize: 12, color: 'var(--text-faint)', textDecoration: 'line-through' }}>
                    {formatCurrency(t.amount)}
                  </span>
                )}
                <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                  {t.isExpense ? '-' : '+'}{formatCurrency(rowAmount(t))}
                </span>
                {isExcessOnlyRow && (
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>(of {formatCurrency(t.amount)} repayment)</span>
                )}
              </div>
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
          onChanged={onChanged}
        />
      )}
    </div>
  )
}
