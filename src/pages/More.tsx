import { useRef, useState } from 'react'
import type { Category, Transaction } from '../types'
import { exportBackup, importBackup, exportCSV, recordManualBackup, daysSinceLastManualBackup } from '../db'
import { getSettings, updateSettings } from '../budgetPeriod'
import DashboardSettings from './DashboardSettings'

function ordinal(n: number): string {
  const suffix = n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'
  return `${n}${suffix}`
}

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onCategoriesChanged: () => void
  onNavigate: (tab: string) => void
}

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

  const backupDays = daysSinceLastManualBackup()
  const backupColor = backupDays === null || backupDays > 14 ? 'var(--red)' : backupDays > 7 ? 'var(--amber)' : 'var(--green)'
  const backupLabel = backupDays === null ? 'Never backed up' : backupDays === 0 ? 'Backed up today' : `Backed up ${backupDays}d ago`

  return (
    <div className="screen">
      <h1 className="screen-title">More</h1>

      {/* Settings — how the app is configured, not something you "do" */}
      <span className="section-heading">Settings</span>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        <button className="transaction-row" style={{ borderBottom: '1px solid var(--border)' }} onClick={() => onNavigate('categories')}>
          <div className="tx-icon" style={{ background: 'var(--surface-2)' }}>🗂️</div>
          <div className="tx-info"><span className="tx-note">Categories</span></div>
          <span className="chevron">›</span>
        </button>
        <button className="transaction-row" style={{ borderBottom: settings.budgetCycleStartDay > 1 ? 'none' : '1px solid var(--border)' }} onClick={() => setShowDashboardSettings(true)}>
          <div className="tx-icon" style={{ background: 'var(--surface-2)' }}>📊</div>
          <div className="tx-info"><span className="tx-note">Customize Dashboard</span></div>
          <span className="chevron">›</span>
        </button>
        <div style={{ padding: '0 16px' }}>
          <div className="transaction-row" style={{ padding: '12px 0', borderBottom: settings.budgetCycleStartDay > 1 ? '1px solid var(--border)' : 'none' }}>
            <div className="tx-icon" style={{ background: 'var(--surface-2)' }}>🔄</div>
            <div className="tx-info"><span className="tx-note">Custom budget cycle</span></div>
            <input type="checkbox" switch checked={settings.budgetCycleStartDay > 1} onChange={(e) => handleCycleDayChange(e.target.checked ? 28 : 1)} />
          </div>
          {settings.budgetCycleStartDay > 1 && (
            <div className="form-row" style={{ padding: '11px 0 4px', borderBottom: 'none' }}>
              <span className="form-row-label" style={{ color: 'var(--text-dim)', fontSize: 13, paddingLeft: 46 }}>Starts on</span>
              <select value={settings.budgetCycleStartDay} onChange={(e) => handleCycleDayChange(parseInt(e.target.value))} style={{ width: 'auto' }}>
                {Array.from({ length: 27 }, (_, i) => i + 2).map((day) => (
                  <option key={day} value={day}>{ordinal(day)} of the month</option>
                ))}
              </select>
            </div>
          )}
          <p className="hint" style={{ marginTop: 4, marginBottom: 12 }}>If "this month" should reset on payday instead of the 1st — Safe to Spend, budgets, and Insights all shift together.</p>
        </div>
      </div>

      {/* Tools — things you actively do or analyze */}
      <span className="section-heading">Tools</span>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        {[
          { tab: 'import', icon: '📷', label: 'Import Statement (Photo)' },
          { tab: 'monthlyrecap', icon: '📅', label: 'Month in Review' },
          { tab: 'budgetplanner', icon: '🧮', label: 'Total Budget Planner' },
          { tab: 'categorybreakdown', icon: '🥧', label: 'Spending by Category (by Month)' },
          { tab: 'tags', icon: '🏷️', label: 'Tags' },
          { tab: 'recurring', icon: '🔁', label: 'Recurring' },
          { tab: 'shopping', icon: '🛒', label: 'Shopping Lists' },
          { tab: 'report', icon: '📆', label: 'Custom Date Range Report' },
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

      {/* Data — getting information in or out */}
      <span className="section-heading">Data</span>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-row">
          <span className="form-row-label">Backup status</span>
          <span style={{ fontSize: 13, color: backupColor, fontWeight: 600 }}>{backupLabel}</span>
        </div>
        <button className="list-button" style={{ padding: '13px 0', borderBottom: '0.5px solid var(--border)' }} onClick={handleExport}>Export Full Backup</button>
        <button className="list-button" style={{ padding: '13px 0', borderBottom: '0.5px solid var(--border)' }} onClick={() => fileInput.current?.click()}>Restore from Backup</button>
        <input ref={fileInput} type="file" accept="application/json" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && handleImportFile(e.target.files[0])} />
        <button className="list-button" style={{ padding: '13px 0', borderBottom: '0.5px solid var(--border)' }} onClick={() => onNavigate('autobackups')}>View Automatic Backups</button>
        <button className="list-button" style={{ padding: '13px 0' }} onClick={handleExportCSV}>Export to CSV</button>
        {status && <p style={{ fontSize: 13, color: status.startsWith('Import failed') ? 'var(--red)' : 'var(--green)', marginTop: 10 }}>{status}</p>}
        <p className="hint" style={{ marginTop: 10 }}>Automatic local snapshots are taken periodically as a safety net against accidental deletion — but they live in the same on-device storage as your live data, so they won't survive iOS clearing this site's storage entirely. Exporting a file (Files, email) is the only backup that survives that.</p>
      </div>
    </div>
  )
}
