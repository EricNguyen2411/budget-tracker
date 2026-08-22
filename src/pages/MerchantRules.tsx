import { useState } from 'react'
import type { Category } from '../types'
import { getAllMerchantRules, deleteMerchantRule, pinManualRule } from '../merchantRules'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'

interface Props {
  categories: Category[]
  onBack: () => void
}

export default function MerchantRules({ categories, onBack }: Props) {
  useSwipeBack(onBack)
  const [rules, setRules] = useState(getAllMerchantRules())
  const [showAdd, setShowAdd] = useState(false)
  const addClose = useModalClose(() => setShowAdd(false))
  const [newKeyword, setNewKeyword] = useState('')
  const [newCategoryId, setNewCategoryId] = useState<string | null>(null)
  const catById = new Map(categories.map((c) => [c.id, c]))

  function remove(key: string) {
    deleteMerchantRule(key)
    setRules(getAllMerchantRules())
  }

  function addRule() {
    if (!newKeyword.trim() || !newCategoryId) return
    pinManualRule(newKeyword.trim(), newCategoryId)
    setRules(getAllMerchantRules())
    setNewKeyword('')
    setNewCategoryId(null)
    setShowAdd(false)
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Learned Merchants</h1>
        <button onClick={() => setShowAdd(true)} className="text-button text-button-primary">Add</button>
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
        Auto-suggests a category when you type a note matching one of these — built automatically as you categorize transactions, or add one directly below. Beem is deliberately never learned, since it normalizes to the same generic key regardless of what a payment is actually for. A few common Australian merchants (Woolworths, Uber, Netflix, and similar) are suggested automatically even before anything's been learned.
      </p>

      {rules.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>None learned yet.</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {rules.map((rule, i) => {
          const cat = catById.get(rule.categoryId)
          const total = Object.values(rule.counts).reduce((a, b) => a + b, 0)
          return (
            <div key={rule.key} className="transaction-row" style={{ borderBottom: i < rules.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{rule.key}</span>
                <span className="tx-category">→ {cat?.name ?? 'Unknown category'} · seen {total} time{total === 1 ? '' : 's'}</span>
              </div>
              <button onClick={() => remove(rule.key)} style={{ color: 'var(--red)', fontSize: 12 }}>Delete</button>
            </div>
          )
        })}
      </div>

      {showAdd && (
        <div className={`modal-backdrop${addClose.closing ? ' modal-closing' : ''}`} onClick={() => addClose.requestClose()}>
          <div className={`modal-sheet${addClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <button className="text-button" onClick={() => addClose.requestClose()}>Cancel</button>
              <span className="modal-title">Add Rule</span>
              <button className="text-button text-button-primary" onClick={() => addClose.requestClose(addRule)}>Save</button>
            </div>
            <div className="modal-body">
              <label className="field-label">Keyword or merchant name</label>
              <input type="text" placeholder="e.g. Coles, gym membership" value={newKeyword} onChange={(e) => setNewKeyword(e.target.value)} />

              <label className="field-label" style={{ marginTop: 12 }}>Category</label>
              {categories.filter((c) => !c.parentId).map((c) => (
                <div key={c.id}>
                  <button className="picker-row" onClick={() => setNewCategoryId(c.id)}>
                    <span>{c.icon} {c.name}</span>
                    {newCategoryId === c.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => setNewCategoryId(s.id)}>
                      <span>{s.icon} {s.name}</span>
                      {newCategoryId === s.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
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
