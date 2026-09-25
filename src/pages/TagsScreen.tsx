import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, reimbursementBreakdown } from '../calculations'
import { normalizeTag } from '../tags'
import { renameTag, deleteTagEverywhere } from '../db'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onOpenTag: (tag: string) => void
  onChanged: () => void
}

interface TagSummary {
  tag: string
  count: number
  totalCost: number
  outOfPocket: number
  fundedFromSavings: number
  reimbursedByOthers: number
  incomeTotal: number
  lastUsed: string
}

export default function TagsScreen({ transactions, onBack, onOpenTag, onChanged }: Props) {
  useSwipeBack(onBack)
  const [actionsFor, setActionsFor] = useState<string | null>(null)
  const actionsClose = useModalClose(() => setActionsFor(null))
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameClose = useModalClose(() => setRenaming(null))
  const [renameInput, setRenameInput] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const confirmDeleteClose = useModalClose(() => setConfirmingDelete(null))

  // The same real-cost breakdown TagDetail already shows for one tag at
  // a time (total cost, savings-funded, friend-funded, what's actually
  // left out of pocket) — pulled up here across every tag at once, so
  // "which trip actually cost me the most" is something you can browse
  // rather than something you have to already know the answer to
  // before you can look it up.
  const summaries = useMemo(() => {
    const tagsSeen = new Set<string>()
    for (const t of transactions) for (const raw of t.tags) { const tag = normalizeTag(raw); if (tag) tagsSeen.add(tag) }

    const result: TagSummary[] = []
    for (const tag of tagsSeen) {
      const tagged = transactions.filter((t) => t.tags.some((raw) => normalizeTag(raw) === tag))
      const taggedExpenses = tagged.filter((t) => t.isExpense)
      const breakdown = reimbursementBreakdown(taggedExpenses, transactions)
      const incomeTotal = tagged.filter((t) => !t.isExpense).reduce((sum, t) => sum + t.amount, 0)
      const lastUsed = tagged.reduce((latest, t) => (t.date > latest ? t.date : latest), tagged[0]?.date ?? '')
      result.push({
        tag,
        count: tagged.length,
        totalCost: breakdown.totalCost,
        outOfPocket: breakdown.outOfPocket,
        fundedFromSavings: breakdown.fundedFromSavings,
        reimbursedByOthers: breakdown.reimbursedByOthers,
        incomeTotal,
        lastUsed
      })
    }
    return result.sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
  }, [transactions])

  function openRename(tag: string) {
    setActionsFor(null)
    setRenameInput(tag)
    setRenaming(tag)
  }

  async function confirmRename() {
    if (!renaming) return
    const target = renaming
    const newName = renameInput
    renameClose.requestClose(async () => {
      await renameTag(target, newName)
      onChanged()
    })
  }

  async function confirmDelete() {
    if (!confirmingDelete) return
    const target = confirmingDelete
    confirmDeleteClose.requestClose(async () => {
      await deleteTagEverywhere(target)
      onChanged()
    })
  }

  // Merging into an existing tag is just a rename to that tag's name —
  // dedupeTags collapses the two wherever a transaction happened to
  // carry both, so there's no separate "merge" flow to build.
  const otherTags = summaries.map((s) => s.tag).filter((t) => t !== renaming)

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
          <div key={s.tag} className="transaction-row" style={{ borderBottom: i < summaries.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <button className="transaction-row" style={{ padding: 0, flex: 1 }} onClick={() => onOpenTag(s.tag)}>
              <div className="tx-icon" style={{ background: '#9B7EDE33' }}>🏷️</div>
              <div className="tx-info">
                <span className="tx-note">{s.tag}</span>
                <span className="tx-category">
                  {s.count} transaction{s.count === 1 ? '' : 's'}
                  {s.totalCost > 0 && (s.fundedFromSavings > 0.01 || s.reimbursedByOthers > 0.01) && ' · '}
                  {s.fundedFromSavings > 0.01 && `${formatCurrency(s.fundedFromSavings)} from savings`}
                  {s.fundedFromSavings > 0.01 && s.reimbursedByOthers > 0.01 && ', '}
                  {s.reimbursedByOthers > 0.01 && `${formatCurrency(s.reimbursedByOthers)} back from others`}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                {/* Out-of-pocket, not raw total cost — this is the
                   number that actually answers "what did this trip
                   cost ME," matching what a person browsing this list
                   is really trying to find out, not just the gross
                   spend before anything came back. */}
                {s.totalCost > 0 && <span className="amount tx-amount">{formatCurrency(s.outOfPocket)}</span>}
                {s.totalCost > 0 && s.outOfPocket !== s.totalCost && (
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>of {formatCurrency(s.totalCost)}</span>
                )}
                {s.incomeTotal > 0 && <span className="amount" style={{ fontSize: 12, color: 'var(--green)' }}>+{formatCurrency(s.incomeTotal)}</span>}
              </div>
            </button>
            <button onClick={() => setActionsFor(s.tag)} style={{ padding: '0 4px 0 12px', fontSize: 18, color: 'var(--text-dim)' }} aria-label={`Actions for tag ${s.tag}`}>
              ⋯
            </button>
          </div>
        ))}
      </div>

      {actionsFor && (
        <div className={`modal-backdrop${actionsClose.closing ? ' modal-closing' : ''}`} onClick={() => actionsClose.requestClose()}>
          <div className={`modal-sheet${actionsClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">🏷️ {actionsFor}</span>
              <button className="text-button" onClick={() => actionsClose.requestClose()}>Close</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => openRename(actionsFor)}>
                <span>✏️ Rename or merge</span>
              </button>
              <button className="picker-row" onClick={() => { const tag = actionsFor; actionsClose.requestClose(() => setConfirmingDelete(tag)) }}>
                <span style={{ color: 'var(--red)' }}>🗑️ Delete tag</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {renaming && (
        <div className={`modal-backdrop${renameClose.closing ? ' modal-closing' : ''}`} onClick={() => renameClose.requestClose()}>
          <div className={`modal-sheet${renameClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <button className="text-button" onClick={() => renameClose.requestClose()}>Cancel</button>
              <span className="modal-title">Rename "{renaming}"</span>
              <button className="text-button text-button-primary" onClick={confirmRename}>Save</button>
            </div>
            <div className="modal-body">
              <input
                type="text"
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                autoFocus
              />
              {otherTags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {otherTags
                    .filter((t) => !normalizeTag(renameInput) || t.includes(normalizeTag(renameInput)))
                    .map((t) => (
                      <button
                        key={t}
                        onClick={() => setRenameInput(t)}
                        style={{ fontSize: 13, padding: '5px 10px', borderRadius: 14, background: 'var(--surface-2)', color: 'var(--text-dim)' }}
                      >
                        {t}
                      </button>
                    ))}
                </div>
              )}
              <p className="hint" style={{ marginTop: 10 }}>
                Renaming to a tag that already exists (tap one above, or type it) merges the two — every transaction tagged "{renaming}" will be re-tagged, and any that already had both just keep one.
              </p>
            </div>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <div className={`modal-backdrop${confirmDeleteClose.closing ? ' modal-closing' : ''}`} onClick={() => confirmDeleteClose.requestClose()}>
          <div className={`modal-sheet${confirmDeleteClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Delete "{confirmingDelete}"?</span>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 14, marginBottom: 16 }}>
                Removes this tag from every transaction that has it. The transactions themselves — amounts, notes, categories — aren't touched, only the tag.
              </p>
              <button onClick={confirmDelete} style={{ width: '100%', padding: '12px', borderRadius: 10, background: 'var(--red)', color: '#fff', fontWeight: 600, marginBottom: 8 }}>
                Delete "{confirmingDelete}"
              </button>
              <button onClick={() => confirmDeleteClose.requestClose()} className="text-button" style={{ width: '100%', padding: '12px', textAlign: 'center' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
