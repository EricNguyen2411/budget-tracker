import { useMemo, useState } from 'react'
import type { Category, RecurringTransaction, RecurrenceFrequency, Transaction } from '../types'
import { detectRecurring, frequencyLabel } from '../recurring'
import { formatCurrency, localDateInputValue } from '../calculations'
import { getSettings, updateSettings } from '../budgetPeriod'
import { createRecurring, saveRecurring, deleteRecurring } from '../db'
import SwipeableRow from '../components/SwipeableRow'
import { useModalClose } from '../useModalClose'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  onChanged: () => void
  onBack: () => void
}

export default function RecurringPage({ categories, transactions, recurring, onChanged, onBack }: Props) {
  useSwipeBack(onBack)
  const [dismissed, setDismissed] = useState(getSettings().dismissedRecurringSuggestions)
  const [editingItem, setEditingItem] = useState<RecurringTransaction | null>(null)
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  const suggestions = useMemo(
    () => detectRecurring(transactions, recurring, dismissed),
    [transactions, recurring, dismissed]
  )

  async function accept(s: ReturnType<typeof detectRecurring>[number]) {
    await createRecurring({
      amount: s.averageAmount,
      note: s.displayName,
      isExpense: s.isExpense,
      frequency: s.frequency,
      nextDueDate: s.suggestedNextDueDate.toISOString(),
      categoryId: s.categoryId,
      isActive: true
    })
    onChanged()
  }

  function dismiss(key: string) {
    const next = [...dismissed, key]
    setDismissed(next)
    updateSettings({ dismissedRecurringSuggestions: next })
  }

  async function toggleActive(item: RecurringTransaction) {
    await saveRecurring({ ...item, isActive: !item.isActive })
    onChanged()
  }

  async function remove(id: string) {
    await deleteRecurring(id)
    onChanged()
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Recurring</h1>
        <span style={{ width: 40 }} />
      </div>

      {suggestions.length > 0 && (
        <>
          <span className="section-heading">Looks Recurring</span>
          {suggestions.map((s) => (
            <div className="card" key={s.merchantKey} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{s.displayName}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                    {frequencyLabel(s.frequency)} · {s.occurrenceCount} times · avg {formatCurrency(s.averageAmount)}
                  </div>
                </div>
                <span className="amount" style={{ color: s.isExpense ? 'var(--text)' : 'var(--green)' }}>
                  {s.isExpense ? '-' : '+'}{formatCurrency(s.averageAmount)}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button className="list-button" style={{ flex: 1, textAlign: 'center', background: 'var(--surface-2)', borderRadius: 8, padding: 8 }} onClick={() => dismiss(s.merchantKey)}>Not Recurring</button>
                <button className="list-button" style={{ flex: 1, textAlign: 'center', background: 'var(--blue)', color: '#FFFFFF', borderRadius: 8, padding: 8, fontWeight: 600 }} onClick={() => accept(s)}>Track as Recurring</button>
              </div>
            </div>
          ))}
        </>
      )}

      <span className="section-heading">Your Recurring Items</span>
      {recurring.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>None yet — add rent, subscriptions, or a paycheck so you don't re-enter them every period.</p>}
      {recurring.map((item) => {
        const cat = item.categoryId ? catById.get(item.categoryId) : undefined
        return (
          <SwipeableRow key={item.id} onDelete={() => remove(item.id)} borderRadius={16}>
            <div className="card" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '🔁'}</div>
              <button style={{ flex: 1, textAlign: 'left' }} onClick={() => setEditingItem(item)}>
                <div style={{ fontSize: 14 }}>{item.note}</div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                  {frequencyLabel(item.frequency)} · next {new Date(item.nextDueDate).toLocaleDateString('en-AU')}
                </div>
              </button>
              <span className="amount" style={{ fontSize: 14 }}>{formatCurrency(item.amount)}</span>
              <input type="checkbox" switch checked={item.isActive} onChange={() => toggleActive(item)} style={{ width: 18, height: 18 }} />
            </div>
          </SwipeableRow>
        )
      })}

      {editingItem && (
        <RecurringEditor
          item={editingItem}
          categories={categories}
          onSave={async (data) => { await saveRecurring({ ...editingItem, ...data }); onChanged() }}
          onClose={() => setEditingItem(null)}
        />
      )}
    </div>
  )
}

function RecurringEditor({ item, categories, onSave, onClose }: {
  item: RecurringTransaction
  categories: Category[]
  onSave: (data: Partial<RecurringTransaction>) => void
  onClose: () => void
}) {
  const [note, setNote] = useState(item.note)
  const [amount, setAmount] = useState(String(item.amount))
  const [frequency, setFrequency] = useState<RecurrenceFrequency>(item.frequency)
  const [nextDueDate, setNextDueDate] = useState(localDateInputValue(new Date(item.nextDueDate)))
  const [categoryId, setCategoryId] = useState<string | null>(item.categoryId)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const category = categories.find((c) => c.id === categoryId)
  const { closing, requestClose } = useModalClose(onClose)
  const categoryPickerClose = useModalClose(() => setShowCategoryPicker(false))

  function handleSave() {
    const parsed = parseFloat(amount)
    if (isNaN(parsed) || parsed <= 0 || !note.trim()) return
    const [y, m, d] = nextDueDate.split('-').map(Number)
    onSave({
      note: note.trim(),
      amount: parsed,
      frequency,
      nextDueDate: new Date(y, m - 1, d).toISOString(),
      categoryId
    })
    requestClose()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Edit Recurring</span>
          <button onClick={handleSave} className="text-button text-button-primary">Save</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Note</label>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />

          <label className="field-label">Amount</label>
          <input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />

          <label className="field-label">Frequency</label>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as RecurrenceFrequency)}>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>

          <label className="field-label">Next Due Date</label>
          <input type="date" value={nextDueDate} onChange={(e) => setNextDueDate(e.target.value)} />

          <label className="field-label">Category</label>
          <button className="picker-row" onClick={() => setShowCategoryPicker(true)}>
            <span>{category ? `${category.icon} ${category.name}` : 'None'}</span>
            <span className="chevron">›</span>
          </button>
        </div>
      </div>

      {showCategoryPicker && (() => { const { closing: cc, requestClose: rcc } = categoryPickerClose
        function pick(id: string | null) { rcc(() => { setCategoryId(id); setShowCategoryPicker(false) }) }
        return (
        <div className={`modal-backdrop${cc ? ' modal-closing' : ''}`} onClick={() => rcc(() => setShowCategoryPicker(false))}>
          <div className={`modal-sheet${cc ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Category</span>
              <button onClick={() => rcc(() => setShowCategoryPicker(false))} className="text-button text-button-primary">Done</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => pick(null)}>
                <span>None</span>
              </button>
              {categories.filter((c) => !c.parentId).map((c) => (
                <div key={c.id}>
                  <button className="picker-row" onClick={() => pick(c.id)}>
                    <span>{c.icon} {c.name}</span>
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => pick(s.id)}>
                      <span>{s.icon} {s.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}
