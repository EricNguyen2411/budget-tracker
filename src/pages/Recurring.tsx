import { useMemo, useState } from 'react'
import type { Category, RecurringTransaction, RecurrenceFrequency, Transaction } from '../types'
import { detectRecurring, frequencyLabel } from '../recurring'
import { formatCurrency, localDateInputValue } from '../calculations'
import { getSettings, updateSettings } from '../budgetPeriod'
import { createRecurring, saveRecurring, deleteRecurring } from '../db'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  onChanged: () => void
}

export default function RecurringPage({ categories, transactions, recurring, onChanged }: Props) {
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
      <h1 className="screen-title">Recurring</h1>

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
          <div className="card" key={item.id} style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '🔁'}</div>
            <button style={{ flex: 1, textAlign: 'left' }} onClick={() => setEditingItem(item)}>
              <div style={{ fontSize: 14 }}>{item.note}</div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {frequencyLabel(item.frequency)} · next {new Date(item.nextDueDate).toLocaleDateString('en-AU')}
              </div>
            </button>
            <span className="amount" style={{ fontSize: 14 }}>{formatCurrency(item.amount)}</span>
            <input type="checkbox" switch checked={item.isActive} onChange={() => toggleActive(item)} style={{ width: 18, height: 18 }} />
            <button onClick={() => remove(item.id)} style={{ color: 'var(--red)', fontSize: 12 }}>Delete</button>
          </div>
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
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={onClose} className="text-button">Cancel</button>
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
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => { setCategoryId(s.id); setShowCategoryPicker(false) }}>
                      <span>{s.icon} {s.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
