import { useState } from 'react'
import type { Transaction } from '../types'
import { findDuplicates, type PotentialDuplicateGroup } from '../duplicates'
import { formatCurrency } from '../calculations'
import { deleteTransaction, mergeTransactions } from '../db'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'

interface Props {
  transactions: Transaction[]
  onChanged: () => void
  onBack: () => void
}

export default function DuplicateCheck({ transactions, onChanged, onBack }: Props) {
  useSwipeBack(onBack)
  const [groups, setGroups] = useState<PotentialDuplicateGroup[] | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [mergingGroup, setMergingGroup] = useState<PotentialDuplicateGroup | null>(null)
  const [keepChoice, setKeepChoice] = useState<string | null>(null)
  const mergeClose = useModalClose(() => { setMergingGroup(null); setKeepChoice(null) })

  function scan() {
    setGroups(findDuplicates(transactions))
    setDismissed(new Set())
  }

  async function remove(id: string, groupId: string, groupSize: number) {
    await deleteTransaction(id)
    onChanged()
    if (groupSize - 1 <= 1) setDismissed((d) => new Set(d).add(groupId))
  }

  function openMerge(group: PotentialDuplicateGroup) {
    setMergingGroup(group)
    setKeepChoice(group.transactions[0]?.id ?? null)
  }

  async function confirmMerge() {
    if (!mergingGroup || !keepChoice) return
    const discard = mergingGroup.transactions.find((t) => t.id !== keepChoice)
    if (!discard) return
    const groupId = mergingGroup.id
    mergeClose.requestClose(async () => {
      await mergeTransactions(keepChoice, discard.id)
      onChanged()
      setDismissed((d) => new Set(d).add(groupId))
    })
  }

  const visible = groups?.filter((g) => !dismissed.has(g.id)) ?? []

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Duplicate Check</h1>
        <span style={{ width: 40 }} />
      </div>

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
          {group.transactions.length === 2 && (
            <button className="list-button" style={{ marginTop: 4, fontSize: 12, color: 'var(--blue)' }} onClick={() => openMerge(group)}>
              🔀 Merge instead — combine both into one
            </button>
          )}
        </div>
      ))}

      {groups !== null && (
        <button className="list-button" style={{ color: 'var(--text-dim)', fontSize: 13 }} onClick={scan}>Re-scan</button>
      )}

      {mergingGroup && (
        <div className={`modal-backdrop${mergeClose.closing ? ' modal-closing' : ''}`} onClick={() => mergeClose.requestClose()}>
          <div className={`modal-sheet${mergeClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <button className="text-button" onClick={() => mergeClose.requestClose()}>Cancel</button>
              <span className="modal-title">Merge Duplicates</span>
              <button className="text-button text-button-primary" onClick={confirmMerge}>Merge</button>
            </div>
            <div className="modal-body">
              <p className="hint" style={{ marginBottom: 12 }}>
                Pick which one to keep — its date and amount survive, but nothing from the other is lost: its category and tags carry over if the one you keep doesn't already have them, and anything that reimburses or covers the one you discard gets redirected to the one you keep.
              </p>
              {mergingGroup.transactions.map((t) => (
                <button
                  key={t.id}
                  className="picker-row"
                  style={{ alignItems: 'flex-start', textAlign: 'left' }}
                  onClick={() => setKeepChoice(t.id)}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{t.note || 'Uncategorized'}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
                      {new Date(t.date).toLocaleDateString('en-AU')} · {formatCurrency(t.amount)}
                      {t.categoryId ? ' · has a category' : ' · no category'}
                      {t.tags.length > 0 ? ` · ${t.tags.length} tag${t.tags.length === 1 ? '' : 's'}` : ''}
                      {t.reimbursesExpenseId || t.multiAllocations ? ' · linked to an expense' : ''}
                    </div>
                  </div>
                  {keepChoice === t.id && <span style={{ color: 'var(--blue)', fontSize: 18 }}>✓</span>}
                </button>
              ))}
              <p className="hint" style={{ marginTop: 8 }}>Keeping the {keepChoice === mergingGroup.transactions[0]?.id ? 'first' : 'second'} one.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
