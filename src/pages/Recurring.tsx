import { useMemo, useState } from 'react'
import type { Category, RecurringTransaction, Transaction } from '../types'
import { detectRecurring, frequencyLabel } from '../recurring'
import { formatCurrency } from '../calculations'
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
                <button className="list-button" style={{ flex: 1, textAlign: 'center', background: 'var(--green)', color: '#0B0D10', borderRadius: 8, padding: 8, fontWeight: 600 }} onClick={() => accept(s)}>Track as Recurring</button>
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
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14 }}>{item.note}</div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                {frequencyLabel(item.frequency)} · next {new Date(item.nextDueDate).toLocaleDateString('en-AU')}
              </div>
            </div>
            <span className="amount" style={{ fontSize: 14 }}>{formatCurrency(item.amount)}</span>
            <input type="checkbox" checked={item.isActive} onChange={() => toggleActive(item)} style={{ width: 18, height: 18 }} />
            <button onClick={() => remove(item.id)} style={{ color: 'var(--red)', fontSize: 12 }}>Delete</button>
          </div>
        )
      })}
    </div>
  )
}
