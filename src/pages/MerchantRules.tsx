import { useState } from 'react'
import type { Category } from '../types'
import { getAllMerchantRules, deleteMerchantRule } from '../merchantRules'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  onBack: () => void
}

export default function MerchantRules({ categories, onBack }: Props) {
  useSwipeBack(onBack)
  const [rules, setRules] = useState(getAllMerchantRules())
  const catById = new Map(categories.map((c) => [c.id, c]))

  function remove(key: string) {
    deleteMerchantRule(key)
    setRules(getAllMerchantRules())
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Learned Merchants</h1>
        <span style={{ width: 40 }} />
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
        Auto-suggests a category when you type a note matching one of these — built automatically as you categorize transactions. Beem is deliberately never learned, since it normalizes to the same generic key regardless of what a payment is actually for.
      </p>

      {rules.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>None learned yet.</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {rules.map((rule, i) => {
          const cat = catById.get(rule.categoryId)
          return (
            <div key={rule.key} className="transaction-row" style={{ borderBottom: i < rules.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
              <div className="tx-info">
                <span className="tx-note">{rule.key}</span>
                <span className="tx-category">→ {cat?.name ?? 'Unknown category'}</span>
              </div>
              <button onClick={() => remove(rule.key)} style={{ color: 'var(--red)', fontSize: 12 }}>Delete</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
