import { useState } from 'react'
import type { Account, Transaction, Category } from '../types'
import { accountBalance, accountReconciliationDelta, calculateInterestEarned, formatCurrency, localDateInputValue } from '../calculations'
import { createTransaction } from '../db'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'
import TransactionEditor from '../components/TransactionEditor'

interface Props {
  account: Account
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onChanged: () => void
}

export default function AccountDetail({ account, categories, transactions, onBack, onSave, onDelete, onChanged }: Props) {
  useSwipeBack(onBack)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [showReconcile, setShowReconcile] = useState(false)
  const [showInterest, setShowInterest] = useState(false)

  const balance = accountBalance(account, transactions)
  const isDebt = account.type === 'credit_card'

  const own = transactions
    .filter((t) => t.accountId === account.id)
    .sort((a, b) => b.date.localeCompare(a.date))

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
        <h1 className="screen-title" style={{ fontSize: 20 }}>{account.icon} {account.name}</h1>
        <span style={{ width: 40 }} />
      </div>

      <div className="card hero-card" style={{ marginBottom: 16 }}>
        <span className="hero-label">{isDebt ? 'You Owe' : 'Balance'}</span>
        <span className="hero-amount amount" style={{ fontSize: 32, color: isDebt && balance > 0 ? 'var(--red)' : undefined }}>
          {formatCurrency(Math.abs(balance))}
        </span>
        <button onClick={() => setShowReconcile(true)} className="text-button" style={{ fontSize: 13, color: 'var(--blue)', marginTop: 8 }}>
          Doesn't match your bank? Fix it
        </button>
        {!!account.interestRate && (
          <button onClick={() => setShowInterest(true)} className="text-button" style={{ fontSize: 13, color: 'var(--blue)', marginTop: 4, display: 'block' }}>
            Add interest earned
          </button>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {own.length === 0 && (
          <p style={{ padding: 16, fontSize: 14, color: 'var(--text-dim)' }}>
            No transactions linked to this account yet — pick it on a transaction's edit screen to have it count here.
          </p>
        )}
        {own.map((t, i) => {
          const cat = t.categoryId ? categories.find((c) => c.id === t.categoryId) : null
          return (
            <button key={t.id} className="transaction-row" style={{ borderBottom: i < own.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{t.note || cat?.name || 'Uncategorized'}</span>
                <span className="tx-category">{new Date(t.date).toLocaleDateString('en-AU')}{cat ? ` · ${cat.name}` : ''}</span>
              </div>
              <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                {t.isExpense ? '-' : '+'}{formatCurrency(t.amount)}
              </span>
            </button>
          )
        })}
      </div>

      {showReconcile && (
        <ReconcileModal
          account={account}
          transactions={transactions}
          onClose={() => setShowReconcile(false)}
          onDone={() => { setShowReconcile(false); onChanged() }}
        />
      )}

      {showInterest && (
        <InterestModal
          account={account}
          transactions={transactions}
          onClose={() => setShowInterest(false)}
          onDone={() => { setShowInterest(false); onChanged() }}
        />
      )}
    </div>
  )
}

function InterestModal({ account, transactions, onClose, onDone }: { account: Account; transactions: Transaction[]; onClose: () => void; onDone: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  // Defaults to the last COMPLETE calendar month — the normal case for
  // a monthly-credited savings account, and safely in the past so the
  // preview isn't immediately truncated by the "can't accrue interest
  // for days that haven't happened yet" cap in calculateInterestEarned.
  const today = new Date()
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0)
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1)
  const [fromDate, setFromDate] = useState(localDateInputValue(lastMonthStart))
  const [toDate, setToDate] = useState(localDateInputValue(lastMonthEnd))

  const [y1, m1, d1] = fromDate.split('-').map(Number)
  const [y2, m2, d2] = toDate.split('-').map(Number)
  const periodStart = new Date(y1, m1 - 1, d1)
  const periodEnd = new Date(y2, m2 - 1, d2)
  const validRange = periodEnd >= periodStart
  const interestAmount = validRange ? calculateInterestEarned(account, transactions, periodStart, periodEnd) : 0

  async function handleConfirm() {
    if (interestAmount <= 0) return
    await createTransaction({
      amount: interestAmount,
      note: 'Interest earned',
      date: periodEnd.toISOString(),
      isExpense: false,
      categoryId: null,
      reimbursesExpenseId: null,
      tags: [],
      accountId: account.id
    })
    onDone()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Add Interest</span>
          <span style={{ width: 60 }} />
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12 }}>
            Calculated from your actual daily balance each day in this period, at {account.interestRate}% p.a. — not just today's balance, so a deposit or withdrawal partway through is already accounted for correctly.
          </p>
          <label className="field-label">From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <label className="field-label" style={{ marginTop: 12 }}>To</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />

          <div className="card hero-card" style={{ marginTop: 20 }}>
            <span className="hero-label">Interest Earned</span>
            <span className="hero-amount amount" style={{ fontSize: 28, color: 'var(--green)' }}>{formatCurrency(interestAmount)}</span>
          </div>
          {!validRange && (
            <p className="hint hint-warning" style={{ marginTop: 12 }}>The "To" date needs to be on or after the "From" date.</p>
          )}

          <button
            onClick={() => requestClose(handleConfirm)}
            disabled={interestAmount <= 0}
            style={{ width: '100%', textAlign: 'center', background: interestAmount > 0 ? 'var(--blue)' : 'var(--surface-2)', color: interestAmount > 0 ? '#FFFFFF' : 'var(--text-faint)', borderRadius: 10, padding: 12, fontWeight: 600, marginTop: 20 }}
          >
            Add {formatCurrency(interestAmount)} as Income
          </button>
        </div>
      </div>
    </div>
  )
}

function ReconcileModal({ account, transactions, onClose, onDone }: { account: Account; transactions: Transaction[]; onClose: () => void; onDone: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  const [realBalance, setRealBalance] = useState('')
  const isDebt = account.type === 'credit_card'
  const calculated = accountBalance(account, transactions)

  const parsed = parseFloat(realBalance)
  const preview = !isNaN(parsed) ? accountReconciliationDelta(account, transactions, parsed) : null

  async function handleConfirm() {
    if (isNaN(parsed) || !preview) return
    await createTransaction({
      amount: preview.amount,
      note: 'Balance adjustment',
      date: new Date().toISOString(),
      isExpense: preview.isExpense,
      categoryId: null,
      reimbursesExpenseId: null,
      tags: [],
      accountId: account.id
    })
    onDone()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Fix Balance</span>
          <span style={{ width: 60 }} />
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 12 }}>
            Currently showing {formatCurrency(Math.abs(calculated))}{isDebt ? ' owing' : ''} in the app. What does your bank app actually say{isDebt ? " you owe" : ''}?
          </p>
          <label className="field-label">{isDebt ? 'Real amount owing' : 'Real balance'}</label>
          <input type="number" inputMode="decimal" placeholder="0.00" value={realBalance} onChange={(e) => setRealBalance(e.target.value)} className="amount-input" autoFocus />

          {preview && (
            <div className="card" style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                This will add an {preview.isExpense ? 'expense' : 'income'} adjustment of <span className="amount">{formatCurrency(preview.amount)}</span> to bring the balance in line — everything else stays exactly as it is.
              </p>
            </div>
          )}
          {realBalance && !preview && (
            <p className="hint" style={{ marginTop: 12 }}>That already matches — nothing to adjust.</p>
          )}

          <button
            onClick={() => requestClose(handleConfirm)}
            disabled={!preview}
            style={{ width: '100%', textAlign: 'center', background: preview ? 'var(--blue)' : 'var(--surface-2)', color: preview ? '#FFFFFF' : 'var(--text-faint)', borderRadius: 10, padding: 12, fontWeight: 600, marginTop: 20 }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
