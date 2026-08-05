import { useState } from 'react'
import type { Category, Transaction } from '../types'
import { recognizeTextItems } from '../ocr'
import { parseScreenshot, type ParsedTransaction, type DetectedFormat } from '../receiptParser'
import { significantTokens } from '../duplicates'
import { formatCurrency } from '../calculations'
import { createTransaction } from '../db'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  existingTransactions: Transaction[]
  onBack: () => void
  onImported: () => void
}

const FORMAT_LABELS: Record<DetectedFormat, string> = {
  appScreenshot: 'Banking app screenshot',
  notificationScreenshot: 'Payment notification screenshot',
  unknown: 'Unrecognized format'
}

export default function StatementImport({ categories, existingTransactions, onBack, onImported }: Props) {
  useSwipeBack(onBack)
  const [status, setStatus] = useState<'idle' | 'scanning' | 'done'>('idle')
  const [scanProgress, setScanProgress] = useState('')
  const [results, setResults] = useState<ParsedTransaction[]>([])
  const [skippedRows, setSkippedRows] = useState<string[]>([])
  const [formatsSeen, setFormatsSeen] = useState<Set<DetectedFormat>>(new Set())
  const [included, setIncluded] = useState<Set<string>>(new Set())
  const [categoryOverrides, setCategoryOverrides] = useState<Map<string, string | null>>(new Map())
  const [pickingCategoryFor, setPickingCategoryFor] = useState<string | null>(null)

  const [viewingDuplicateFor, setViewingDuplicateFor] = useState<ParsedTransaction | null>(null)

  function matchingExisting(r: ParsedTransaction): Transaction[] {
    return existingTransactions.filter((t) => {
      if (Math.abs(t.amount - r.amount) >= 0.01) return false
      if (t.isExpense !== r.isExpense) return false
      const sameDay = new Date(t.date).toDateString() === new Date(r.date).toDateString()
      const sharesToken = [...significantTokens(r.note)].some((tok) => significantTokens(t.note).has(tok))
      return sameDay || sharesToken
    })
  }

  const duplicateIds = new Set(results.filter((r) => matchingExisting(r).length > 0).map((r) => r.id))

  // Flagged but still checked by default — worth a second glance, not
  // assumed wrong. Median taken across this batch's expense amounts.
  const outlierIds = (() => {
    const amounts = results.filter((r) => r.isExpense).map((r) => r.amount).sort((a, b) => a - b)
    if (amounts.length < 5) return new Set<string>()
    const median = amounts[Math.floor(amounts.length / 2)]
    if (median <= 0) return new Set<string>()
    return new Set(results.filter((r) => r.isExpense && r.amount > Math.max(median * 10, 300)).map((r) => r.id))
  })()

  const transitKeywords = ['opal', 'transportfornsw', 'transport for nsw', 'tfnsw']
  const pendingFareIds = new Set(
    results
      .filter((r) => r.isExpense && r.amount <= 2 && transitKeywords.some((k) => r.note.toLowerCase().includes(k)))
      .map((r) => r.id)
  )

  async function handlePdfFile(files: FileList | null) {
    if (!files || files.length === 0) return
    setStatus('scanning')
    setResults([])
    setSkippedRows([])
    setScanProgress('Reading PDF\u2026')
    try {
      const { parsePdfStatement } = await import('../pdfParser')
      const { transactions, skipped } = await parsePdfStatement(files[0])
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
    const allResults: ParsedTransaction[] = []
    const allSkipped: string[] = []
    const formats = new Set<DetectedFormat>()

    for (let i = 0; i < files.length; i++) {
      setScanProgress(`Reading photo ${i + 1} of ${files.length}\u2026`)
      try {
        const items = await recognizeTextItems(files[i])
        const { transactions, skipped, format } = await parseScreenshot(items)
        allResults.push(...transactions)
        allSkipped.push(...skipped)
        formats.add(format)
      } catch {
        allSkipped.push(`(Photo ${i + 1} couldn't be read)`)
      }
    }

    setResults(allResults)
    setSkippedRows(allSkipped)
    setFormatsSeen(formats)
    setIncluded(new Set(allResults.filter((r) => matchingExisting(r).length === 0).map((r) => r.id)))
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

  async function handleImport() {
    const toImport = results.filter((r) => included.has(r.id))
    for (const r of toImport) {
      await createTransaction({
        amount: r.amount,
        note: r.note,
        date: r.date,
        isExpense: r.isExpense,
        categoryId: categoryFor(r),
        reimbursesExpenseId: null
      })
    }
    onImported()
    onBack()
  }

  const catById = new Map(categories.map((c) => [c.id, c]))

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Import Statement</h1>
        {status === 'done' && (
          <button className="text-button text-button-primary" onClick={handleImport}>Import ({included.size})</button>
        )}
        {status !== 'done' && <span style={{ width: 60 }} />}
      </div>

      {status === 'idle' && (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
            Scans a banking app screenshot or payment notification screenshot and pulls out transactions automatically.
            Runs entirely on your device using free OCR — accuracy won't quite match a native app, so double-check the results before importing.
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

          {skippedRows.length > 0 && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--red)' }}>
              <span style={{ fontSize: 13, color: 'var(--red)', fontWeight: 600 }}>{skippedRows.length} row{skippedRows.length === 1 ? '' : 's'} couldn't be read cleanly</span>
              <p className="hint" style={{ marginTop: 6 }}>Skipped rather than guessed, so nothing wrong got imported. Add these manually if needed.</p>
            </div>
          )}

          {duplicateIds.size > 0 && (
            <div className="card" style={{ marginBottom: 12, borderLeft: '3px solid var(--amber)' }}>
              <span style={{ fontSize: 13, color: 'var(--amber)', fontWeight: 600 }}>{duplicateIds.size} possible duplicate{duplicateIds.size === 1 ? '' : 's'} found and left unchecked</span>
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

          {results.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>No transactions found — try a clearer photo, or add these manually.</p>}

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {results.map((r, i) => {
              const cat = categoryFor(r) ? catById.get(categoryFor(r)!) : undefined
              return (
                <div key={r.id} className="transaction-row" style={{ borderBottom: i < results.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <input type="checkbox" checked={included.has(r.id)} onChange={() => toggle(r.id)} style={{ width: 18, height: 18 }} />
                  <div className="tx-info">
                    <span className="tx-note">
                      {r.note}
                      {outlierIds.has(r.id) && <span style={{ color: 'var(--red)' }}> 🚩</span>}
                      {pendingFareIds.has(r.id) && <span> 🚊</span>}
                    </span>
                    <button onClick={() => setPickingCategoryFor(r.id)} style={{ fontSize: 12, color: 'var(--blue)' }}>
                      {cat ? `${cat.icon} ${cat.name}` : 'Set category'}
                    </button>
                    {duplicateIds.has(r.id) && (
                      <button onClick={() => setViewingDuplicateFor(r)} style={{ fontSize: 12, color: 'var(--amber)', textAlign: 'left' }}>
                        ⚠️ Possible duplicate — tap to compare
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

          <button className="list-button" style={{ marginTop: 16, color: 'var(--text-dim)', fontSize: 13 }} onClick={() => setStatus('idle')}>Scan More Photos</button>
        </>
      )}

      {pickingCategoryFor && (
        <div className="modal-backdrop" onClick={() => setPickingCategoryFor(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Category</span>
              <button className="text-button text-button-primary" onClick={() => setPickingCategoryFor(null)}>Done</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => { setCategoryOverrides((m) => new Map(m).set(pickingCategoryFor, null)); setPickingCategoryFor(null) }}>
                <span>None</span>
              </button>
              {categories.filter((c) => !c.parentId).map((c) => (
                <div key={c.id}>
                  <button className="picker-row" onClick={() => { setCategoryOverrides((m) => new Map(m).set(pickingCategoryFor, c.id)); setPickingCategoryFor(null) }}>
                    <span>{c.icon} {c.name}</span>
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => { setCategoryOverrides((m) => new Map(m).set(pickingCategoryFor, s.id)); setPickingCategoryFor(null) }}>
                      <span>{s.icon} {s.name}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {viewingDuplicateFor && (
        <div className="modal-backdrop" onClick={() => setViewingDuplicateFor(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()} style={{ padding: 20 }}>
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
            <button className="list-button" style={{ width: '100%', textAlign: 'center', color: 'var(--text-dim)', marginTop: 8 }} onClick={() => setViewingDuplicateFor(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
