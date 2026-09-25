import { useMemo, useState } from 'react'
import type { Category, RecurringTransaction, Transaction, Account } from '../types'
import { formatCurrency, netAmount, reimbursementNote, excessIncomeNote, repaysNote, findTransferPair } from '../calculations'
import { transactionsWithSimilarName } from '../duplicates'
import { normalizeTag, dedupeTags, allTagsFrom } from '../tags'
import TransactionEditor from '../components/TransactionEditor'
import SwipeableRow from '../components/SwipeableRow'
import QuickAddBar from '../components/QuickAddBar'
import { PlusIcon } from '../icons'
import { useModalClose } from '../useModalClose'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onChanged: () => void
  onTransactionCreated?: (t: Transaction) => void
  initialSearch?: string
  recurring?: RecurringTransaction[]
  accounts?: Account[]
}

function dayLabel(date: Date): string {
  const today = new Date()
  const isToday = date.toDateString() === today.toDateString()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = date.toDateString() === yesterday.toDateString()
  if (isToday) return 'Today'
  if (isYesterday) return 'Yesterday'
  const sameYear = date.getFullYear() === today.getFullYear()
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: sameYear ? undefined : 'numeric' })
}

export default function TransactionsPage({ categories, transactions, onSave, onDelete, onChanged, initialSearch, onTransactionCreated, recurring = [], accounts = [] }: Props) {
  const [search, setSearch] = useState(initialSearch ?? '')
  const [filter, setFilter] = useState<'all' | 'income' | 'expense'>('all')
  const [unlinkedOnly, setUnlinkedOnly] = useState(false)
  const [editing, setEditing] = useState<Transaction | null>(null)
  const [creating, setCreating] = useState(false)
  const [similarPrompt, setSimilarPrompt] = useState<{ note: string; categoryId: string; matches: Transaction[] } | null>(null)
  const similarPromptClose = useModalClose(() => setSimilarPrompt(null))
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBulkCategoryPicker, setShowBulkCategoryPicker] = useState(false)
  const bulkPickerClose = useModalClose(() => setShowBulkCategoryPicker(false))
  const [showBulkTagPicker, setShowBulkTagPicker] = useState(false)
  const bulkTagPickerClose = useModalClose(() => setShowBulkTagPicker(false))
  const [bulkTagInput, setBulkTagInput] = useState('')

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories])

  const filtered = useMemo(() => transactions.filter((t) => {
    if (filter === 'income' && t.isExpense) return false
    if (filter === 'expense' && !t.isExpense) return false
    if (filter === 'income' && unlinkedOnly && (t.reimbursesExpenseId || (t.multiAllocations && t.multiAllocations.length > 0))) return false
    if (search) {
      const trimmed = search.trim()
      // A leading "#" is an exact tag filter (what tapping a tag chip,
      // or the Tags screen, sets the search box to) rather than a
      // substring search — "#trip" shouldn't also match a transaction
      // whose note happens to contain the letters "trip".
      if (trimmed.startsWith('#')) {
        const wanted = normalizeTag(trimmed)
        if (!t.tags.some((tag) => normalizeTag(tag) === wanted)) return false
      } else {
        const cat = t.categoryId ? categoryById.get(t.categoryId)?.name ?? '' : ''
        const haystack = (t.note + ' ' + cat + ' ' + t.tags.join(' ')).toLowerCase()
        if (!haystack.includes(search.toLowerCase())) return false
      }
    }
    return true
  }), [transactions, filter, unlinkedOnly, search, categoryById])

  const groups = useMemo(() => {
    const map = new Map<string, Transaction[]>()
    for (const t of filtered) {
      const d = new Date(t.date)
      const key = d.toDateString()
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(t)
    }
    return Array.from(map.entries())
      .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
      .map(([key, txs]) => ({ label: dayLabel(new Date(key)), transactions: txs }))
  }, [filtered])

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  async function bulkDelete() {
    // Expands the selection to include the OTHER half of any transfer
    // caught up in it — confirmed directly that deleting just one side
    // through bulk-select leaves the other behind looking like a plain,
    // unrelated income transaction (and incorrectly counting toward the
    // Income stat, since its link to the deleted expense is gone too).
    // The dedicated transfer editor already treats a transfer as one
    // thing for deletion; this keeps bulk-select consistent with that
    // rather than being a second, less careful way to delete one.
    const expanded = new Set(selectedIds)
    for (const id of selectedIds) {
      const t = transactions.find((tx) => tx.id === id)
      if (!t) continue
      const pair = findTransferPair(t, transactions)
      if (pair) expanded.add(pair.id)
    }
    if (!confirm(`Delete ${expanded.size} transaction${expanded.size === 1 ? '' : 's'}? This can't be undone.`)) return
    for (const id of expanded) await onDelete(id)
    exitSelectMode()
  }

  async function bulkCategorize(categoryId: string) {
    const targets = transactions.filter((t) => selectedIds.has(t.id))
    for (const t of targets) await onSave({ ...t, categoryId }, t.id)
    setShowBulkCategoryPicker(false)
    exitSelectMode()
  }

  // Merges into each transaction's EXISTING tags rather than replacing
  // them — bulk-tagging a trip's expenses with "#tasmania" shouldn't
  // silently wipe out a tag one of them already had for something else.
  async function bulkAddTag(rawTag: string) {
    const tag = normalizeTag(rawTag)
    if (!tag) return
    const targets = transactions.filter((t) => selectedIds.has(t.id))
    for (const t of targets) {
      if (t.tags.includes(tag)) continue
      await onSave({ ...t, tags: dedupeTags([...t.tags, tag]) }, t.id)
    }
    setShowBulkTagPicker(false)
    setBulkTagInput('')
    exitSelectMode()
  }

  // Counterpart to bulkAddTag — only touches transactions that actually
  // have the tag, so it's safe to run across a selection where some
  // transactions have it and some don't.
  async function bulkRemoveTag(tag: string) {
    const targets = transactions.filter((t) => selectedIds.has(t.id) && t.tags.includes(tag))
    for (const t of targets) {
      await onSave({ ...t, tags: t.tags.filter((existing) => existing !== tag) }, t.id)
    }
    setShowBulkTagPicker(false)
    setBulkTagInput('')
    exitSelectMode()
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <h1 className="screen-title">Transactions</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button style={{ fontSize: 14, color: 'var(--text-dim)' }} onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}>
            {selectMode ? 'Done' : 'Select'}
          </button>
          {!selectMode && <button className="round-icon-button" onClick={() => setCreating(true)}><PlusIcon /></button>}
        </div>
      </div>

      <QuickAddBar categories={categories} onChanged={onChanged} onCreated={onTransactionCreated} />

      <input
        type="text"
        placeholder="Search notes, categories, or #tag"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ width: '100%', marginBottom: 12 }}
      />

      <div className="segmented" style={{ marginBottom: filter === 'income' ? 10 : 16 }}>
        <button className={filter === 'all' ? 'segmented-active' : ''} onClick={() => setFilter('all')}>All</button>
        <button className={filter === 'income' ? 'segmented-active' : ''} onClick={() => setFilter('income')}>Income</button>
        <button className={filter === 'expense' ? 'segmented-active' : ''} onClick={() => setFilter('expense')}>Expenses</button>
      </div>

      {filter === 'income' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, fontSize: 13, color: 'var(--text-dim)' }}>
          <input type="checkbox" switch checked={unlinkedOnly} onChange={(e) => setUnlinkedOnly(e.target.checked)} style={{ width: 16, height: 16 }} />
          <span>Only unlinked (no reimbursement)</span>
        </div>
      )}

      {groups.length === 0 && (
        <p style={{ color: 'var(--text-dim)', textAlign: 'center', marginTop: 40 }}>No transactions yet. Tap + to add one.</p>
      )}

      {groups.map((group) => (
        <div key={group.label} style={{ marginBottom: 20 }}>
          <span className="day-heading">{group.label}</span>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {group.transactions.map((t, i) => {
              const category = t.categoryId ? categoryById.get(t.categoryId) : undefined
              const amount = netAmount(t, transactions, true)
              const reimbursedNote = reimbursementNote(t, transactions)
              const excessNote = excessIncomeNote(t, transactions)
              const repayNote = repaysNote(t, transactions, accounts)
              return (
                <SwipeableRow key={t.id} disabled={selectMode} onDelete={() => onDelete(t.id)}>
                  <button
                    className="transaction-row"
                    style={{ width: '100%', borderBottom: i < group.transactions.length - 1 ? '1px solid var(--border)' : 'none' }}
                    onClick={() => selectMode ? toggleSelect(t.id) : setEditing(t)}
                  >
                    {selectMode && (
                      <input type="checkbox" checked={selectedIds.has(t.id)} readOnly style={{ width: 18, height: 18 }} />
                    )}
                    <div className="tx-icon" style={{ background: (category?.color ?? '#5C6167') + '33' }}>
                      {category?.icon ?? '❓'}
                    </div>
                    <div className="tx-info">
                      <span className="tx-note">{t.note || category?.name || 'Uncategorized'}</span>
                      <span className="tx-category">
                        {category?.name ?? 'Uncategorized'}
                        {repayNote && ` · ${repayNote}`}
                        {excessNote && ` · ${excessNote}`}
                      </span>
                      {reimbursedNote && (
                        <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 500 }}>
                          {reimbursedNote}
                        </span>
                      )}
                      {t.tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 3 }}>
                          {t.tags.map((tag) => (
                            <span
                              key={tag}
                              onClick={(e) => { e.stopPropagation(); setSearch(`#${tag}`) }}
                              style={{ fontSize: 11, padding: '2px 7px', borderRadius: 10, background: 'var(--surface-2)', color: 'var(--purple)' }}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
                      {amount !== t.amount && (
                        <span className="amount" style={{ fontSize: 12, color: 'var(--text-faint)', textDecoration: 'line-through' }}>
                          {formatCurrency(t.amount)}
                        </span>
                      )}
                      <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                        {t.isExpense ? '-' : '+'}{formatCurrency(amount)}
                      </span>
                    </div>
                  </button>
                </SwipeableRow>
              )
            })}
          </div>
        </div>
      ))}

      {selectMode && selectedIds.size > 0 && (
        <div style={{ position: 'fixed', bottom: 84, left: 0, right: 0, maxWidth: 560, margin: '0 auto', padding: '10px 16px' }}>
          <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>{selectedIds.size} selected</span>
            <div style={{ display: 'flex', gap: 16 }}>
              <button style={{ color: 'var(--blue)', fontSize: 13, fontWeight: 600 }} onClick={() => setShowBulkCategoryPicker(true)}>Category</button>
              <button style={{ color: 'var(--purple)', fontSize: 13, fontWeight: 600 }} onClick={() => setShowBulkTagPicker(true)}>Tag</button>
              <button style={{ color: 'var(--red)', fontSize: 13, fontWeight: 600 }} onClick={bulkDelete}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {(editing || creating) && (
        <TransactionEditor
          transaction={editing}
          categories={categories}
          allTransactions={transactions}
          onSave={(data) => {
            const existingId = editing?.id ?? null
            onSave(data, existingId)
            if (data.categoryId && data.note.trim()) {
              const matches = transactionsWithSimilarName(data.note, data.categoryId, existingId, transactions)
              if (matches.length > 0) {
                setSimilarPrompt({ note: data.note, categoryId: data.categoryId, matches })
              }
            }
            setEditing(null)
            setCreating(false)
          }}
          onDelete={editing ? () => { onDelete(editing.id); setEditing(null) } : undefined}
          onClose={() => { setEditing(null); setCreating(false) }}
          onChanged={onChanged}
          recurring={recurring}
          accounts={accounts}
        />
      )}

      {similarPrompt && (
        <div className={`modal-backdrop${similarPromptClose.closing ? ' modal-closing' : ''}`} onClick={() => similarPromptClose.requestClose()}>
          <div className={`modal-sheet${similarPromptClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Similar Transactions</span>
              <button className="text-button" onClick={() => similarPromptClose.requestClose()}>Close</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
                {similarPrompt.matches.length} other transaction{similarPrompt.matches.length === 1 ? '' : 's'} look{similarPrompt.matches.length === 1 ? 's' : ''} similar to "{similarPrompt.note}" but aren't categorized the same way. Categorize {similarPrompt.matches.length === 1 ? 'it' : 'them'} too?
              </p>
              <button
                className="list-button"
                style={{ width: '100%', textAlign: 'center', background: 'var(--blue)', color: '#FFFFFF', borderRadius: 10, padding: 12, fontWeight: 600, marginBottom: 8 }}
                onClick={() => similarPromptClose.requestClose(async () => {
                  for (const t of similarPrompt.matches) {
                    await onSave({ ...t, categoryId: similarPrompt.categoryId }, t.id)
                  }
                  setSimilarPrompt(null)
                })}
              >
                Categorize {similarPrompt.matches.length}
              </button>
              <button className="list-button" style={{ width: '100%', textAlign: 'center', color: 'var(--text-dim)' }} onClick={() => similarPromptClose.requestClose()}>Not Now</button>
            </div>
          </div>
        </div>
      )}

      {showBulkCategoryPicker && (
        <div className={`modal-backdrop${bulkPickerClose.closing ? ' modal-closing' : ''}`} onClick={() => bulkPickerClose.requestClose()}>
          <div className={`modal-sheet${bulkPickerClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Change {selectedIds.size} to</span>
              <button className="text-button text-button-primary" onClick={() => bulkPickerClose.requestClose()}>Cancel</button>
            </div>
            <div className="modal-body">
              {categories.filter((c) => !c.parentId).map((c) => (
                <div key={c.id}>
                  <button className="picker-row" onClick={() => bulkPickerClose.requestClose(() => bulkCategorize(c.id))}>
                    <span>{c.icon} {c.name}</span>
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => bulkPickerClose.requestClose(() => bulkCategorize(s.id))}>
                      <span>{s.icon} {s.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showBulkTagPicker && (() => {
        const existingTags = allTagsFrom(transactions)
        const query = normalizeTag(bulkTagInput)
        const suggestions = existingTags.filter((t) => t.includes(query)).slice(0, 8)
        const selectedTransactions = transactions.filter((t) => selectedIds.has(t.id))
        const tagsOnSelection = [...new Set(selectedTransactions.flatMap((t) => t.tags))].sort()
        return (
          <div className={`modal-backdrop${bulkTagPickerClose.closing ? ' modal-closing' : ''}`} onClick={() => bulkTagPickerClose.requestClose()}>
            <div className={`modal-sheet${bulkTagPickerClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Tag {selectedIds.size} transaction{selectedIds.size === 1 ? '' : 's'}</span>
                <button className="text-button" onClick={() => bulkTagPickerClose.requestClose()}>Cancel</button>
              </div>
              <div className="modal-body">
                {tagsOnSelection.length > 0 && (
                  <>
                    <label className="field-label">On This Selection — tap to remove</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, marginBottom: 16 }}>
                      {tagsOnSelection.map((t) => (
                        <button
                          key={t}
                          onClick={() => bulkTagPickerClose.requestClose(() => bulkRemoveTag(t))}
                          style={{ fontSize: 13, padding: '5px 10px', borderRadius: 14, background: 'var(--surface-2)', color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 5 }}
                        >
                          {t} <span style={{ color: 'var(--red)' }}>×</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <label className="field-label">Add a Tag</label>
                <p className="hint" style={{ marginBottom: 12 }}>Added alongside whatever tags each transaction already has — nothing gets removed.</p>
                <input
                  type="text"
                  placeholder="e.g. work trip"
                  value={bulkTagInput}
                  onChange={(e) => setBulkTagInput(e.target.value)}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      bulkTagPickerClose.requestClose(() => bulkAddTag(bulkTagInput))
                    }
                  }}
                />
                {suggestions.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                    {suggestions.map((t) => (
                      <button
                        key={t}
                        onClick={() => bulkTagPickerClose.requestClose(() => bulkAddTag(t))}
                        style={{ fontSize: 13, padding: '5px 10px', borderRadius: 14, background: 'var(--surface-2)', color: 'var(--purple)' }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  style={{ width: '100%', textAlign: 'center', background: query ? 'var(--blue)' : 'var(--surface-2)', color: query ? '#FFFFFF' : 'var(--text-faint)', borderRadius: 10, padding: 12, fontWeight: 600, marginTop: 16 }}
                  disabled={!query}
                  onClick={() => bulkTagPickerClose.requestClose(() => bulkAddTag(bulkTagInput))}
                >
                  Add Tag
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
