import { useRef, useState } from 'react'
import type { Category, Transaction } from '../types'
import { exportBackup, importBackup, exportCSV, recordManualBackup, daysSinceLastManualBackup } from '../db'
import { getSettings, updateSettings } from '../budgetPeriod'
import { requestNotificationPermission, notificationPermissionStatus } from '../notifications'
import DashboardSettings from './DashboardSettings'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onCategoriesChanged: () => void
  onNavigate: (tab: string) => void
}

const PENDING_FEATURES: string[] = []

export default function More({ categories, transactions, onCategoriesChanged, onNavigate }: Props) {
  const [status, setStatus] = useState<string | null>(null)
  const [settings, setSettings] = useState(getSettings())
  const [showDashboardSettings, setShowDashboardSettings] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  async function handleExport() {
    const json = await exportBackup()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `BudgetTracker_Backup_${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    recordManualBackup()
    setStatus('Backup downloaded.')
  }

  function handleExportCSV() {
    const csv = exportCSV(transactions, categories)
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `BudgetTracker_Export_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleCycleDayChange(value: number) {
    updateSettings({ budgetCycleStartDay: value })
    setSettings(getSettings())
  }

  async function handleNudgeToggle(enabled: boolean) {
    if (enabled) {
      const granted = await requestNotificationPermission()
      if (!granted) { setStatus('Notification permission denied by browser.'); return }
    }
    updateSettings({ nudgeEnabled: enabled })
    setSettings(getSettings())
  }

  async function handleImportFile(file: File) {
    try {
      const text = await file.text()
      const result = await importBackup(text)
      onCategoriesChanged()
      setStatus(`Restored ${result.categoriesCount} categories and ${result.transactionsCount} transactions.`)
    } catch (err) {
      setStatus(`Import failed: ${err instanceof Error ? err.message : 'something went wrong reading that file.'}`)
    }
  }

  if (showDashboardSettings) {
    return <DashboardSettings onBack={() => setShowDashboardSettings(false)} />
  }

  return (
    <div className="screen">
      <h1 className="screen-title">More</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <button className="list-button" style={{ fontWeight: 600 }} onClick={() => onNavigate('import')}>📷 Import Statement (Photo)</button>
      </div>

      <span className="section-heading">Settings</span>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        <button className="transaction-row" style={{ borderBottom: '1px solid var(--border)' }} onClick={() => onNavigate('categories')}>
          <div className="tx-icon" style={{ background: 'var(--surface-2)' }}>🗂️</div>
          <div className="tx-info"><span className="tx-note">Categories</span></div>
          <span className="chevron">›</span>
        </button>
        <button className="transaction-row" onClick={() => setShowDashboardSettings(true)}>
          <div className="tx-icon" style={{ background: 'var(--surface-2)' }}>📊</div>
          <div className="tx-info"><span className="tx-note">Customize Dashboard</span></div>
          <span className="chevron">›</span>
        </button>
      </div>

      <span className="section-heading">Tools</span>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        {[
          { tab: 'monthlyrecap', icon: '📊', label: 'Month in Review' },
          { tab: 'budgetplanner', icon: '🧮', label: 'Total Budget Planner' },
          { tab: 'categorybreakdown', icon: '🥧', label: 'Spending by Category (by Month)' },
          { tab: 'recurring', icon: '🔁', label: 'Recurring' },
          { tab: 'shopping', icon: '🛒', label: 'Shopping Lists' },
          { tab: 'report', icon: '📅', label: 'Custom Date Range Report' },
          { tab: 'duplicates', icon: '📑', label: 'Duplicate Check' },
          { tab: 'health', icon: '❤️', label: 'Health Check' },
          { tab: 'merchants', icon: '🧠', label: 'Learned Merchants' }
        ].map((item, i, arr) => (
          <button key={item.tab} className="transaction-row" style={{ borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }} onClick={() => onNavigate(item.tab)}>
            <div className="tx-icon" style={{ background: 'var(--surface-2)' }}>{item.icon}</div>
            <div className="tx-info"><span className="tx-note">{item.label}</span></div>
            <span className="chevron">›</span>
          </button>
        ))}
      </div>

      <span className="section-heading">Budget Cycle</span>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" switch checked={settings.budgetCycleStartDay > 1} onChange={(e) => handleCycleDayChange(e.target.checked ? 28 : 1)} />
          <span>Custom budget cycle</span>
        </div>
        {settings.budgetCycleStartDay > 1 && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Starts on day</span>
            <input type="number" min={2} max={28} value={settings.budgetCycleStartDay} onChange={(e) => handleCycleDayChange(Math.min(28, Math.max(2, parseInt(e.target.value) || 2)))} style={{ width: 60 }} />
          </div>
        )}
        <p className="hint" style={{ marginTop: 10 }}>If "this month" should reset on payday instead of the 1st — Safe to Spend, budgets, and Insights all shift together.</p>
      </div>

      <span className="section-heading">Reminders</span>
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input type="checkbox" switch checked={settings.nudgeEnabled} onChange={(e) => handleNudgeToggle(e.target.checked)} />
          <span>Nudge me if I haven't logged anything in a few days</span>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Honest limitation: iOS can't reliably deliver a scheduled notification while the app is closed without a real backend server, which this app deliberately doesn't have. This checks on each app open instead — not a true scheduled reminder, but the closest honest equivalent.
          {notificationPermissionStatus() === 'denied' && ' Notifications are currently blocked for this site in your browser settings.'}
        </p>
      </div>

      <span className="section-heading">Export</span>
      <div className="card" style={{ marginBottom: 16 }}>
        <button className="list-button" onClick={handleExportCSV}>Export to CSV</button>
      </div>

      <span className="section-heading">Backup & Restore</span>
      <div className="card" style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(() => {
          const days = daysSinceLastManualBackup()
          const color = days === null || days > 14 ? 'var(--red)' : days > 7 ? 'var(--amber)' : 'var(--green)'
          const label = days === null ? 'Never backed up manually' : days === 0 ? 'Backed up today' : `Backed up ${days} day${days === 1 ? '' : 's'} ago`
          return <p style={{ fontSize: 13, color, margin: 0, fontWeight: 600 }}>{label}</p>
        })()}
        <button className="list-button" onClick={handleExport}>Export Full Backup</button>
        <button className="list-button" onClick={() => fileInput.current?.click()}>Restore from Backup</button>
        <input ref={fileInput} type="file" accept="application/json" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && handleImportFile(e.target.files[0])} />
        <button className="list-button" onClick={() => onNavigate('autobackups')}>View Automatic Backups</button>
        {status && <p style={{ fontSize: 13, color: status.startsWith('Import failed') ? 'var(--red)' : 'var(--green)', margin: 0 }}>{status}</p>}
        <p className="hint">Automatic local snapshots are taken periodically as a safety net against accidental deletion — but they live in the same on-device storage as your live data, so they won't survive iOS clearing this site's storage entirely. Exporting a file (Files, email) is the only backup that survives that.</p>
      </div>

      {PENDING_FEATURES.length > 0 && (
        <>
          <span className="section-heading">Not built yet in this version</span>
          <div className="card">
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.8 }}>
              {PENDING_FEATURES.map((f) => <li key={f}>{f}</li>)}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
