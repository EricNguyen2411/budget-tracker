import { useEffect, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency } from '../calculations'
import { learnMerchant, suggestCategoryId } from '../merchantRules'

interface Props {
  transaction: Transaction | null
  categories: Category[]
  allTransactions: Transaction[]
  onSave: (data: Omit<Transaction, 'id'>) => void
  onDelete?: () => void
  onClose: () => void
}

export default function TransactionEditor({ transaction, categories, allTransactions, onSave, onDelete, onClose }: Props) {
  const [amount, setAmount] = useState(transaction ? String(transaction.amount) : '')
  const [note, setNote] = useState(transaction?.note ?? '')
  const [date, setDate] = useState(transaction?.date.slice(0, 10) ?? new Date().toISOString().slice(0, 10))
  const [isExpense, setIsExpense] = useState(transaction?.isExpense ?? true)
  const [categoryId, setCategoryId] = useState<string | null>(transaction?.categoryId ?? null)
  const [reimbursesId, setReimbursesId] = useState<string | null>(transaction?.reimbursesExpenseId ?? null)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [showExpensePicker, setShowExpensePicker] = useState(false)

  const selectedCategory = categories.find((c) => c.id === categoryId)
  const reimbursedExpense = allTransactions.find((t) => t.id === reimbursesId)

  // Auto-suggest a category from past learning as the note is typed —
  // only for a brand-new transaction with nothing picked yet, so it
  // never overrides a deliberate manual choice.
  useEffect(() => {
    if (transaction || categoryId) return
    const suggested = suggestCategoryId(note)
    if (suggested) setCategoryId(suggested)
  }, [note])

  function handleSave() {
    const parsed = parseFloat(amount)
    if (isNaN(parsed) || parsed <= 0) return
    learnMerchant(note.trim(), categoryId)
    onSave({
      amount: parsed,
      note: note.trim(),
      date: new Date(date).toISOString(),
      isExpense,
      categoryId,
      reimbursesExpenseId: isExpense ? null : reimbursesId
    })
  }

  const expenseCandidates = allTransactions
    .filter((t) => t.isExpense && t.id !== transaction?.id)
    .sort((a, b) => {
      // nearest date to this transaction's date first
      const target = new Date(date).getTime()
      return Math.abs(new Date(a.date).getTime() - target) - Math.abs(new Date(b.date).getTime() - target)
    })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={onClose} className="text-button">Cancel</button>
          <span className="modal-title">{transaction ? 'Edit' : 'New Transaction'}</span>
          <button onClick={handleSave} className="text-button text-button-primary">Save</button>
        </div>

        <div className="modal-body">
          <div className="segmented">
            <button className={!isExpense ? '' : 'segmented-active'} onClick={() => setIsExpense(true)}>Expense</button>
            <button className={isExpense ? '' : 'segmented-active'} onClick={() => setIsExpense(false)}>Income</button>
          </div>

          <label className="field-label">Amount</label>
          <input
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="amount-input"
          />

          <label className="field-label">Note</label>
          <input type="text" placeholder="e.g. Coles, Netflix" value={note} onChange={(e) => setNote(e.target.value)} />

          <label className="field-label">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <label className="field-label">Category</label>
          <button className="picker-row" onClick={() => setShowCategoryPicker(true)}>
            <span>{selectedCategory ? `${selectedCategory.icon} ${selectedCategory.name}` : 'None'}</span>
            <span className="chevron">›</span>
          </button>

          {!isExpense && (
            <>
              <label className="field-label">Reimburses</label>
              <button className="picker-row" onClick={() => setShowExpensePicker(true)}>
                <span>{reimbursedExpense ? (reimbursedExpense.note || 'Untitled') : 'None (optional)'}</span>
                <span className="chevron">›</span>
              </button>
              {selectedCategory?.isSavingsCategory && (
                <p className="hint hint-warning">
                  Income in a savings category won't count toward Saved — that tracks money moving out to savings, logged as Expense.
                </p>
              )}
            </>
          )}

          {onDelete && (
            <button className="danger-button" onClick={onDelete}>Delete Transaction</button>
          )}
        </div>
      </div>

      {showCategoryPicker && (
        <div className="modal-backdrop" onClick={() => setShowCategoryPicker(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Category</span>
              <button onClick={() => setShowCategoryPicker(false)} className="text-button text-button-primary">Done</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => { setCategoryId(null); setShowCategoryPicker(false) }}>
                <span>None</span>
              </button>
              {categories.filter((c) => !c.parentId).map((c) => (
                <div key={c.id}>
                  <button className="picker-row" onClick={() => { setCategoryId(c.id); setShowCategoryPicker(false) }}>
                    <span>{c.icon} {c.name}</span>
                    {categoryId === c.id && <span style={{ color: 'var(--green)' }}>✓</span>}
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => { setCategoryId(s.id); setShowCategoryPicker(false) }}>
                      <span>{s.icon} {s.name}</span>
                      {categoryId === s.id && <span style={{ color: 'var(--green)' }}>✓</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showExpensePicker && (
        <div className="modal-backdrop" onClick={() => setShowExpensePicker(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Reimburses Which Expense?</span>
              <button onClick={() => setShowExpensePicker(false)} className="text-button text-button-primary">Done</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => { setReimbursesId(null); setShowExpensePicker(false) }}>
                <span>None</span>
              </button>
              {expenseCandidates.slice(0, 40).map((e) => (
                <button key={e.id} className="picker-row" onClick={() => { setReimbursesId(e.id); setShowExpensePicker(false) }}>
                  <span>{e.note || 'Untitled'} · {new Date(e.date).toLocaleDateString()}</span>
                  <span className="amount">{formatCurrency(e.amount)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
