import { useMemo, useState } from 'react'
import type { Category, Transaction, Account } from '../types'
import { formatCurrency, netAmount, totalReimbursed, splitBulkReimbursement, goalProgress, reimbursementBreakdown, planSavingsGiveback, type SavingsGivebackPlan, isUnlinkedIncome } from '../calculations'
import { normalizeTag } from '../tags'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'
import { DonutChart } from '../components/Charts'
import TransactionEditor from '../components/TransactionEditor'
import { createTransaction, deleteTransaction, applySavingsGiveback } from '../db'

/** Simulates what the ledger looks like immediately after a giveback
 * plan is applied, without actually writing anything — used purely so
 * the "how much is still owed" calculation that drives this same
 * payment's own allocation preview sees the POST-giveback amounts, not
 * the stale pre-giveback ones, while the person is still just looking
 * at a preview and hasn't confirmed anything yet. */
/** Pure, in-memory simulation of what applySavingsGiveback (db.ts) will
 * actually write, used purely so the "how much is still owed"
 * calculation that drives this same payment's own allocation preview
 * sees the POST-giveback amounts, not the stale pre-giveback ones,
 * while the person is still just looking at a preview and hasn't
 * confirmed anything yet. Mirrors that function's own logic exactly —
 * a simple single-link transaction reduces or disappears outright,
 * while a shared (multiAllocations) transaction only has THIS expense's
 * own entry touched, collapsing to the simple shape once only one
 * allocation is left, or disappearing once none are. */
function applyGivebackPlan(transactions: Transaction[], plan: SavingsGivebackPlan | null): Transaction[] {
  if (!plan) return transactions
  let result = transactions
  for (const r of plan.reductions) {
    result = result
      .map((t) => {
        if (t.id !== r.transactionId) return t
        if (t.multiAllocations && t.multiAllocations.length > 0) {
          const remaining = t.multiAllocations
            .map((a) => a.expenseId === r.expenseId ? { ...a, amount: Math.round((a.amount - r.reduceBy) * 100) / 100 } : a)
            .filter((a) => a.amount > 0.01)
          if (remaining.length === 0) return null
          if (remaining.length === 1) return { ...t, multiAllocations: null, reimbursesExpenseId: remaining[0].expenseId, amount: remaining[0].amount }
          return { ...t, multiAllocations: remaining, amount: remaining.reduce((sum, a) => sum + a.amount, 0) }
        }
        const newAmount = Math.round((t.amount - r.reduceBy) * 100) / 100
        return newAmount <= 0.01 ? null : { ...t, amount: newAmount }
      })
      .filter((t): t is Transaction => t !== null)
  }
  return result
}

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
  const [viewingBreakdownSource, setViewingBreakdownSource] = useState<'savings' | 'others' | null>(null)
  const normalized = normalizeTag(tag)

  const tagged = useMemo(
    () => transactions.filter((t) => t.tags.some((tg) => normalizeTag(tg) === normalized)).sort((a, b) => b.date.localeCompare(a.date)),
    [transactions, normalized]
  )

  // Deliberately NOT netAmount's per-transaction netting — that nets
  // out every linked reimbursement regardless of source, savings and
  // friends alike, which isn't what "Spent on this tag" should mean.
  // Money funded from your own savings is still money you spent (it
  // came out of a balance you were tracking as yours); only a genuine
  // friend/other-party reimbursement should reduce what this tag "cost"
  // you. reimbursementBreakdown already keeps those two sources apart,
  // so total cost minus just the other-party share (equivalently,
  // outOfPocket + fundedFromSavings) is the right figure here.

  // Only worth its own section once there's actually something to
  // break down — a tag with no savings-funding or reimbursement at all
  // would just show three near-identical lines all equal to the total,
  // which explains nothing a person doesn't already see above.
  const breakdown = useMemo(
    () => reimbursementBreakdown(tagged.filter((t) => t.isExpense), transactions, categories),
    [tagged, transactions, categories]
  )
  const showBreakdown = breakdown.fundedFromSavings > 0.01 || breakdown.reimbursedByOthers > 0.01
  const expenseTotal = breakdown.outOfPocket + breakdown.fundedFromSavings
  const incomeTotal = tagged.filter((t) => isUnlinkedIncome(t)).reduce((sum, t) => sum + t.amount, 0)

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

      {showBreakdown && (
        <div className="card" style={{ marginBottom: 16 }}>
          <span className="section-heading">Where the Money Came From</span>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 14 }}>
            <span style={{ color: 'var(--text-dim)' }}>Total cost</span>
            <span className="amount">{formatCurrency(breakdown.totalCost)}</span>
          </div>
          {breakdown.fundedFromSavings > 0.01 && (
            <button
              onClick={() => setViewingBreakdownSource('savings')}
              style={{ display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'left', padding: '8px 0', fontSize: 14, borderTop: '1px solid var(--border)' }}
            >
              <span style={{ color: 'var(--text-dim)' }}>✈️ Funded from savings <span className="chevron">›</span></span>
              <span className="amount" style={{ color: 'var(--blue)' }}>−{formatCurrency(breakdown.fundedFromSavings)}</span>
            </button>
          )}
          {breakdown.reimbursedByOthers > 0.01 && (
            <button
              onClick={() => setViewingBreakdownSource('others')}
              style={{ display: 'flex', justifyContent: 'space-between', width: '100%', textAlign: 'left', padding: '8px 0', fontSize: 14, borderTop: '1px solid var(--border)' }}
            >
              <span style={{ color: 'var(--text-dim)' }}>Reimbursed by others <span className="chevron">›</span></span>
              <span className="amount" style={{ color: 'var(--green)' }}>−{formatCurrency(breakdown.reimbursedByOthers)}</span>
            </button>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: 15, fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4 }}>
            <span>Actually out of pocket</span>
            <span className="amount">{formatCurrency(breakdown.outOfPocket)}</span>
          </div>
        </div>
      )}

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
          allTaggedExpenses={tagged.filter((t) => t.isExpense)}
          transactions={transactions}
          categories={categories}
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
          accounts={accounts}
          onClose={() => setShowBulkFund(false)}
          onDone={() => { setShowBulkFund(false); onChanged() }}
        />
      )}

      {viewingBreakdownSource && (
        <BreakdownSourceModal
          source={viewingBreakdownSource}
          entries={viewingBreakdownSource === 'savings' ? breakdown.savingsTransactions : breakdown.otherTransactions}
          accounts={accounts}
          onClose={() => setViewingBreakdownSource(null)}
          onOpenTransaction={(t) => { setViewingBreakdownSource(null); setEditing(t) }}
        />
      )}
    </div>
  )
}

function BreakdownSourceModal({ source, entries, accounts, onClose, onOpenTransaction }: {
  source: 'savings' | 'others'
  entries: { transaction: Transaction; expense: Transaction; applied: number }[]
  accounts: Account[]
  onClose: () => void
  onOpenTransaction: (t: Transaction) => void
}) {
  const { closing, requestClose } = useModalClose(onClose)
  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ width: 60 }} />
          <span className="modal-title">{source === 'savings' ? 'Funded From Savings' : 'Reimbursed By Others'}</span>
          <button onClick={() => requestClose()} className="text-button text-button-primary">Done</button>
        </div>
        <div className="modal-body">
          <p className="hint" style={{ marginBottom: 12 }}>Tap any of these to open it directly.</p>
          {entries.map((entry, i) => {
            const account = entry.transaction.accountId ? accounts.find((a) => a.id === entry.transaction.accountId) : null
            return (
              <button
                key={entry.transaction.id + i}
                className="card"
                style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 8 }}
                onClick={() => requestClose(() => onOpenTransaction(entry.transaction))}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{entry.transaction.note || 'Income'}</span>
                  <span className="amount" style={{ color: 'var(--green)' }}>+{formatCurrency(entry.applied)}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
                  {new Date(entry.transaction.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })} · covers {entry.expense.note || 'expense'}
                  {account && <> · {account.icon} {account.name}</>}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function BulkFundModal({ tagLabel, outstandingExpenses, transactions, savingsCategories, accounts, onClose, onDone }: {
  tagLabel: string
  outstandingExpenses: Transaction[]
  transactions: Transaction[]
  savingsCategories: Category[]
  accounts: Account[]
  onClose: () => void
  onDone: () => void
}) {
  const { closing, requestClose } = useModalClose(onClose)
  const [categoryId, setCategoryId] = useState(savingsCategories[0]?.id ?? null)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const category = savingsCategories.find((c) => c.id === categoryId)
  const account = accounts.find((a) => a.id === accountId)

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
    // One transaction for the whole action, not one per expense it
    // happens to touch — confirmed directly this was the actual source
    // of the transaction list filling up with reimbursement entries.
    // Its own amount is kept as the sum of what it actually covers, so
    // every balance/account calculation that just reads a transaction's
    // amount normally continues to work without needing to know
    // anything about allocations.
    await createTransaction({
      amount: allocations.reduce((sum, a) => sum + a.amount, 0),
      note: allocations.length === 1
        ? `Re: ${outstandingExpenses.find((e) => e.id === allocations[0].expenseId)?.note || 'expense'}`
        : `${tagLabel} funded from ${category?.name ?? 'savings'}`,
      date: today,
      isExpense: false,
      categoryId,
      reimbursesExpenseId: allocations.length === 1 ? allocations[0].expenseId : null,
      multiAllocations: allocations.length > 1 ? allocations : null,
      tags: [],
      accountId
    })
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

          {accounts.length > 0 && (
            <>
              <label className="field-label" style={{ marginTop: savingsCategories.length > 1 ? 16 : 0 }}>Which Account</label>
              <button className="picker-row" onClick={() => setShowAccountPicker(true)}>
                <span>{account ? `${account.icon} ${account.name}` : 'None (optional)'}</span>
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

        {showAccountPicker && (
          <div className="modal-backdrop" onClick={() => setShowAccountPicker(false)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Which Account</span>
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

function BulkReimburseModal({ tagLabel, outstandingExpenses, allTaggedExpenses, transactions, categories, accounts, onClose, onDone }: {
  tagLabel: string
  outstandingExpenses: Transaction[]
  allTaggedExpenses: Transaction[]
  transactions: Transaction[]
  categories: Category[]
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
    .filter((t) => isUnlinkedIncome(t) && !t.tags.some((tg) => tg === tagLabel))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 20)

  const totalOwed = outstandingExpenses.reduce((sum, t) => sum + (t.amount - totalReimbursed(t, transactions)), 0)
  const parsed = existingTx ? existingTx.amount : parseFloat(amount)
  const validAmount = !isNaN(parsed) && parsed > 0

  // A payment bigger than what's currently owed doesn't necessarily
  // mean money left over — if this tag's expenses were already partly
  // funded from savings, a friend now covering more of the trip means
  // savings didn't need to cover as much after all. Worked out against
  // ALL of this tag's expenses (not just the still-outstanding ones),
  // since an expense already fully covered from savings is exactly
  // where money might need to be given back from.
  const givebackPlan = validAmount ? planSavingsGiveback(allTaggedExpenses, transactions, categories, parsed) : null

  // Once savings gives back what it no longer needs to cover, those
  // expenses are outstanding again for the purposes of THIS allocation
  // — recomputed from the full tagged set rather than the original
  // outstandingExpenses prop, which was computed before any giveback.
  const effectiveOutstanding = allTaggedExpenses.filter((e) => {
    const alreadyOwed = e.amount - totalReimbursed(e, transactions)
    const freedUp = givebackPlan?.reductions.some((r) => r.expenseId === e.id)
    return alreadyOwed > 0.01 || freedUp
  })

  const { allocations, leftover } = validAmount
    ? splitBulkReimbursement(effectiveOutstanding, applyGivebackPlan(transactions, givebackPlan), parsed)
    : { allocations: [] as { expenseId: string; amount: number }[], leftover: 0 }

  async function handleConfirm() {
    if (allocations.length === 0) return
    // Reuses the existing transaction's own date and account when
    // applying one already received, rather than "today" and whatever
    // account happens to be picked here — the payment already happened
    // on its own real date, through its own real account.
    const date = existingTx ? existingTx.date : new Date().toISOString()
    const linkAccountId = existingTx ? existingTx.accountId : accountId

    // Applied BEFORE creating the new allocations, so the reduced/
    // deleted savings transactions are already out of the way — giving
    // the freed-up amount back to Travel Savings first, then letting
    // the new payment claim what's now actually outstanding.
    if (givebackPlan && givebackPlan.reductions.length > 0) {
      await applySavingsGiveback(givebackPlan.reductions)
    }

    // One transaction covering everything this payment actually
    // settles, not one per expense — the leftover (genuinely unlinked
    // extra, beyond what was owed) stays as its own separate
    // transaction, since it isn't part of any expense's allocation and
    // folding it in would break the invariant that a multi-allocation
    // transaction's amount always equals the sum of its allocations.
    await createTransaction({
      amount: allocations.reduce((sum, a) => sum + a.amount, 0),
      note: allocations.length === 1
        ? `Re: ${effectiveOutstanding.find((e) => e.id === allocations[0].expenseId)?.note || 'expense'}`
        : `${tagLabel} reimbursement`,
      date,
      isExpense: false,
      categoryId: null,
      reimbursesExpenseId: allocations.length === 1 ? allocations[0].expenseId : null,
      multiAllocations: allocations.length > 1 ? allocations : null,
      tags: [],
      accountId: linkAccountId
    })
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
                <button onClick={() => { (document.activeElement as HTMLElement | null)?.blur(); setShowExistingPicker(true) }} className="text-button" style={{ fontSize: 13, color: 'var(--blue)', marginTop: 8 }}>
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

          {givebackPlan && givebackPlan.totalGivenBack > 0.01 && (
            <div className="card" style={{ marginTop: 16, borderLeft: '3px solid var(--blue)' }}>
              <span style={{ fontSize: 13, color: 'var(--blue)', fontWeight: 600 }}>
                ✈️ Also returns {formatCurrency(givebackPlan.totalGivenBack)} to savings
              </span>
              <p className="hint" style={{ marginTop: 6 }}>
                This payment covers more of the trip than was still owed — savings no longer needs to fund as much, so the difference goes back to where it came from.
              </p>
            </div>
          )}

          {allocations.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 8px' }}>Applied To</span>
              {allocations.map((a) => {
                const expense = effectiveOutstanding.find((e) => e.id === a.expenseId)
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
