import { useEffect, useMemo, useState } from 'react'
import type { Category, Transaction, Account } from '../types'
import { recognizeTextItems } from '../ocr'
import { parseScreenshot, type ParsedTransaction, type DetectedFormat } from '../receiptParser'
import { isLikelyDuplicate, significantTokens, genericTokens, isLikelyTransitFare, findPendingFareMatch } from '../duplicates'
import { formatCurrency } from '../calculations'
import { allTagsFrom } from '../tags'
import TagEditor from '../components/TagEditor'
import { normalizeMerchantKey } from '../merchantRules'
import { createTransaction, saveTransaction } from '../db'
import { useSwipeBack } from '../useSwipeBack'
import SortMenuButton from '../components/SortMenuButton'
import { useModalClose } from '../useModalClose'
import { getImportAccountMapping, guessImportSource } from '../importSettings'

interface Props {
  categories: Category[]
  existingTransactions: Transaction[]
  onBack: () => void
  onImported: () => void
  initialFiles?: FileList | null
  accounts?: Account[]
}

const FORMAT_LABELS: Record<DetectedFormat, string> = {
  appScreenshot: 'Banking app screenshot',
  notificationScreenshot: 'Payment notification screenshot',
  beemScreenshot: 'Beem activity screenshot',
  unknown: 'Unrecognized format'
}

export default function StatementImport({ categories, existingTransactions, onBack, onImported, initialFiles, accounts = [] }: Props) {
  useSwipeBack(onBack)
  const [status, setStatus] = useState<'idle' | 'scanning' | 'done'>('idle')
  const [scanProgress, setScanProgress] = useState('')
  const [results, setResults] = useState<ParsedTransaction[]>([])
  const [skippedRows, setSkippedRows] = useState<string[]>([])
  // Not another rejection list like skippedRows — this is for the
  // failure mode that produces NO skipped rows at all to warn about,
  // because there's nothing left over to flag: OCR just silently
  // finds nothing for part of the image. Confirmed directly against a
  // real photo: three whole transaction cards on a certain gradient
  // background produced zero extracted text — not a garbled row that
  // gets skipped, an absence with nothing to point at. A low total
  // line count on a photo confidently recognized as a real screenshot
  // format is the only signal available for "this probably has more
  // in it than what came back" — imprecise, but far better than the
  // alternative of a wrong result with no hint anything was missed.
  const [sparseScanWarning, setSparseScanWarning] = useState<string | null>(null)
  const [formatsSeen, setFormatsSeen] = useState<Set<DetectedFormat>>(new Set())
  const [importAccountId, setImportAccountId] = useState<string | null>(null)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const [included, setIncluded] = useState<Set<string>>(new Set())

  useEffect(() => {
    // Files already selected before this screen even mounted — the
    // Dashboard's camera button opens the OS photo picker directly
    // (has to, for the click-to-open to work on iOS Safari at all) and
    // hands the result over here, so scanning can start immediately
    // instead of asking the person to tap "Choose Photo(s)" again for a
    // photo they already picked.
    if (initialFiles && initialFiles.length > 0) handleFiles(initialFiles)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [sort, setSort] = useState<'recent' | 'oldest'>('recent')
  const [categoryOverrides, setCategoryOverrides] = useState<Map<string, string | null>>(new Map())
  const [pickingCategoryFor, setPickingCategoryFor] = useState<string | null>(null)
  const pickingCategoryClose = useModalClose(() => setPickingCategoryFor(null))
  // Per-row tags added during review — a fresh scanned row has none of
  // its own (ParsedTransaction carries no tags), so every row starts
  // untagged unless added here, same override-map shape as
  // categoryOverrides above.
  const [tagOverrides, setTagOverrides] = useState<Map<string, string[]>>(new Map())
  const [editingTagsFor, setEditingTagsFor] = useState<string | null>(null)
  const editingTagsClose = useModalClose(() => setEditingTagsFor(null))
  // A separate mode from the existing per-row "include in import"
  // checkbox — that one decides what gets imported, this one decides
  // which rows a bulk tag action applies to, so they can't collide
  // (selecting rows to tag shouldn't accidentally exclude them from
  // the import, or vice versa).
  const [selectMode, setSelectMode] = useState(false)
  const [selectedForBulkTag, setSelectedForBulkTag] = useState<Set<string>>(new Set())
  const [bulkTagging, setBulkTagging] = useState(false)
  const bulkTagClose = useModalClose(() => setBulkTagging(false))
  const [pendingBulkTags, setPendingBulkTags] = useState<string[]>([])
  const [similarPrompt, setSimilarPrompt] = useState<{ categoryId: string | null; matchIds: string[] } | null>(null)
  const [similarPromptSelected, setSimilarPromptSelected] = useState<Set<string>>(new Set())
  const similarBatchClose = useModalClose(() => setSimilarPrompt(null))
  const [hideDuplicates, setHideDuplicates] = useState(false)

  const [viewingDuplicateFor, setViewingDuplicateFor] = useState<ParsedTransaction | null>(null)
  const viewingDuplicateClose = useModalClose(() => setViewingDuplicateFor(null))

  // Maps a parsed row's id -> the expense it reimburses, so a Beem share
  // (or any income row) can be linked to its expense right here rather
  // than needing a second trip through the transaction editor after
  // import. The target is either an existing DB transaction
  // ("existing:<id>") or another row in this same batch that hasn't been
  // saved yet ("parsed:<id>") — resolved to a real id at import time.
  const [linkOverrides, setLinkOverrides] = useState<Map<string, string>>(new Map())
  const [linkingFor, setLinkingFor] = useState<ParsedTransaction | null>(null)
  const linkingClose = useModalClose(() => setLinkingFor(null))

  // Shown after a successful import instead of navigating straight back —
  // the whole point of this screen is scanning photos so their contents
  // can be deleted afterward without retyping everything, but a web app
  // has no way to actually delete anything from the device's photo
  // library itself (no browser API grants that access, on any platform,
  // installed or not) — the best real help is a clear, explicit "safe to
  // delete now" moment instead of silently returning to the transaction
  // list and leaving that as a vague afterthought.
  const [importSummary, setImportSummary] = useState<{ count: number } | null>(null)

  const importGeneric = useMemo(
    () => genericTokens([...existingTransactions, ...results.map((res) => ({ ...res, categoryId: null, reimbursesExpenseId: null, tags: [], accountId: null } as Transaction))]),
    [existingTransactions, results]
  )

  function matchingExisting(r: ParsedTransaction): Transaction[] {
    return existingTransactions.filter((t) => isLikelyDuplicate(t, r, 3, importGeneric))
  }

  const duplicateIds = new Set(results.filter((r) => matchingExisting(r).length > 0).map((r) => r.id))

  // Maps an incoming row to the existing stale $1.00 placeholder it
  // should update instead of being imported as a new transaction —
  // processed in date order and excluding ids already claimed, so two
  // real fares in the same batch can't both grab the same placeholder.
  const pendingFareResolutions = useMemo(() => {
    const map = new Map<string, Transaction>()
    const claimed = new Set<string>()
    const sorted = [...results].sort((a, b) => a.date.localeCompare(b.date))
    for (const r of sorted) {
      const match = findPendingFareMatch(r, existingTransactions, claimed)
      if (match) {
        map.set(r.id, match)
        claimed.add(match.id)
      }
    }
    return map
  }, [results, existingTransactions])
  const [skippedResolutions, setSkippedResolutions] = useState<Set<string>>(new Set())

  // Flagged but still checked by default — worth a second glance, not
  // assumed wrong. Median taken across this batch's expense amounts.
  //
  // Excludes an amount that already recurs in existing transaction
  // history at a similar amount for the same merchant — confirmed via
  // testing this exact "median of everyday spending vs one big bill"
  // comparison flags a normal rent payment as suspicious every time it
  // gets imported, purely because it's bigger than the small purchases
  // sitting alongside it in the same batch.
  const outlierIds = (() => {
    const amounts = results.filter((r) => r.isExpense).map((r) => r.amount).sort((a, b) => a - b)
    if (amounts.length < 5) return new Set<string>()
    const median = amounts[Math.floor(amounts.length / 2)]
    if (median <= 0) return new Set<string>()
    return new Set(
      results
        .filter((r) => r.isExpense && r.amount > Math.max(median * 10, 300))
        .filter((r) => {
          const key = normalizeMerchantKey(r.note)
          if (!key) return true
          const recurs = existingTransactions.some((t) =>
            t.isExpense && normalizeMerchantKey(t.note) === key && Math.abs(t.amount - r.amount) / r.amount < 0.1
          )
          return !recurs
        })
        .map((r) => r.id)
    )
  })()

  // Shares isLikelyTransitFare with duplicates.ts and healthCheck.ts —
  // confirmed this exact list drifted out of sync across THREE separate
  // copies in this codebase, all missing the real "Transport NSW"
  // format (no "for"), so this pending-fare badge had never actually
  // fired for the single most common real-world case during import
  // review either.
  const pendingFareIds = new Set(
    results
      .filter((r) => r.isExpense && r.amount <= 2 && isLikelyTransitFare(r.note))
      .map((r) => r.id)
  )

  // Beem "split between N of us" cards import as one income row per
  // other person's share — not the full bill itself, since that'll
  // come in separately from a bank statement/screenshot import, and
  // creating it here too would duplicate it.
  const splitBillResults = results.filter((r) => r.splitInfo)

  async function handlePdfFile(files: FileList | null) {
    if (!files || files.length === 0) return
    setStatus('scanning')
    setResults([])
    setSkippedRows([])
    setScanProgress('Reading PDF\u2026')
    setImportAccountId(null)
    try {
      const { parsePdfStatement } = await import('../pdfParser')
      const { transactions, skipped } = await parsePdfStatement(files[0], categories)
      setResults(transactions)
      setSkippedRows(skipped)
      setFormatsSeen(new Set())
      setIncluded(new Set(transactions.filter((r) => matchingExisting(r).length === 0).map((r) => r.id)))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setSkippedRows([`Couldn't read that PDF — error: ${message}`])
    }
    setStatus('done')
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setStatus('scanning')
    setResults([])
    setSkippedRows([])
    setSparseScanWarning(null)
    const allResults: ParsedTransaction[] = []
    const allSkipped: string[] = []
    const formats = new Set<DetectedFormat>()
    let firstFormat: DetectedFormat | null = null
    let combinedText = ''
    let sparsePhotoCount = 0

    for (let i = 0; i < files.length; i++) {
      setScanProgress(`Reading photo ${i + 1} of ${files.length}\u2026`)
      try {
        const items = await recognizeTextItems(files[i])
        combinedText += ' ' + items.map((it) => it.text).join(' ')
        const { transactions, skipped, format } = await parseScreenshot(items, categories)
        allResults.push(...transactions)
        allSkipped.push(...skipped)
        formats.add(format)
        if (!firstFormat) firstFormat = format
        // A real screenshot type was confidently recognized, yet this
        // specific photo returned very few lines total — a normal
        // multi-transaction screenshot (several stacked cards or
        // statement rows) reads out well over a dozen lines; single
        // digits here means large parts of the image likely produced
        // nothing at all, the same way the Beem bug did.
        if (format !== 'unknown' && items.length < 8) sparsePhotoCount++
      } catch {
        allSkipped.push(`(Photo ${i + 1} couldn't be read)`)
      }
    }

    setResults(allResults)
    setSkippedRows(allSkipped)
    setFormatsSeen(formats)
    if (sparsePhotoCount > 0) {
      setSparseScanWarning(`${sparsePhotoCount} photo${sparsePhotoCount === 1 ? '' : 's'} returned surprisingly little text for ${sparsePhotoCount === 1 ? 'a' : ''} recognized screenshot${sparsePhotoCount === 1 ? '' : 's'} — if you can see more transactions in ${sparsePhotoCount === 1 ? 'it' : 'them'} than showed up below, try rescanning in better light or at a higher resolution.`)
    }
    setIncluded(new Set(allResults.filter((r) => matchingExisting(r).length === 0).map((r) => r.id)))
    // A best-effort starting point, not a silent decision — confirmed
    // this stays fully editable via the account picker shown on the
    // review screen below, since guessing wrong here would mean money
    // landing against the wrong account's balance.
    const guessedSource = firstFormat ? guessImportSource(firstFormat, combinedText) : null
    const mapping = getImportAccountMapping()
    setImportAccountId(guessedSource ? mapping[guessedSource] : null)
    setStatus('done')
  }

  function toggle(id: string) {
    setIncluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function categoryFor(r: ParsedTransaction): string | null {
    return categoryOverrides.has(r.id) ? categoryOverrides.get(r.id)! : r.suggestedCategoryId
  }

  function tagsFor(r: ParsedTransaction): string[] {
    return tagOverrides.get(r.id) ?? []
  }

  function setTagsForRow(id: string, tags: string[]) {
    setTagOverrides((m) => new Map(m).set(id, tags))
  }

  function toggleSelectedForBulkTag(id: string) {
    setSelectedForBulkTag((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Merges newly-typed tags into every selected row's existing tags
  // (never replaces what a row already has) — the natural meaning of
  // "add this tag to these N rows" when the rows may already carry
  // different tags of their own.
  function applyBulkTags(newTags: string[]) {
    if (newTags.length === 0) return
    setTagOverrides((m) => {
      const next = new Map(m)
      for (const id of selectedForBulkTag) {
        const existing = next.get(id) ?? []
        const merged = [...existing]
        for (const t of newTags) if (!merged.includes(t)) merged.push(t)
        next.set(id, merged)
      }
      return next
    })
  }

  // Candidate expenses an income row could reimburse: existing unlinked
  // expenses already in the app, plus other expense rows in this same
  // import batch (most relevant for a Beem split — its actual bill often
  // comes in in the very same batch from a separate bank screenshot).
  // Excludes expenses already fully covered by other reimbursements so
  // the list stays focused on things that plausibly still need a link.
  function candidateExpenses(): { key: string; note: string; amount: number; date: string }[] {
    const fromExisting = existingTransactions
      .filter((t) => t.isExpense)
      .map((t) => ({ key: `existing:${t.id}`, note: t.note || 'Uncategorized', amount: t.amount, date: t.date }))
    const fromBatch = results
      .filter((r) => r.isExpense)
      .map((r) => ({ key: `parsed:${r.id}`, note: r.note, amount: r.amount, date: r.date }))
    return [...fromBatch, ...fromExisting].sort((a, b) => b.date.localeCompare(a.date))
  }

  function linkedTarget(r: ParsedTransaction): { key: string; note: string; amount: number } | null {
    const key = linkOverrides.get(r.id)
    if (!key) return null
    if (key.startsWith('existing:')) {
      const id = key.slice('existing:'.length)
      const t = existingTransactions.find((t) => t.id === id)
      return t ? { key, note: t.note || 'Uncategorized', amount: t.amount } : null
    }
    const id = key.slice('parsed:'.length)
    const source = results.find((r) => r.id === id)
    return source ? { key, note: source.note, amount: source.amount } : null
  }

  function setLink(rowId: string, targetKey: string | null) {
    setLinkOverrides((m) => {
      const next = new Map(m)
      if (targetKey === null) next.delete(rowId)
      else next.set(rowId, targetKey)
      return next
    })
    setLinkingFor(null)
  }

  function applyCategory(id: string, categoryId: string | null) {
    setCategoryOverrides((m) => new Map(m).set(id, categoryId))
    setPickingCategoryFor(null)

    if (categoryId === null) return
    const source = results.find((r) => r.id === id)
    if (!source || /beem/i.test(source.note)) return
    const sourceTokens = significantTokens(source.note)
    if (sourceTokens.size === 0) return

    const matches = results.filter((r) => {
      if (r.id === id) return false
      if (/beem/i.test(r.note)) return false
      if (categoryFor(r) === categoryId) return false
      const overlaps = [...significantTokens(r.note)].some((tok) => sourceTokens.has(tok))
      return overlaps
    })

    if (matches.length > 0) {
      setSimilarPrompt({ categoryId, matchIds: matches.map((m) => m.id) })
      // Defaults to every match checked — preserves "apply to all" as
      // the one-tap default for the common case, while still letting
      // individual rows be unchecked before confirming, rather than the
      // previous all-or-nothing choice between every match and none.
      setSimilarPromptSelected(new Set(matches.map((m) => m.id)))
    }
  }

  function confirmSimilarPrompt() {
    if (!similarPrompt) return
    setCategoryOverrides((m) => {
      const next = new Map(m)
      for (const id of similarPromptSelected) next.set(id, similarPrompt.categoryId)
      return next
    })
    setSimilarPrompt(null)
  }

  async function handleImport() {
    const toImport = results.filter((r) => included.has(r.id))

    // Pass 1: create every row first, so a link to ANOTHER row being
    // imported in this same batch (e.g. a split's income share linked to
    // its expense from a separate bank screenshot in the same scan) has
    // a real database id to point at.
    //
    // A row that resolves a stale $1.00 pending fare (see
    // pendingFareResolutions) updates that existing transaction in place
    // instead — amount and date replaced with the fresh, settled values
    // from this import, since those are more accurate than the
    // placeholder's original pending-time guess, but everything else
    // (category, tags, account) stays exactly as the person already had
    // it, rather than being reset.
    const createdByParsedId = new Map<string, Transaction>()
    for (const r of toImport) {
      const resolveMatch = pendingFareResolutions.get(r.id)
      if (resolveMatch && !skippedResolutions.has(r.id)) {
        const updated: Transaction = { ...resolveMatch, amount: r.amount, note: r.note, date: r.date }
        await saveTransaction(updated)
        createdByParsedId.set(r.id, updated)
        continue
      }
      const created = await createTransaction({
        amount: r.amount,
        note: r.note,
        date: r.date,
        isExpense: r.isExpense,
        categoryId: categoryFor(r),
        reimbursesExpenseId: null,
        tags: tagsFor(r),
        accountId: importAccountId
      })
      createdByParsedId.set(r.id, created)
    }

    // Pass 2: apply links. A link to an existing (already-saved)
    // transaction resolves directly; a link to another row in this batch
    // resolves via the id map from pass 1 — and is silently skipped if
    // that target row was unchecked and never actually imported, rather
    // than pointing at a transaction that doesn't exist.
    for (const r of toImport) {
      const targetKey = linkOverrides.get(r.id)
      if (!targetKey) continue
      const created = createdByParsedId.get(r.id)
      if (!created) continue
      let targetId: string | null = null
      if (targetKey.startsWith('existing:')) {
        targetId = targetKey.slice('existing:'.length)
      } else {
        const targetParsedId = targetKey.slice('parsed:'.length)
        targetId = createdByParsedId.get(targetParsedId)?.id ?? null
      }
      if (targetId) {
        await saveTransaction({ ...created, reimbursesExpenseId: targetId })
      }
    }

    onImported()
    setImportSummary({ count: toImport.length })
  }

  const catById = new Map(categories.map((c) => [c.id, c]))
  const existingTagsList = allTagsFrom(existingTransactions)

  if (importSummary) {
    return (
      <div className="screen">
        <div className="screen-header-row">
          <h1 className="screen-title" style={{ fontSize: 20 }}>Import Statement</h1>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '48px 20px', gap: 12 }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <p style={{ fontSize: 17, fontWeight: 600 }}>
            Imported {importSummary.count} transaction{importSummary.count === 1 ? '' : 's'}
          </p>
          <p className="hint" style={{ maxWidth: 320 }}>
            The photo{results.length === 1 ? "'s" : "s'"} contents are safely saved — this app can't delete photos
            from your gallery itself (no website can), but it's safe to delete{' '}
            {results.length === 1 ? 'it' : 'them'} yourself now if you scanned it just for this.
          </p>
          <button
            className="text-button text-button-primary"
            style={{ marginTop: 8, padding: '10px 24px', background: 'var(--blue)', color: '#fff', borderRadius: 10 }}
            onClick={onBack}
          >
            Done
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Import Statement</h1>
        {status === 'done' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <SortMenuButton
              options={[{ value: 'recent', label: 'Newest First' }, { value: 'oldest', label: 'Oldest First' }]}
              value={sort}
              onChange={setSort}
            />
            <button
              className="text-button"
              style={{ color: selectMode ? 'var(--blue)' : undefined }}
              onClick={() => { setSelectMode((v) => !v); setSelectedForBulkTag(new Set()) }}
            >
              {selectMode ? 'Cancel' : 'Select'}
            </button>
            {!selectMode && <button className="text-button text-button-primary" onClick={handleImport}>Import ({included.size})</button>}
          </div>
        )}
        {status !== 'done' && <span style={{ width: 60 }} />}
      </div>

      {status === 'idle' && (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
            Scans a banking app screenshot, payment notification screenshot, or Beem activity screenshot and pulls out transactions automatically.
            Runs entirely on your device using free OCR — accuracy won't quite match a native app, so double-check the results before importing.
            Screenshot the plain transaction list rather than a search results screen if you can — confirmed directly that a highlighted search match is much harder to read correctly than ordinary text.
          </p>
          <label className="list-button" style={{ display: 'block', textAlign: 'center', background: 'var(--blue)', color: '#fff', borderRadius: 10, padding: 12, fontWeight: 600, marginBottom: 10 }}>
            Choose Photo(s)
            <input type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
          </label>
          <label className="list-button" style={{ display: 'block', textAlign: 'center', background: 'var(--surface-2)', color: 'var(--blue)', borderRadius: 10, padding: 12, fontWeight: 600 }}>
            Choose PDF Statement
            <input type="file" accept="application/pdf" style={{ display: 'none' }} onChange={(e) => handlePdfFile(e.target.files)} />
          </label>
        </div>
      )}

      {status === 'scanning' && (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <p style={{ fontSize: 14, color: 'var(--text-dim)' }}>{scanProgress}</p>
        </div>
      )}

      {status === 'done' && (
        <>
          {formatsSeen.size > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                Detected as: {[...formatsSeen].map((f) => FORMAT_LABELS[f]).join(', ')}
              </span>
            </div>
          )}

          {accounts.length > 0 && (
            <button className="card" style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', textAlign: 'left' }} onClick={() => setShowAccountPicker(true)}>
              <span style={{ fontSize: 13 }}>
                Import to: <b>{accounts.find((a) => a.id === importAccountId)?.name ?? 'No account'}</b>
              </span>
              <span className="chevron">›</span>
            </button>
          )}

          {(() => {
            const activeResolutions = [...pendingFareResolutions.keys()].filter((id) => !skippedResolutions.has(id))
            return activeResolutions.length > 0 && (
              <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--blue)' }}>
                <span style={{ fontSize: 13, color: 'var(--blue)', fontWeight: 600 }}>🚎 {activeResolutions.length} pending fare{activeResolutions.length === 1 ? '' : 's'} will be updated with the real amount</span>
                <p className="hint" style={{ marginTop: 6 }}>Instead of creating new transactions, these replace the matching stale $1.00 placeholder already in your history — tap any of them below if you'd rather import it as new.</p>
              </div>
            )
          })()}

          {sparseScanWarning && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--amber)' }}>
              <span style={{ fontSize: 13, color: 'var(--amber)', fontWeight: 600 }}>⚠️ Possibly incomplete scan</span>
              <p className="hint" style={{ marginTop: 6 }}>{sparseScanWarning}</p>
            </div>
          )}

          {skippedRows.length > 0 && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--red)' }}>
              <span style={{ fontSize: 13, color: 'var(--red)', fontWeight: 600 }}>{skippedRows.length} row{skippedRows.length === 1 ? '' : 's'} couldn't be read cleanly</span>
              <p className="hint" style={{ marginTop: 6 }}>Skipped rather than guessed, so nothing wrong got imported. Add these manually if needed.</p>
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {skippedRows.map((row, i) => (
                  <p key={i} style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'monospace', margin: 0, wordBreak: 'break-word' }}>{row}</p>
                ))}
              </div>
            </div>
          )}

          {duplicateIds.size > 0 && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--amber)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 13, color: 'var(--amber)', fontWeight: 600 }}>{duplicateIds.size} possible duplicate{duplicateIds.size === 1 ? '' : 's'} found and left unchecked</span>
                <input type="checkbox" switch checked={hideDuplicates} onChange={(e) => setHideDuplicates(e.target.checked)} />
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Hide duplicates from this list</span>
            </div>
          )}

          {outlierIds.size > 0 && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--red)' }}>
              <span style={{ fontSize: 13, color: 'var(--red)', fontWeight: 600 }}>{outlierIds.size} unusually large amount{outlierIds.size === 1 ? '' : 's'} found</span>
              <p className="hint" style={{ marginTop: 6 }}>Still included, but significantly bigger than the rest of this batch — worth double-checking against your bank app.</p>
            </div>
          )}

          {pendingFareIds.size > 0 && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--teal)' }}>
              <span style={{ fontSize: 13, color: 'var(--teal)', fontWeight: 600 }}>{pendingFareIds.size} possible pending transit fare{pendingFareIds.size === 1 ? '' : 's'}</span>
              <p className="hint" style={{ marginTop: 6 }}>Opal/TfNSW often shows a small placeholder charge that gets corrected to the real fare later. Included for now — edit the amount once the real fare shows up, rather than leaving both.</p>
            </div>
          )}

          {splitBillResults.length > 0 && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--purple)' }}>
              <span style={{ fontSize: 13, color: 'var(--purple)', fontWeight: 600 }}>{splitBillResults.length} split bill share{splitBillResults.length === 1 ? '' : 's'} found</span>
              <p className="hint" style={{ marginTop: 6 }}>Each imports as income only — the full expense isn't created here, since it'll come in separately from your bank import. Tap "Link to expense" on a share once that expense is visible (in this same batch, or already in your transactions) to mark it as a reimbursement.</p>
            </div>
          )}

          {results.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>No transactions found — try a clearer photo, or add these manually.</p>}

          {(() => {
            const visible = [...(hideDuplicates ? results.filter((r) => !duplicateIds.has(r.id)) : results)]
              .sort((a, b) => sort === 'recent' ? b.date.localeCompare(a.date) : a.date.localeCompare(b.date))
            return (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {visible.map((r, i) => {
                  const cat = categoryFor(r) ? catById.get(categoryFor(r)!) : undefined
                  const tags = tagsFor(r)
                  return (
                    <div
                      key={r.id}
                      className="transaction-row"
                      style={{
                        borderBottom: i < visible.length - 1 ? '1px solid var(--border)' : 'none',
                        background: selectMode && selectedForBulkTag.has(r.id) ? 'var(--surface-2)' : undefined
                      }}
                      onClick={selectMode ? () => toggleSelectedForBulkTag(r.id) : undefined}
                    >
                  {/* Same checkbox slot, two different meanings depending on
                     mode — reflects "include in import" normally, and
                     "selected for bulk tagging" while Select mode is
                     active, rather than a second checkbox competing for
                     the same small row alongside it. */}
                  <input
                    type="checkbox"
                    checked={selectMode ? selectedForBulkTag.has(r.id) : included.has(r.id)}
                    onChange={() => selectMode ? toggleSelectedForBulkTag(r.id) : toggle(r.id)}
                    onClick={(e) => selectMode && e.stopPropagation()}
                    style={{ width: 18, height: 18 }}
                  />
                  <div className="tx-info">
                    <span className="tx-note">
                      {r.note}
                      {outlierIds.has(r.id) && <span style={{ color: 'var(--red)' }}> 🚩</span>}
                      {pendingFareIds.has(r.id) && <span> 🚊</span>}
                    </span>
                    {r.noteUnreliable && (
                      <span style={{ fontSize: 12, color: 'var(--amber)' }}>
                        ⚠️ Couldn't read the merchant name clearly — check the original screenshot
                      </span>
                    )}
                    <span className="tx-category">
                      {new Date(r.date).toLocaleDateString('en-AU')}
                      {!r.isExpense && r.splitInfo && ` · share of a bill split ${r.splitInfo.totalPeople} ways`}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); setPickingCategoryFor(r.id) }} style={{ fontSize: 12, color: 'var(--blue)' }}>
                      {cat ? `${cat.icon} ${cat.name}` : 'Set category'}
                    </button>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: tags.length > 0 ? 4 : 0 }}>
                      {tags.map((t) => (
                        <span key={t} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 12, background: 'var(--surface-2)', color: 'var(--purple)' }}>{t}</span>
                      ))}
                      <button onClick={(e) => { e.stopPropagation(); setEditingTagsFor(r.id) }} style={{ fontSize: 12, color: 'var(--blue)' }}>
                        {tags.length > 0 ? '+ tag' : '+ Tags'}
                      </button>
                    </div>
                    {!r.isExpense && (() => {
                      const linked = linkedTarget(r)
                      return (
                        <button onClick={(e) => { e.stopPropagation(); setLinkingFor(r) }} style={{ fontSize: 12, color: linked ? 'var(--purple)' : 'var(--blue)', textAlign: 'left' }}>
                          {linked ? `🔀 Reimburses "${linked.note}" (${formatCurrency(linked.amount)})` : '🔀 Link to expense'}
                        </button>
                      )
                    })()}
                    {duplicateIds.has(r.id) && (
                      <button onClick={(e) => { e.stopPropagation(); setViewingDuplicateFor(r) }} style={{ fontSize: 12, color: 'var(--amber)', textAlign: 'left' }}>
                        ⚠️ Possible duplicate — tap to compare
                      </button>
                    )}
                    {pendingFareResolutions.has(r.id) && !skippedResolutions.has(r.id) && (() => {
                      const match = pendingFareResolutions.get(r.id)!
                      return (
                        <button
                          onClick={(e) => { e.stopPropagation(); setSkippedResolutions((prev) => new Set(prev).add(r.id)) }}
                          style={{ fontSize: 12, color: 'var(--blue)', textAlign: 'left' }}
                        >
                          🚎 Updates pending {formatCurrency(match.amount)} fare from {new Date(match.date).toLocaleDateString('en-AU')} — tap to import as new instead
                        </button>
                      )
                    })()}
                    {pendingFareResolutions.has(r.id) && skippedResolutions.has(r.id) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setSkippedResolutions((prev) => { const next = new Set(prev); next.delete(r.id); return next }) }}
                        style={{ fontSize: 12, color: 'var(--text-dim)', textAlign: 'left' }}
                      >
                        Will import as new — tap to update the pending fare instead
                      </button>
                    )}
                  </div>
                  <span className="amount tx-amount" style={{ color: r.isExpense ? 'var(--text)' : 'var(--green)' }}>
                    {r.isExpense ? '-' : '+'}{formatCurrency(r.amount)}
                  </span>
                </div>
              )
            })}
              </div>
            )
          })()}

          <button className="list-button" style={{ marginTop: 16, color: 'var(--text-dim)', fontSize: 13 }} onClick={() => setStatus('idle')}>Scan More Photos</button>
        </>
      )}

      {selectMode && (
        <div className="sticky-action-bar" style={{ position: 'sticky', bottom: 0, display: 'flex', gap: 10, padding: '10px 16px', background: 'var(--surface-1)', borderTop: '1px solid var(--border)' }}>
          <span style={{ flex: 1, alignSelf: 'center', fontSize: 13, color: 'var(--text-dim)' }}>
            {selectedForBulkTag.size === 0 ? 'Tap rows to select' : `${selectedForBulkTag.size} selected`}
          </span>
          <button
            className="text-button text-button-primary"
            style={{ padding: '8px 16px', borderRadius: 10, background: selectedForBulkTag.size > 0 ? 'var(--blue)' : 'var(--surface-2)', color: selectedForBulkTag.size > 0 ? '#fff' : 'var(--text-faint)' }}
            disabled={selectedForBulkTag.size === 0}
            onClick={() => { setPendingBulkTags([]); setBulkTagging(true) }}
          >
            Tag {selectedForBulkTag.size > 0 ? selectedForBulkTag.size : ''}
          </button>
        </div>
      )}

      {pickingCategoryFor && (
        <div className={`modal-backdrop${pickingCategoryClose.closing ? ' modal-closing' : ''}`} onClick={() => pickingCategoryClose.requestClose()}>
          <div className={`modal-sheet${pickingCategoryClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Category</span>
              <button className="text-button text-button-primary" onClick={() => pickingCategoryClose.requestClose()}>Done</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => pickingCategoryClose.requestClose(() => applyCategory(pickingCategoryFor, null))}>
                <span>None</span>
              </button>
              {categories.filter((c) => !c.parentId).map((c) => (
                <div key={c.id}>
                  <button className="picker-row" onClick={() => pickingCategoryClose.requestClose(() => applyCategory(pickingCategoryFor, c.id))}>
                    <span>{c.icon} {c.name}</span>
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => pickingCategoryClose.requestClose(() => applyCategory(pickingCategoryFor, s.id))}>
                      <span>{s.icon} {s.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {editingTagsFor && (() => {
        const row = results.find((r) => r.id === editingTagsFor)
        if (!row) return null
        return (
          <div className={`modal-backdrop${editingTagsClose.closing ? ' modal-closing' : ''}`} onClick={() => editingTagsClose.requestClose()}>
            <div className={`modal-sheet${editingTagsClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Tags for "{row.note}"</span>
                <button className="text-button text-button-primary" onClick={() => editingTagsClose.requestClose()}>Done</button>
              </div>
              <div className="modal-body">
                <TagEditor
                  tags={tagsFor(row)}
                  onChange={(tags) => setTagsForRow(row.id, tags)}
                  existingTags={existingTagsList}
                  autoFocus
                />
              </div>
            </div>
          </div>
        )
      })()}
      {bulkTagging && (
        <div className={`modal-backdrop${bulkTagClose.closing ? ' modal-closing' : ''}`} onClick={() => bulkTagClose.requestClose()}>
          <div className={`modal-sheet${bulkTagClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Tag {selectedForBulkTag.size} transaction{selectedForBulkTag.size === 1 ? '' : 's'}</span>
              <button
                className="text-button text-button-primary"
                onClick={() => bulkTagClose.requestClose(() => {
                  applyBulkTags(pendingBulkTags)
                  setSelectMode(false)
                  setSelectedForBulkTag(new Set())
                  setBulkTagging(false)
                })}
              >
                Done
              </button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
                Added to every selected row, alongside whatever tags each one already has — not a replacement.
              </p>
              <TagEditor
                tags={pendingBulkTags}
                onChange={setPendingBulkTags}
                existingTags={existingTagsList}
                placeholder="Add a tag, e.g. bali2025"
                autoFocus
              />
            </div>
          </div>
        </div>
      )}
      {viewingDuplicateFor && (
        <div className={`modal-backdrop${viewingDuplicateClose.closing ? ' modal-closing' : ''}`} onClick={() => viewingDuplicateClose.requestClose()}>
          <div className={`modal-sheet${viewingDuplicateClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Compare</span>
              <button className="text-button" onClick={() => viewingDuplicateClose.requestClose()}>Close</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>This scanned row:</p>
              <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 14 }}>{viewingDuplicateFor.note}</div>
                <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>{new Date(viewingDuplicateFor.date).toLocaleDateString('en-AU')}</div>
                <div className="amount" style={{ marginTop: 6, fontSize: 15 }}>{viewingDuplicateFor.isExpense ? '-' : '+'}{formatCurrency(viewingDuplicateFor.amount)}</div>
              </div>
              <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>Looks similar to {matchingExisting(viewingDuplicateFor).length === 1 ? 'this existing transaction' : 'these existing transactions'}:</p>
              {matchingExisting(viewingDuplicateFor).map((t) => (
                <div className="card" key={t.id} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 14 }}>{t.note || 'Uncategorized'}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>{new Date(t.date).toLocaleDateString('en-AU')}</div>
                  <div className="amount" style={{ marginTop: 6, fontSize: 15 }}>{t.isExpense ? '-' : '+'}{formatCurrency(t.amount)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {linkingFor && (() => {
        const candidates = candidateExpenses()
        const currentKey = linkOverrides.get(linkingFor.id)
        return (
          <div className={`modal-backdrop${linkingClose.closing ? ' modal-closing' : ''}`} onClick={() => linkingClose.requestClose()}>
            <div className={`modal-sheet${linkingClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Link to Expense</span>
                <button className="text-button" onClick={() => linkingClose.requestClose()}>Close</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
                  Mark "{linkingFor.note}" ({formatCurrency(linkingFor.amount)}) as a reimbursement for:
                </p>
                {currentKey && (
                  <button className="picker-row" onClick={() => linkingClose.requestClose(() => setLink(linkingFor.id, null))}>
                    <span style={{ color: 'var(--red)' }}>Remove current link</span>
                  </button>
                )}
                {candidates.length === 0 && (
                  <p className="hint" style={{ marginTop: 8 }}>No expense rows found yet — scan the bank statement/screenshot with the actual bill first, or add it manually, then come back here.</p>
                )}
                {candidates.map((c) => (
                  <button key={c.key} className="picker-row" onClick={() => linkingClose.requestClose(() => setLink(linkingFor.id, c.key))}>
                    <span>{c.note}</span>
                    <span className="amount" style={{ fontSize: 13 }}>{formatCurrency(c.amount)} · {new Date(c.date).toLocaleDateString('en-AU')}{c.key === currentKey ? ' ✓' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })()}
      {similarPrompt && (() => {
        const cat = similarPrompt.categoryId ? catById.get(similarPrompt.categoryId) : undefined
        const matches = results.filter((r) => similarPrompt.matchIds.includes(r.id))
        return (
          <div className={`modal-backdrop${similarBatchClose.closing ? ' modal-closing' : ''}`} onClick={() => similarBatchClose.requestClose()}>
            <div className={`modal-sheet${similarBatchClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Similar in This Batch</span>
                <button className="text-button" onClick={() => similarBatchClose.requestClose()}>Close</button>
              </div>
              <div className="modal-body">
                <p style={{ fontSize: 14, marginBottom: 12 }}>
                  {matches.length} other transaction{matches.length === 1 ? '' : 's'} in this batch look{matches.length === 1 ? 's' : ''} similar — set {cat ? `${cat.icon} ${cat.name}` : 'the same category'} for these too? Uncheck any that don't belong.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                  {matches.map((m) => {
                    const checked = similarPromptSelected.has(m.id)
                    return (
                      <button
                        key={m.id}
                        className="card"
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', textAlign: 'left', opacity: checked ? 1 : 0.5 }}
                        onClick={() => setSimilarPromptSelected((prev) => {
                          const next = new Set(prev)
                          if (next.has(m.id)) next.delete(m.id); else next.add(m.id)
                          return next
                        })}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <input type="checkbox" checked={checked} readOnly style={{ width: 18, height: 18 }} />
                          <span style={{ fontSize: 13 }}>{m.note}</span>
                        </span>
                        <span className="amount" style={{ fontSize: 13 }}>{m.isExpense ? '-' : '+'}{formatCurrency(m.amount)}</span>
                      </button>
                    )
                  })}
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="list-button" style={{ flex: 1, textAlign: 'center', color: 'var(--text-dim)' }} onClick={() => similarBatchClose.requestClose()}>Not now</button>
                  <button
                    className="list-button"
                    style={{ flex: 1, textAlign: 'center', background: similarPromptSelected.size > 0 ? 'var(--blue)' : 'var(--surface-2)', color: similarPromptSelected.size > 0 ? '#fff' : 'var(--text-faint)', borderRadius: 10, fontWeight: 600 }}
                    disabled={similarPromptSelected.size === 0}
                    onClick={() => similarBatchClose.requestClose(confirmSimilarPrompt)}
                  >
                    Apply to {similarPromptSelected.size}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {showAccountPicker && (
        <div className="modal-backdrop" onClick={() => setShowAccountPicker(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Import To Account</span>
              <button onClick={() => setShowAccountPicker(false)} className="text-button text-button-primary">Done</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => { setImportAccountId(null); setShowAccountPicker(false) }}>
                <span>No account</span>
                {!importAccountId && <span style={{ color: 'var(--blue)' }}>✓</span>}
              </button>
              {accounts.map((a) => (
                <button key={a.id} className="picker-row" onClick={() => { setImportAccountId(a.id); setShowAccountPicker(false) }}>
                  <span>{a.icon} {a.name}</span>
                  {importAccountId === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
