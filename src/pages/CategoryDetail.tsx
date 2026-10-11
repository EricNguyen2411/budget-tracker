import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount, netSpentForCategory, effectiveBudget, repaysNote, isGoal, savingsBalance, goalProgress, goalProgressFraction, projectedGoalCompletionDate, localDateInputValue } from '../calculations'
import { contributeToSavings, withdrawFromSavings, setSavingsBalance, renewRecurringGoal } from '../db'
import { useModalClose } from '../useModalClose'
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
  onChanged: () => void
  onOpenTrend?: (category: Category) => void
}

export default function CategoryDetail({ category, allCategories, transactions, onBack, onSave, onDelete, onOpenCategory, onChanged, onOpenTrend }: Props) {
  useSwipeBack(onBack)
  const [showAllTime, setShowAllTime] = useState(false)
  const [sort, setSort] = useState<'recent' | 'price'>('recent')
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [savingsAction, setSavingsAction] = useState<SavingsActionMode | null>(null)
  const isSavings = !!category.isSavingsCategory

  const subcategories = allCategories.filter((c) => c.parentId === category.id)
  const categoryIds = new Set([category.id, ...subcategories.map((s) => s.id)])

  const relevant = useMemo(() => {
    const base = transactions.filter((t) => (t.categoryId && categoryIds.has(t.categoryId)) || (isSavings && t.fundedFromCategoryId === category.id))
    return showAllTime ? base : base.filter((t) => isInSamePeriod(new Date(t.date)))
  }, [transactions, showAllTime, category.id])

  const sorted = [...relevant].sort((a, b) =>
    sort === 'recent' ? b.date.localeCompare(a.date) : netAmount(b, transactions) - netAmount(a, transactions)
  )
  const budget = effectiveBudget(category, allCategories)
  // Exclusive (budget-relative) netAmount throughout this screen — the
  // "Spent this period" figure above and every row below must agree
  // with each other, and with netSpentForCategory's own logic (see
  // there for why savings draw-downs don't reduce this).
  const spent = Math.max(0, netSpentForCategory(category, allCategories, transactions, new Date()))

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

      {isSavings && (() => {
        const balance = savingsBalance(category, transactions)
        const goal = isGoal(category)
        const fraction = goalProgressFraction(category, transactions)
        const progress = goalProgress(category, transactions)
        const projected = goal && fraction < 1 ? projectedGoalCompletionDate(category, transactions) : null
        const needsRenewal = goal && !!category.goalRecurring && !!category.goalTargetDate && (fraction >= 1 || new Date(category.goalTargetDate) <= new Date())
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <span className="hero-label">Saved</span>
            <span className="hero-amount amount" style={{ fontSize: 32, display: 'block' }}>{formatCurrency(balance)}</span>
            {goal && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, margin: '12px 0 6px' }}>
                  <span>{fraction >= 1 ? 'Goal reached!' : `${Math.round(fraction * 100)}% of goal`}</span>
                  <span className="amount" style={{ color: 'var(--text-dim)' }}>{formatCurrency(progress)} / {formatCurrency(category.goalTargetAmount ?? 0)}</span>
                </div>
                <AnimatedProgressBar fraction={fraction} color={fraction >= 1 ? 'var(--green)' : category.color} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
                  <span>{category.goalTargetDate ? `Target ${new Date(category.goalTargetDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}` : 'No target date'}</span>
                  {projected && <span>On pace for ~{projected.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })}</span>}
                </div>
              </>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="list-button" style={{ flex: 1, color: 'var(--blue)', fontWeight: 600 }} onClick={() => setSavingsAction('add')}>＋ Add</button>
              <button className="list-button" style={{ flex: 1, color: 'var(--blue)', fontWeight: 600 }} onClick={() => setSavingsAction('withdraw')}>－ Take out</button>
            </div>
            <button className="text-button" style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 10 }} onClick={() => setSavingsAction('balance')}>
              Set balance…
            </button>
            {needsRenewal && (
              <button
                className="text-button"
                style={{ fontSize: 13, color: 'var(--blue)', marginTop: 6, display: 'block' }}
                onClick={async () => {
                  if (!confirm(`Renew ${category.name} for next year? The target date moves forward a year and progress tracking restarts fresh.`)) return
                  await renewRecurringGoal(category)
                  onChanged()
                }}
              >
                🔄 Renew for next year
              </button>
            )}
            <p className="hint" style={{ marginTop: 10 }}>
              The balance is what you've told the app — money added minus money taken out — not a live bank balance.
            </p>
          </div>
        )
      })()}

      {!isSavings && budget > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
            <span>Spent this period</span>
            <span className="amount" style={{ color: spent > budget ? 'var(--red)' : 'var(--text-dim)' }}>{formatCurrency(spent)} / {formatCurrency(budget)}</span>
          </div>
          <AnimatedProgressBar fraction={budget > 0 ? spent / budget : 0} color={spent > budget ? 'var(--red)' : category.color} />
          {onOpenTrend && (
            <button className="text-button" style={{ fontSize: 13, color: 'var(--blue)', marginTop: 10 }} onClick={() => onOpenTrend(category)}>
              📈 View 6-month trend
            </button>
          )}
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
        {sorted.map((t, i) => {
          // Only meaningful once this parent has subcategories at all —
          // otherwise every transaction here trivially belongs to
          // `category` itself and repeating its own icon on every row
          // would just be noise. When it IS filed under a specific
          // subcategory (not the parent directly), that subcategory's
          // own icon and name are shown instead of the parent's, so a
          // parent-level list actually says which bucket each row is in
          // rather than just "somewhere under here."
          const txCategory = t.categoryId ? allCategories.find((c) => c.id === t.categoryId) : null
          const isUnderSubcategory = subcategories.length > 0 && txCategory && txCategory.id !== category.id
          return (
            <button key={t.id} className="transaction-row" style={{ borderBottom: i < sorted.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => setEditing(t)}>
              {subcategories.length > 0 && (
                <div className="tx-icon" style={{ background: (txCategory ?? category).color + '33' }}>{(txCategory ?? category).icon}</div>
              )}
              <div className="tx-info">
                <span className="tx-note">{t.note || 'Uncategorized'}</span>
                <span className="tx-category">
                  {new Date(t.date).toLocaleDateString('en-AU')}
                  {isUnderSubcategory && ` · ${txCategory!.name}`}
                  {repaysNote(t, transactions, allCategories) && ` · ${repaysNote(t, transactions, allCategories)}`}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                {!isSavings && netAmount(t, transactions) !== t.amount && (
                  <span className="amount" style={{ fontSize: 12, color: 'var(--text-faint)', textDecoration: 'line-through' }}>
                    {formatCurrency(t.amount)}
                  </span>
                )}
                {isSavings ? (
                  // In a savings category the signs mean the opposite of
                  // spending: an expense-direction entry is money ADDED,
                  // an income-direction one is money taken out.
                  <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--green)' : 'var(--text)' }}>
                    {t.isExpense ? '+' : '−'}{formatCurrency(t.amount)}
                  </span>
                ) : (
                  <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                    {t.isExpense ? '-' : '+'}{formatCurrency(netAmount(t, transactions))}
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {savingsAction && (
        <SavingsActionModal
          mode={savingsAction}
          category={category}
          currentBalance={savingsBalance(category, transactions)}
          onClose={() => setSavingsAction(null)}
          onDone={() => { setSavingsAction(null); onChanged() }}
        />
      )}

      {editing && (
        <TransactionEditor
          transaction={editing}
          categories={allCategories}
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

type SavingsActionMode = 'add' | 'withdraw' | 'balance'

function SavingsActionModal({ mode, category, currentBalance, onClose, onDone }: {
  mode: SavingsActionMode
  category: Category
  currentBalance: number
  onClose: () => void
  onDone: () => void
}) {
  const { closing, requestClose } = useModalClose(onClose)
  const [amount, setAmount] = useState(mode === 'balance' ? currentBalance.toFixed(2) : '')
  const [date, setDate] = useState(localDateInputValue(new Date()))
  const [note, setNote] = useState('')
  const parsed = parseFloat(amount)
  const valid = mode === 'balance' ? !isNaN(parsed) : !isNaN(parsed) && parsed > 0

  async function handleSave() {
    if (!valid) return
    if (mode === 'balance') {
      await setSavingsBalance(category.id, parsed)
    } else {
      const [y, m, d] = date.split('-').map(Number)
      const iso = new Date(y, m - 1, d).toISOString()
      if (mode === 'add') await contributeToSavings({ categoryId: category.id, amount: parsed, date: iso, note })
      else await withdrawFromSavings({ categoryId: category.id, amount: parsed, date: iso, note })
    }
    requestClose(onDone)
  }

  const title = mode === 'add' ? `Add to ${category.name}` : mode === 'withdraw' ? `Take out of ${category.name}` : 'Set Balance'

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">{title}</span>
          <button onClick={handleSave} disabled={!valid} className="text-button text-button-primary">Save</button>
        </div>
        <div className="modal-body">
          <label className="field-label">{mode === 'balance' ? 'What you actually have' : 'Amount'}</label>
          <input type="number" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="amount-input" autoFocus />
          {mode !== 'balance' && (
            <>
              <label className="field-label">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <label className="field-label">Note (optional)</label>
              <input type="text" placeholder={mode === 'add' ? `Added to ${category.name}` : `Taken out of ${category.name}`} value={note} onChange={(e) => setNote(e.target.value)} />
            </>
          )}
          <p className="hint" style={{ marginTop: 12 }}>
            {mode === 'add' && 'Counts as money set aside — not as spending.'}
            {mode === 'withdraw' && 'Counts as money taken back out — not as income. To cover a specific expense, open the expense and use "Funded from Savings" instead.'}
            {mode === 'balance' && `Corrects the balance to match what you actually have (currently ${formatCurrency(currentBalance)}). This adjusts the starting balance — it never shows up as income, spending or a month's worth of saving.`}
          </p>
        </div>
      </div>
    </div>
  )
}
