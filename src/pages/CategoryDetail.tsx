import { useMemo, useState } from 'react'
import type { Category, Transaction, Account } from '../types'
import { formatCurrency, netAmount, netSpentForCategory, effectiveBudget, isGoal, goalProgress, goalProgressFraction, projectedGoalCompletionDate, repaysNote } from '../calculations'
import { isInSamePeriod } from '../budgetPeriod'
import { migrateCategoryToAccount } from '../db'
import TransactionEditor from '../components/TransactionEditor'
import AnimatedProgressBar from '../components/AnimatedProgressBar'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'
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
  onOpenAccount?: (account: Account) => void
}

export default function CategoryDetail({ category, allCategories, transactions, onBack, onSave, onDelete, onOpenCategory, onChanged, onOpenAccount }: Props) {
  useSwipeBack(onBack)
  const [showAllTime, setShowAllTime] = useState(false)
  const [sort, setSort] = useState<'recent' | 'price'>('recent')
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [showMigrate, setShowMigrate] = useState(false)

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

      {/* An open-ended savings category (no target amount, like an
         ongoing "Travel Savings" pool rather than a goal with an end
         point) still has a real running balance — confirmed via testing
         this was previously shown nowhere at all, on this screen or the
         dashboard, even though the underlying number (contributions
         minus what's been drawn down, e.g. via Fund From Savings) was
         already being tracked correctly. */}
      {!goal && category.isSavingsCategory && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Total saved</span>
            <span className="amount" style={{ fontSize: 24, fontWeight: 700 }}>{formatCurrency(goalProgress(category, transactions))}</span>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            Every contribution counted, minus anything already drawn down (e.g. funded to an expense) — this is what's actually available to use.
          </p>
          <button onClick={() => setShowMigrate(true)} className="text-button" style={{ fontSize: 13, color: 'var(--blue)', marginTop: 8 }}>
            Migrate to an Account
          </button>
        </div>
      )}

      {!goal && budget > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
            <span>{category.isSavingsCategory ? 'Contributed this period' : 'Spent this period'}</span>
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
                {netAmount(t, transactions) !== t.amount && (
                  <span className="amount" style={{ fontSize: 12, color: 'var(--text-faint)', textDecoration: 'line-through' }}>
                    {formatCurrency(t.amount)}
                  </span>
                )}
                <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                  {t.isExpense ? '-' : '+'}{formatCurrency(netAmount(t, transactions))}
                </span>
              </div>
            </button>
          )
        })}
      </div>

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

      {showMigrate && (
        <MigrateToAccountModal
          category={category}
          currentBalance={goalProgress(category, transactions)}
          onClose={() => setShowMigrate(false)}
          onDone={(account) => { setShowMigrate(false); onChanged(); onOpenAccount?.(account) }}
        />
      )}
    </div>
  )
}

function MigrateToAccountModal({ category, currentBalance, onClose, onDone }: {
  category: Category
  currentBalance: number
  onClose: () => void
  onDone: (account: Account) => void
}) {
  const { closing, requestClose } = useModalClose(onClose)
  const [name, setName] = useState(category.name)
  const [icon, setIcon] = useState(category.icon)
  const canSave = name.trim().length > 0 && icon.trim().length > 0

  async function handleConfirm() {
    if (!canSave) return
    const account = await migrateCategoryToAccount(category.id, {
      name: name.trim(),
      icon: icon.trim(),
      color: category.color,
      type: 'savings',
      isArchived: false,
      sortOrder: 999
    })
    onDone(account)
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Migrate to Account</span>
          <span style={{ width: 60 }} />
        </div>
        <div className="modal-body">
          <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
            Creates a new account starting at <strong>{formatCurrency(currentBalance)}</strong> — this category's current balance. Every past transaction stays exactly as it is; nothing here gets deleted or rewritten. "{category.name}" just stops being offered as a savings source going forward, so future funding uses the account instead.
          </p>

          <label className="field-label">Account Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />

          <label className="field-label" style={{ marginTop: 12 }}>Icon (emoji)</label>
          <input type="text" value={icon} onChange={(e) => setIcon(e.target.value)} style={{ width: 80 }} />

          <div className="card" style={{ marginTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span style={{ color: 'var(--text-dim)' }}>Opening balance</span>
              <span className="amount">{formatCurrency(currentBalance)}</span>
            </div>
          </div>

          <button
            onClick={() => requestClose(handleConfirm)}
            disabled={!canSave}
            style={{ width: '100%', textAlign: 'center', background: canSave ? 'var(--blue)' : 'var(--surface-2)', color: canSave ? '#FFFFFF' : 'var(--text-faint)', borderRadius: 10, padding: 12, fontWeight: 600, marginTop: 20 }}
          >
            Migrate to Account
          </button>
        </div>
      </div>
    </div>
  )
}
