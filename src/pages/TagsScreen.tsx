import { useMemo } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency } from '../calculations'
import { normalizeTag } from '../tags'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onOpenTag: (tag: string) => void
}

interface TagSummary {
  tag: string
  count: number
  expenseTotal: number
  incomeTotal: number
  lastUsed: string
}

export default function TagsScreen({ transactions, onBack, onOpenTag }: Props) {
  useSwipeBack(onBack)

  const summaries = useMemo(() => {
    const byTag = new Map<string, TagSummary>()
    for (const t of transactions) {
      for (const raw of t.tags) {
        const tag = normalizeTag(raw)
        if (!tag) continue
        const existing = byTag.get(tag) ?? { tag, count: 0, expenseTotal: 0, incomeTotal: 0, lastUsed: t.date }
        existing.count += 1
        if (t.isExpense) existing.expenseTotal += t.amount
        else existing.incomeTotal += t.amount
        if (t.date > existing.lastUsed) existing.lastUsed = t.date
        byTag.set(tag, existing)
      }
    }
    return Array.from(byTag.values()).sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
  }, [transactions])

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Tags</h1>
        <span style={{ width: 40 }} />
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
        Cuts across categories — group spending by a trip, an event, or anything else that doesn't map to one category. Add tags from a transaction's edit screen, or type <code>#tag</code> in Quick Add.
      </p>

      {summaries.length === 0 && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
          No tags yet. Add one to a transaction, or try "spent 40 on dinner #japan2026" in Quick Add.
        </p>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {summaries.map((s, i) => (
          <button
            key={s.tag}
            className="transaction-row"
            style={{ width: '100%', borderBottom: i < summaries.length - 1 ? '1px solid var(--border)' : 'none' }}
            onClick={() => onOpenTag(s.tag)}
          >
            <div className="tx-icon" style={{ background: '#9B7EDE33' }}>🏷️</div>
            <div className="tx-info">
              <span className="tx-note">#{s.tag}</span>
              <span className="tx-category">{s.count} transaction{s.count === 1 ? '' : 's'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              {s.expenseTotal > 0 && <span className="amount tx-amount">{formatCurrency(s.expenseTotal)}</span>}
              {s.incomeTotal > 0 && <span className="amount" style={{ fontSize: 12, color: 'var(--green)' }}>+{formatCurrency(s.incomeTotal)}</span>}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
