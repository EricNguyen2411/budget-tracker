import { useEffect, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, localDateInputValue } from '../calculations'
import { learnMerchant, suggestCategoryId } from '../merchantRules'
import { allTagsFrom, dedupeTags, normalizeTag } from '../tags'
import { useModalClose } from '../useModalClose'

interface Props {
  transaction: Transaction | null
  categories: Category[]
  allTransactions: Transaction[]
  onSave: (data: Omit<Transaction, 'id'>) => void
  onDelete?: () => void
  onClose: () => void
}

export default function TransactionEditor({ transaction, categories, allTransactions, onSave, onDelete, onClose }: Props) {
  const { closing, requestClose } = useModalClose(onClose)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [showExpensePicker, setShowExpensePicker] = useState(false)
  const categoryPickerClose = useModalClose(() => setShowCategoryPicker(false))
  const expensePickerClose = useModalClose(() => setShowExpensePicker(false))
  const [amount, setAmount] = useState(transaction ? String(transaction.amount) : '')
  const [note, setNote] = useState(transaction?.note ?? '')
  const [date, setDate] = useState(transaction ? localDateInputValue(new Date(transaction.date)) : localDateInputValue(new Date()))
  const [isExpense, setIsExpense] = useState(transaction?.isExpense ?? true)
  const [categoryId, setCategoryId] = useState<string | null>(transaction?.categoryId ?? null)
  const [reimbursesId, setReimbursesId] = useState<string | null>(transaction?.reimbursesExpenseId ?? null)
  const [tags, setTags] = useState<string[]>(transaction?.tags ?? [])
  const [tagInput, setTagInput] = useState('')

  const existingTags = allTagsFrom(allTransactions)

  const selectedCategory = categories.find((c) => c.id === categoryId)
  const reimbursedExpense = allTransactions.find((t) => t.id === reimbursesId)

  // Auto-suggest a category from past learning as the note is typed —
  // only for a brand-new transaction with nothing picked yet, so it
  // never overrides a deliberate manual choice.
  useEffect(() => {
    if (transaction || categoryId) return
    const suggested = suggestCategoryId(note, categories)
    if (suggested) setCategoryId(suggested)
  }, [note])

  // A reimbursement should always carry the same category as the
  // expense it's repaying — that's what makes "how much did Groceries
  // actually cost me" come out right. This runs whenever the link
  // changes, not just once, so re-linking to a different expense keeps
  // the category in sync rather than leaving a stale one behind.
  useEffect(() => {
    if (isExpense || !reimbursedExpense) return
    if (reimbursedExpense.categoryId) setCategoryId(reimbursedExpense.categoryId)
  }, [reimbursesId])

  function addTag(raw: string) {
    const norm = normalizeTag(raw)
    if (!norm) return
    setTags((prev) => dedupeTags([...prev, norm]))
    setTagInput('')
  }

  function removeTag(tag: string) {
    setTags((prev) => prev.filter((t) => t !== tag))
  }

  function handleSave() {
    const parsed = parseFloat(amount)
    if (isNaN(parsed) || parsed <= 0) return
    learnMerchant(note.trim(), categoryId)
    onSave({
      amount: parsed,
      note: note.trim(),
      date: (() => {
        const [y, m, d] = date.split('-').map(Number)
        return new Date(y, m - 1, d).toISOString()
      })(),
      isExpense,
      categoryId,
      reimbursesExpenseId: isExpense ? null : reimbursesId,
      tags: dedupeTags(tags)
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
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">{transaction ? 'Edit' : 'New Transaction'}</span>
          <button onClick={() => requestClose(handleSave)} className="text-button text-button-primary">Save</button>
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
          <input type="text" placeholder="e.g. Coles, Netflix" value={note} onChange={(e) => setNote(e.target.value)} list="note-suggestions" />
          <datalist id="note-suggestions">
            {(() => {
              const seen = new Set<string>()
              const recent: string[] = []
              for (const t of [...allTransactions].sort((a, b) => b.date.localeCompare(a.date))) {
                const n = t.note.trim()
                if (n && !seen.has(n)) { seen.add(n); recent.push(n) }
                if (recent.length >= 20) break
              }
              return recent.map((n) => <option key={n} value={n} />)
            })()}
          </datalist>

          <label className="field-label">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <label className="field-label">Category</label>
          <button className="picker-row" onClick={() => setShowCategoryPicker(true)}>
            <span>{selectedCategory ? `${selectedCategory.icon} ${selectedCategory.name}` : 'None'}</span>
            <span className="chevron">›</span>
          </button>

          <label className="field-label">Tags</label>
          {tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {tags.map((t) => (
                <span
                  key={t}
                  style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, padding: '5px 10px', borderRadius: 14, background: 'var(--surface-2)', color: 'var(--purple)' }}
                >
                  #{t}
                  <button onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`} style={{ fontSize: 14, lineHeight: 1, color: 'var(--text-dim)' }}>×</button>
                </span>
              ))}
            </div>
          )}
          <input
            type="text"
            placeholder="Add a tag, e.g. work trip"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                addTag(tagInput)
              } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
                removeTag(tags[tags.length - 1])
              }
            }}
            list="tag-suggestions"
          />
          <datalist id="tag-suggestions">
            {existingTags.filter((t) => !tags.includes(t)).map((t) => <option key={t} value={t} />)}
          </datalist>
          {tagInput.trim() && (
            <button className="text-button" style={{ fontSize: 12, color: 'var(--blue)', marginTop: 4 }} onClick={() => addTag(tagInput)}>
              Add "{normalizeTag(tagInput)}"
            </button>
          )}

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

      {showCategoryPicker && (() => {
        const { closing: catClosing, requestClose: requestCatClose } = categoryPickerClose
        function selectCategory(id: string | null) {
          requestCatClose(() => { setCategoryId(id); setShowCategoryPicker(false) })
        }
        return (
          <div className={`modal-backdrop${catClosing ? ' modal-closing' : ''}`} onClick={() => requestCatClose(() => setShowCategoryPicker(false))}>
            <div className={`modal-sheet${catClosing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Category</span>
                <button onClick={() => requestCatClose(() => setShowCategoryPicker(false))} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                {(() => {
                  const recentIds: string[] = []
                  for (const t of [...allTransactions].sort((a, b) => b.date.localeCompare(a.date))) {
                    if (t.categoryId && !recentIds.includes(t.categoryId) && t.categoryId !== categoryId) recentIds.push(t.categoryId)
                    if (recentIds.length >= 6) break
                  }
                  const recentCategories = recentIds.map((id) => categories.find((c) => c.id === id)).filter((c): c is Category => !!c)
                  if (recentCategories.length === 0) return null
                  return (
                    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16, paddingBottom: 2 }}>
                      {recentCategories.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => selectCategory(c.id)}
                          style={{ whiteSpace: 'nowrap', fontSize: 13, padding: '6px 14px', borderRadius: 16, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 5 }}
                        >
                          <span>{c.icon}</span><span>{c.name}</span>
                        </button>
                      ))}
                    </div>
                  )
                })()}
                <button className="picker-row" onClick={() => selectCategory(null)}>
                  <span>None</span>
                </button>
                {categories.filter((c) => !c.parentId).map((c) => (
                  <div key={c.id}>
                    <button className="picker-row" onClick={() => selectCategory(c.id)}>
                      <span>{c.icon} {c.name}</span>
                      {categoryId === c.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                    </button>
                    {categories.filter((s) => s.parentId === c.id).map((s) => (
                      <button key={s.id} className="picker-row picker-row-sub" onClick={() => selectCategory(s.id)}>
                        <span>{s.icon} {s.name}</span>
                        {categoryId === s.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {showExpensePicker && (() => {
        const { closing: expClosing, requestClose: requestExpClose } = expensePickerClose
        function selectExpense(id: string | null) {
          requestExpClose(() => { setReimbursesId(id); setShowExpensePicker(false) })
        }
        return (
          <div className={`modal-backdrop${expClosing ? ' modal-closing' : ''}`} onClick={() => requestExpClose(() => setShowExpensePicker(false))}>
            <div className={`modal-sheet${expClosing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Reimburses Which Expense?</span>
                <button onClick={() => requestExpClose(() => setShowExpensePicker(false))} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                <button className="picker-row" onClick={() => selectExpense(null)}>
                  <span>None</span>
                </button>
                {expenseCandidates.slice(0, 40).map((e) => (
                  <button key={e.id} className="picker-row" onClick={() => selectExpense(e.id)}>
                    <span>{e.note || 'Untitled'} · {new Date(e.date).toLocaleDateString()}</span>
                    <span className="amount">{formatCurrency(e.amount)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
