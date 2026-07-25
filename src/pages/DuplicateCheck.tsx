import { useState } from 'react'
import type { Transaction } from '../types'
import { findDuplicates, type PotentialDuplicateGroup } from '../duplicates'
import { formatCurrency } from '../calculations'
import { deleteTransaction } from '../db'

interface Props {
  transactions: Transaction[]
  onChanged: () => void
}

export default function DuplicateCheck({ transactions, onChanged }: Props) {
  const [groups, setGroups] = useState<PotentialDuplicateGroup[] | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())

  function scan() {
    setGroups(findDuplicates(transactions))
    setDismissed(new Set())
  }

  async function remove(id: string, groupId: string, groupSize: number) {
    await deleteTransaction(id)
    onChanged()
    if (groupSize - 1 <= 1) setDismissed((d) => new Set(d).add(groupId))
  }

  const visible = groups?.filter((g) => !dismissed.has(g.id)) ?? []

  return (
    <div className="screen">
      <h1 className="screen-title">Duplicate Check</h1>

      {groups === null && (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
            Checks every transaction for likely duplicates — same amount, same direction, dates within a few days — regardless of whether the merchant name matches exactly.
          </p>
          <button className="list-button" style={{ color: 'var(--blue)', fontWeight: 600 }} onClick={scan}>Scan for Duplicates</button>
        </div>
      )}

      {groups !== null && visible.length === 0 && (
        <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 40 }}>No duplicates found across {transactions.length} transactions.</p>
      )}

      {visible.map((group) => (
        <div className="card" key={group.id} style={{ marginBottom: 12 }}>
          <span className="section-heading" style={{ margin: '0 0 8px' }}>
            {group.hasSharedToken ? 'Matching merchant or reference' : 'Same amount and day only — lower confidence'}
          </span>
          {group.transactions.map((t) => (
            <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontSize: 14 }}>{t.note || 'Uncategorized'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{new Date(t.date).toLocaleDateString('en-AU')}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="amount">{formatCurrency(t.amount)}</span>
                <button onClick={() => remove(t.id, group.id, group.transactions.length)} style={{ color: 'var(--red)', fontSize: 12 }}>Delete</button>
              </div>
            </div>
          ))}
          <button className="list-button" style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }} onClick={() => setDismissed((d) => new Set(d).add(group.id))}>Not a Duplicate</button>
        </div>
      ))}

      {groups !== null && (
        <button className="list-button" style={{ color: 'var(--text-dim)', fontSize: 13 }} onClick={scan}>Re-scan</button>
      )}
    </div>
  )
}
