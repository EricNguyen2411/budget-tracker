import { useMemo, useState } from 'react'
import type { Category, Transaction, Account } from '../types'
import { formatCurrency, netAmount, totalReimbursed, splitBulkReimbursement, goalProgress } from '../calculations'
import { normalizeTag } from '../tags'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'
import { DonutChart } from '../components/Charts'
import TransactionEditor from '../components/TransactionEditor'
import { createTransaction, deleteTransaction } from '../db'

interface Props {
  tag: string
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onViewInTransactions: () => void
  onChanged: () => void
  accounts?: Account[]
}

export default function TagDetail({ tag, categories, transactions, onBack, onSave, onDelete, onViewInTransactions, onChanged, accounts = [] }: Props) {
  useSwipeBack(onBack)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [showBulkReimburse, setShowBulkReimburse] = useState(false)
  const [showBulkFund, setShowBulkFund] = useState(false)
  const normalized = normalizeTag(tag)

  const tagged = useMemo(
    () => transactions.filter((t) => t.tags.some((tg) => normalizeTag(tg) === normalized)).sort((a, b) => b.date.localeCompare(a.date)),
    [transactions, normalized]
  )

  const expenseTotal = tagged.filter((t) => t.isExpense).reduce((sum, t) => sum + netAmount(t, transactions), 0)
  const incomeTotal = tagged.filter((t) => !t.isExpense && !t.reimbursesExpenseId).reduce((sum, t) => sum + t.amount, 0)

  // Every tagged expense that isn't yet fully paid back — sorted oldest
  // first, matching splitBulkReimbursement's own allocation order, so
  // the preview shown while entering an amount lines up with what
  // confirming it will actually do.
  const outstandingExpenses = useMemo(
    () => tagged.filter((t) => t.isExpense && t.amount - totalReimbursed(t, transactions) > 0.01).sort((a, b) => a.date.localeCompare(b.date)),
    [tagged, transactions]
  )
  const totalOwed = outstandingExpenses.reduce((sum, t) => sum + (t.amount - totalReimbursed(t, transactions)), 0)

  // Savings categories with an actual balance to draw from — a category
  // sitting at $0 isn't a useful funding source to offer.
  const availableSavingsCategories = useMemo(
    () => categories.filter((c) => c.isSavingsCategory && !c.parentId && goalProgress(c, transactions) > 0.01),
    [categories, transactions]
  )

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
        <h1 className="screen-title" style={{ fontSize: 20 }}>🏷️ {normalized}</h1>
        <button onClick={onViewInTransactions} className="text-button" style={{ fontSize: 13 }}>List</button>
      </div>

      <div className="card hero-card" style={{ marginBottom: 16 }}>
        <span className="hero-label">Spent on "{normalized}"</span>
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
        {totalOwed > 0.01 && (
          <button onClick={() => setShowBulkReimburse(true)} className="text-button" style={{ fontSize: 13, color: 'var(--blue)', marginTop: 8, display: 'block' }}>
            {formatCurrency(totalOwed)} still owed — record one payment for it
          </button>
        )}
        {availableSavingsCategories.length > 0 && outstandingExpenses.length > 0 && (
          <button onClick={() => setShowBulkFund(true)} className="text-button" style={{ fontSize: 13, color: 'var(--green)', marginTop: 4, display: 'block' }}>
            Fund as much of this as possible from savings
          </button>
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
          const net = netAmount(t, transactions)
          // A tag total should still show what a trip or event actually
          // cost, even for a transaction fully paid down by savings —
          // net is correctly $0.00 for Safe to Spend purposes, but that
          // alone hides the real amount from a screen that's meant to
          // answer "how much did this cost," so the original amount is
          // shown alongside whenever the two differ.
          const wasReduced = t.isExpense && net !== t.amount
          return (
            <button key={t.id} className="transaction-row" style={{ borderBottom: i < tagged.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{t.note || 'Uncategorized'}</span>
                <span className="tx-category">{formatDate(t.date)}{cat ? ` · ${cat.name}` : ''}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                  {t.isExpense ? '-' : '+'}{formatCurrency(net)}
                </span>
                {wasReduced && (
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>(was {formatCurrency(t.amount)})</span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {showBulkReimburse && (
        <BulkReimburseModal
          tagLabel={normalized}
          outstandingExpenses={outstandingExpenses}
          transactions={transactions}
          accounts={accounts}
          onClose={() => setShowBulkReimburse(false)}
          onDone={() => { setShowBulkReimburse(false); onChanged() }}
        />
      )}

      {showBulkFund && (
        <BulkFundModal
          tagLabel={normalized}
          outstandingExpenses={outstandingExpenses}
          transactions={transactions}
          savingsCategories={availableSavingsCategories}
          onClose={() => setShowBulkFund(false)}
          onDone={() => { setShowBulkFund(false); onChanged() }}
        />
      )}
    </div>
  )
}

function BulkFundModal({ tagLabel, outstandingExpenses, transactions, savingsCategories, onClose, onDone }: {
  tagLabel: string
  outstandingExpenses: Transaction[]
  transactions: Transaction[]
  savingsCategories: Category[]
  onClose: () => void
  onDone: () => void
}) {
  const { closing, requestClose } = useModalClose(onClose)
  const [categoryId, setCategoryId] = useState(savingsCategories[0]?.id ?? null)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const category = savingsCategories.find((c) => c.id === categoryId)

  const available = category ? goalProgress(category, transactions) : 0
  const totalOwed = outstandingExpenses.reduce((sum, t) => sum + (t.amount - totalReimbursed(t, transactions)), 0)
  const amountToUse = Math.min(available, totalOwed)
  const { allocations } = amountToUse > 0
    ? splitBulkReimbursement(outstandingExpenses, transactions, amountToUse)
    : { allocations: [] as { expenseId: string; amount: number }[] }
  const remainingAfter = Math.max(0, totalOwed - amountToUse)

  async function handleConfirm() {
    if (allocations.length === 0 || !categoryId) return
    const today = new Date().toISOString()
    for (const a of allocations) {
      const expense = outstandingExpenses.find((e) => e.id === a.expenseId)
      await createTransaction({
        amount: a.amount,
        note: `Re: ${expense?.note || 'expense'}`,
        date: today,
        isExpense: false,
        categoryId,
        reimbursesExpenseId: a.expenseId,
        tags: [],
        accountId: null
      })
    }
    onDone()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Fund from Savings</span>
          <span style={{ width: 60 }} />
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12 }}>
            Covers as much of "{tagLabel}" as {category ? `${category.icon} ${category.name}` : 'this category'}'s balance allows, oldest expense first — whatever's left over stays as genuine spending from wherever you actually paid.
          </p>

          {savingsCategories.length > 1 && (
            <>
              <label className="field-label">From</label>
              <button className="picker-row" onClick={() => setShowCategoryPicker(true)}>
                <span>{category ? `${category.icon} ${category.name}` : 'Choose a category'}</span>
                <span className="chevron">›</span>
              </button>
            </>
          )}

          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
              <span style={{ color: 'var(--text-dim)' }}>Available in {category?.name ?? 'savings'}</span>
              <span className="amount">{formatCurrency(available)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
              <span style={{ color: 'var(--text-dim)' }}>Total still owed on "{tagLabel}"</span>
              <span className="amount">{formatCurrency(totalOwed)}</span>
            </div>
          </div>

          {allocations.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <span className="section-heading" style={{ margin: '0 0 8px' }}>Will Be Funded</span>
              {allocations.map((a) => {
                const expense = outstandingExpenses.find((e) => e.id === a.expenseId)
                return (
                  <div key={a.expenseId} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                    <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{expense?.note || 'Expense'}</span>
                    <span className="amount">{formatCurrency(a.amount)}</span>
                  </div>
                )
              })}
              {remainingAfter > 0.01 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, marginTop: 4, borderTop: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--text-dim)' }}>Still genuinely owed after this (savings ran out)</span>
                  <span className="amount">{formatCurrency(remainingAfter)}</span>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => requestClose(handleConfirm)}
            disabled={allocations.length === 0}
            style={{ width: '100%', textAlign: 'center', background: allocations.length > 0 ? 'var(--green)' : 'var(--surface-2)', color: allocations.length > 0 ? '#FFFFFF' : 'var(--text-faint)', borderRadius: 10, padding: 12, fontWeight: 600, marginTop: 20 }}
          >
            Fund {formatCurrency(amountToUse)} from Savings
          </button>
        </div>

        {showCategoryPicker && (
          <div className="modal-backdrop" onClick={() => setShowCategoryPicker(false)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Fund From</span>
                <button onClick={() => setShowCategoryPicker(false)} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                {savingsCategories.map((c) => (
                  <button key={c.id} className="picker-row" onClick={() => { setCategoryId(c.id); setShowCategoryPicker(false) }}>
                    <span>{c.icon} {c.name}</span>
                    {categoryId === c.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function BulkReimburseModal({ tagLabel, outstandingExpenses, transactions, accounts, onClose, onDone }: {
  tagLabel: string
  outstandingExpenses: Transaction[]
  transactions: Transaction[]
  accounts: Account[]
  onClose: () => void
  onDone: () => void
}) {
  const { closing, requestClose } = useModalClose(onClose)
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState<string | null>(null)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const [showExistingPicker, setShowExistingPicker] = useState(false)
  const [existingTxId, setExistingTxId] = useState<string | null>(null)
  const account = accounts.find((a) => a.id === accountId)
  const existingTx = transactions.find((t) => t.id === existingTxId)

  // Real income already sitting in the ledger — a bank transfer someone
  // sent you, imported or entered separately from this tag — that
  // hasn't been linked to anything yet. Deliberately excludes anything
  // that's already tagged with THIS tag, since that's almost always the
  // income side of a link this exact flow already created, not a fresh
  // payment waiting to be applied.
  const candidateTransactions = transactions
    .filter((t) => !t.isExpense && !t.reimbursesExpenseId && !t.tags.some((tg) => tg === tagLabel))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 20)

  const totalOwed = outstandingExpenses.reduce((sum, t) => sum + (t.amount - totalReimbursed(t, transactions)), 0)
  const parsed = existingTx ? existingTx.amount : parseFloat(amount)
  const { allocations, leftover } = !isNaN(parsed) && parsed > 0
    ? splitBulkReimbursement(outstandingExpenses, transactions, parsed)
    : { allocations: [] as { expenseId: string; amount: number }[], leftover: 0 }

  async function handleConfirm() {
    if (allocations.length === 0) return
    // Reuses the existing transaction's own date and account when
    // applying one already received, rather than "today" and whatever
    // account happens to be picked here — the payment already happened
    // on its own real date, through its own real account.
    const date = existingTx ? existingTx.date : new Date().toISOString()
    const linkAccountId = existingTx ? existingTx.accountId : accountId
    for (const a of allocations) {
      const expense = outstandingExpenses.find((e) => e.id === a.expenseId)
      await createTransaction({
        amount: a.amount,
        note: `Re: ${expense?.note || 'expense'}`,
        date,
        isExpense: false,
        categoryId: null,
        reimbursesExpenseId: a.expenseId,
        tags: [],
        accountId: linkAccountId
      })
    }
    if (leftover > 0.01) {
      await createTransaction({
        amount: leftover,
        note: `${tagLabel} reimbursement (extra)`,
        date,
        isExpense: false,
        categoryId: null,
        reimbursesExpenseId: null,
        tags: [tagLabel],
        accountId: linkAccountId
      })
    }
    // The original transaction's amount has now been fully accounted
    // for by the split allocations above — keeping it around too would
    // double-count the same money as income twice.
    if (existingTx) await deleteTransaction(existingTx.id)
    onDone()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Record Payment</span>
          <span style={{ width: 60 }} />
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12 }}>
            {formatCurrency(totalOwed)} is still owed across {outstandingExpenses.length} expense{outstandingExpenses.length === 1 ? '' : 's'} tagged "{tagLabel}". Enter what actually came in as one payment — it'll be split across them automatically, oldest first.
          </p>
          <label className="field-label">Amount Received</label>
          {existingTx ? (
            <button className="picker-row" onClick={() => setExistingTxId(null)}>
              <span>{existingTx.note || 'Income'} — {formatCurrency(existingTx.amount)} · tap to use a different amount instead</span>
            </button>
          ) : (
            <>
              <input type="number" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="amount-input" autoFocus />
              {candidateTransactions.length > 0 && (
                <button onClick={() => setShowExistingPicker(true)} className="text-button" style={{ fontSize: 13, color: 'var(--blue)', marginTop: 8 }}>
                  Already received this? Use an existing transaction instead
                </button>
              )}
            </>
          )}

          {accounts.length > 0 && !existingTx && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>Account</label>
              <button className="picker-row" onClick={() => setShowAccountPicker(true)}>
                <span>{account ? `${account.icon} ${account.name}` : 'None (optional)'}</span>
                <span className="chevron">›</span>
              </button>
            </>
          )}

          {allocations.length > 0 && (
            <div className="card" style={{ marginTop: 20 }}>
              <span className="section-heading" style={{ margin: '0 0 8px' }}>Applied To</span>
              {allocations.map((a) => {
                const expense = outstandingExpenses.find((e) => e.id === a.expenseId)
                return (
                  <div key={a.expenseId} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                    <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{expense?.note || 'Expense'}</span>
                    <span className="amount">{formatCurrency(a.amount)}</span>
                  </div>
                )
              })}
              {leftover > 0.01 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13, marginTop: 4, borderTop: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--text-dim)' }}>Extra (more than was owed)</span>
                  <span className="amount">{formatCurrency(leftover)}</span>
                </div>
              )}
            </div>
          )}

          <button
            onClick={() => requestClose(handleConfirm)}
            disabled={allocations.length === 0}
            style={{ width: '100%', textAlign: 'center', background: allocations.length > 0 ? 'var(--blue)' : 'var(--surface-2)', color: allocations.length > 0 ? '#FFFFFF' : 'var(--text-faint)', borderRadius: 10, padding: 12, fontWeight: 600, marginTop: 20 }}
          >
            {existingTx ? 'Apply to This Tag' : 'Record Payment'}
          </button>
        </div>

        {showExistingPicker && (
          <div className="modal-backdrop" onClick={() => setShowExistingPicker(false)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Use Existing Transaction</span>
                <button onClick={() => setShowExistingPicker(false)} className="text-button text-button-primary">Cancel</button>
              </div>
              <div className="modal-body">
                <p className="hint" style={{ marginBottom: 12 }}>Its own date and account carry over — it'll be replaced with the split amounts below rather than counted twice.</p>
                {candidateTransactions.map((t) => (
                  <button key={t.id} className="picker-row" onClick={() => { setExistingTxId(t.id); setShowExistingPicker(false) }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>{t.note || 'Income'} · {new Date(t.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                    <span className="amount" style={{ color: 'var(--green)' }}>+{formatCurrency(t.amount)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {showAccountPicker && (
          <div className="modal-backdrop" onClick={() => setShowAccountPicker(false)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Account</span>
                <button onClick={() => setShowAccountPicker(false)} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                <button className="picker-row" onClick={() => { setAccountId(null); setShowAccountPicker(false) }}>
                  <span>None (optional)</span>
                  {!accountId && <span style={{ color: 'var(--blue)' }}>✓</span>}
                </button>
                {accounts.map((a) => (
                  <button key={a.id} className="picker-row" onClick={() => { setAccountId(a.id); setShowAccountPicker(false) }}>
                    <span>{a.icon} {a.name}</span>
                    {accountId === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
