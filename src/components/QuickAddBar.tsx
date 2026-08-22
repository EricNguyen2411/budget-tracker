import { useState } from 'react'
import type { Category } from '../types'
import { parseQuickAdd, type QuickAddResult } from '../quickAdd'
import { learnMerchant } from '../merchantRules'
import { createTransaction, deleteTransaction } from '../db'
import { formatCurrency } from '../calculations'

interface Props {
  categories: Category[]
  onChanged: () => void
}

export default function QuickAddBar({ categories, onChanged }: Props) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<QuickAddResult | null>(null)
  const [confirmation, setConfirmation] = useState<{ id: string; summary: string } | null>(null)
  const [attempted, setAttempted] = useState(false)

  const categoryById = new Map(categories.map((c) => [c.id, c]))

  function handleChange(value: string) {
    setText(value)
    setAttempted(false)
    setConfirmation(null)
    setPreview(value.trim() ? parseQuickAdd(value, categories) : null)
  }

  async function handleSubmit() {
    const parsed = preview ?? parseQuickAdd(text, categories)
    if (!parsed) { setAttempted(true); return }

    learnMerchant(parsed.note, parsed.categoryId)
    const created = await createTransaction({
      amount: parsed.amount,
      note: parsed.note,
      date: parsed.date,
      isExpense: parsed.isExpense,
      categoryId: parsed.categoryId,
      reimbursesExpenseId: null,
      tags: parsed.tags
    })
    onChanged()

    const cat = parsed.categoryId ? categoryById.get(parsed.categoryId) : undefined
    const summary = `${parsed.isExpense ? '-' : '+'}${formatCurrency(parsed.amount)}` +
      (parsed.note ? ` · ${parsed.note}` : '') +
      (cat ? ` · ${cat.icon} ${cat.name}` : '')
    setConfirmation({ id: created.id, summary })
    setText('')
    setPreview(null)
    setAttempted(false)
  }

  async function undo() {
    if (!confirmation) return
    await deleteTransaction(confirmation.id)
    onChanged()
    setConfirmation(null)
  }

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          placeholder="Quick add: spent 12 on coffee #worktrip"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
          style={{ flex: 1 }}
        />
        <button
          onClick={handleSubmit}
          style={{ padding: '0 16px', borderRadius: 10, background: 'var(--blue)', color: '#fff', fontWeight: 600, fontSize: 14 }}
        >
          Add
        </button>
      </div>

      {preview && (
        <p style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
          {preview.isExpense ? '−' : '+'}{formatCurrency(preview.amount)}
          {preview.note && ` · ${preview.note}`}
          {preview.categoryId && ` · ${categoryById.get(preview.categoryId)?.icon ?? ''} ${categoryById.get(preview.categoryId)?.name ?? ''}`}
          {preview.tags.length > 0 && ` · ${preview.tags.map((t) => `#${t}`).join(' ')}`}
        </p>
      )}

      {attempted && !preview && (
        <p className="hint hint-warning" style={{ marginTop: 6 }}>
          Couldn't find an amount in that — try including a number, e.g. "12 coffee".
        </p>
      )}

      {confirmation && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, fontSize: 13 }}>
          <span style={{ color: 'var(--green)' }}>Added {confirmation.summary}</span>
          <button onClick={undo} style={{ color: 'var(--blue)', fontWeight: 600 }}>Undo</button>
        </div>
      )}
    </div>
  )
}
