import { useEffect, useState } from 'react'
import { listAutoBackups, restoreAutoBackup } from '../db'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  onBack: () => void
  onRestored: () => void
}

export default function AutoBackups({ onBack, onRestored }: Props) {
  useSwipeBack(onBack)
  const [backups, setBackups] = useState<{ id: string; createdAt: string }[]>([])
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    listAutoBackups().then((all) => setBackups(all.map((b) => ({ id: b.id, createdAt: b.createdAt }))))
  }, [])

  async function handleRestore(id: string) {
    if (!confirm('Replace your current data with this snapshot? Anything added since won\u2019t be removed, but this could overwrite recent changes.')) return
    try {
      const result = await restoreAutoBackup(id)
      setStatus(`Restored ${result.categoriesCount} categories and ${result.transactionsCount} transactions.`)
      onRestored()
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Restore failed.')
    }
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Automatic Backups</h1>
        <span style={{ width: 60 }} />
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
        Taken automatically about every 12 hours you use the app, keeping the last 5. A safety net against accidental deletion or a bad edit — not a substitute for exporting a real backup file periodically.
      </p>

      {status && <p style={{ fontSize: 13, color: 'var(--green)', marginBottom: 16 }}>{status}</p>}

      {backups.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>None yet — the first one is taken automatically next time you open the app.</p>}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {backups.map((b, i) => (
          <button key={b.id} className="transaction-row" style={{ borderBottom: i < backups.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => handleRestore(b.id)}>
            <div className="tx-info">
              <span className="tx-note">{new Date(b.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
              <span className="tx-category">{new Date(b.createdAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
            <span className="chevron">›</span>
          </button>
        ))}
      </div>
    </div>
  )
}
