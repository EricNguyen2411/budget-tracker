import { useRef, useState } from 'react'
import type { Category, Transaction } from '../types'
import { exportBackup, importBackup, exportCSV, createCategory, saveCategory, deleteCategory } from '../db'
import { getSettings, updateSettings } from '../budgetPeriod'
import { requestNotificationPermission, notificationPermissionStatus } from '../notifications'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onCategoriesChanged: () => void
  onNavigate: (tab: string) => void
}

const PENDING_FEATURES = [
  'Statement/receipt photo import (OCR) — different tech stack entirely (browser OCR vs. Apple Vision), planned as its own focused build'
]

export default function More({ categories, transactions, onCategoriesChanged, onNavigate }: Props) {
  const [editingCategory, setEditingCategory] = useState<Category | 'new' | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [settings, setSettings] = useState(getSettings())
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

  return (
    <div className="screen">
      <h1 className="screen-title">More</h1>

      <span className="section-heading">Categories</span>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        {categories.filter((c) => !c.parentId).map((c) => {
          const subs = categories.filter((s) => s.parentId === c.id)
          return (
            <div key={c.id}>
              <button className="transaction-row" style={{ borderBottom: '1px solid var(--border)' }} onClick={() => setEditingCategory(c)}>
                <div className="tx-icon" style={{ background: c.color + '33' }}>{c.icon}</div>
                <div className="tx-info">
                  <span className="tx-note">{c.name}</span>
                  {c.isSavingsCategory && <span className="tx-category">Savings</span>}
                </div>
                <span className="chevron">›</span>
              </button>
              {subs.map((s) => (
                <button key={s.id} className="transaction-row" style={{ borderBottom: '1px solid var(--border)', paddingLeft: 34 }} onClick={() => setEditingCategory(s)}>
                  <div className="tx-icon" style={{ background: s.color + '33', width: 30, height: 30 }}>{s.icon}</div>
                  <div className="tx-info"><span className="tx-note" style={{ fontSize: 14 }}>{s.name}</span></div>
                  <span className="chevron">›</span>
                </button>
              ))}
            </div>
          )
        })}
        <button className="transaction-row" onClick={() => setEditingCategory('new')}>
          <div className="tx-info"><span className="tx-note" style={{ color: 'var(--blue)' }}>+ Add Category</span></div>
        </button>
      </div>

      <span className="section-heading">Tools</span>
      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        {[
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
          <input type="checkbox" checked={settings.budgetCycleStartDay > 1} onChange={(e) => handleCycleDayChange(e.target.checked ? 28 : 1)} style={{ width: 18, height: 18 }} />
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
          <input type="checkbox" checked={settings.nudgeEnabled} onChange={(e) => handleNudgeToggle(e.target.checked)} style={{ width: 18, height: 18 }} />
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
        <button className="list-button" onClick={handleExport}>Export Full Backup</button>
        <button className="list-button" onClick={() => fileInput.current?.click()}>Restore from Backup</button>
        <input ref={fileInput} type="file" accept="application/json" style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && handleImportFile(e.target.files[0])} />
        {status && <p style={{ fontSize: 13, color: status.startsWith('Import failed') ? 'var(--red)' : 'var(--green)', margin: 0 }}>{status}</p>}
        <p className="hint">Downloads/restores a JSON file — save it somewhere safe (Files, email) periodically. There's no automatic backup yet in this web version.</p>
      </div>

      <span className="section-heading">Not built yet in this version</span>
      <div className="card">
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.8 }}>
          {PENDING_FEATURES.map((f) => <li key={f}>{f}</li>)}
        </ul>
      </div>

      {editingCategory && (
        <CategoryEditor
          category={editingCategory === 'new' ? null : editingCategory}
          allCategories={categories}
          onClose={() => setEditingCategory(null)}
          onChanged={onCategoriesChanged}
        />
      )}
    </div>
  )
}

function CategoryEditor({ category, allCategories, onClose, onChanged }: {
  category: Category | null
  allCategories: Category[]
  onClose: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState(category?.icon ?? '📦')
  const [color, setColor] = useState(category?.color ?? '#34C759')
  const [budget, setBudget] = useState(category?.monthlyBudget ? String(category.monthlyBudget) : '')
  const [isSavings, setIsSavings] = useState(category?.isSavingsCategory ?? false)
  const [parentId, setParentId] = useState<string | null>(category?.parentId ?? null)
  const [isGoalToggle, setIsGoalToggle] = useState((category?.goalTargetAmount ?? 0) > 0)
  const [goalAmount, setGoalAmount] = useState(category?.goalTargetAmount ? String(category.goalTargetAmount) : '')
  const [hasGoalDate, setHasGoalDate] = useState(!!category?.goalTargetDate)
  const [goalDate, setGoalDate] = useState(category?.goalTargetDate?.slice(0, 10) ?? '')

  // Only top-level categories without their own subcategories can be a
  // parent — one level of nesting only, and a category that already has
  // children can't itself become a child (and can't be its own parent).
  const eligibleParents = allCategories.filter((c) =>
    !c.parentId &&
    c.id !== category?.id &&
    !allCategories.some((child) => child.parentId === c.id && child.id !== category?.id)
  )

  async function handleSave() {
    if (!name.trim()) return
    const data = {
      name: name.trim(),
      icon,
      color,
      monthlyBudget: parseFloat(budget) || 0,
      sortOrder: category?.sortOrder ?? allCategories.length,
      parentId,
      isSavingsCategory: isSavings,
      goalTargetAmount: isSavings && isGoalToggle ? (parseFloat(goalAmount) || 0) : 0,
      goalTargetDate: isSavings && isGoalToggle && hasGoalDate && goalDate ? new Date(goalDate).toISOString() : null,
      // Only stamp a start date the first time this becomes a goal — re-editing
      // shouldn't reset progress by moving the counting-from date forward.
      goalStartDate: isSavings && isGoalToggle ? (category?.goalStartDate ?? new Date().toISOString()) : null
    }
    if (category) {
      await saveCategory({ ...category, ...data })
    } else {
      await createCategory(data)
    }
    onChanged()
    onClose()
  }

  async function handleDelete() {
    if (!category) return
    await deleteCategory(category.id)
    onChanged()
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={onClose} className="text-button">Cancel</button>
          <span className="modal-title">{category ? 'Edit Category' : 'New Category'}</span>
          <button onClick={handleSave} className="text-button text-button-primary">Save</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />

          <label className="field-label">Icon (emoji)</label>
          <input type="text" value={icon} onChange={(e) => setIcon(e.target.value)} style={{ width: 60 }} />

          <label className="field-label">Color</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 60, padding: 2 }} />

          {eligibleParents.length > 0 && (
            <>
              <label className="field-label">Parent Category (optional)</label>
              <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
                <option value="">None — top-level category</option>
                {eligibleParents.map((p) => (
                  <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
                ))}
              </select>
            </>
          )}

          {!parentId && (
            <>
              <label className="field-label">Monthly Budget</label>
              <input type="number" inputMode="decimal" placeholder="0.00" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </>
          )}
          {parentId && (
            <>
              <label className="field-label">Monthly Budget (rolls up into parent's total)</label>
              <input type="number" inputMode="decimal" placeholder="0.00" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
            <input type="checkbox" checked={isSavings} onChange={(e) => setIsSavings(e.target.checked)} style={{ width: 18, height: 18 }} />
            <span>Savings or investment category</span>
          </div>

          {isSavings && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <input type="checkbox" checked={isGoalToggle} onChange={(e) => setIsGoalToggle(e.target.checked)} style={{ width: 18, height: 18 }} />
                <span>This is a savings goal</span>
              </div>
              {isGoalToggle && (
                <>
                  <label className="field-label">Target Amount</label>
                  <input type="number" inputMode="decimal" placeholder="0.00" value={goalAmount} onChange={(e) => setGoalAmount(e.target.value)} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <input type="checkbox" checked={hasGoalDate} onChange={(e) => setHasGoalDate(e.target.checked)} style={{ width: 18, height: 18 }} />
                    <span>Target date</span>
                  </div>
                  {hasGoalDate && (
                    <input type="date" value={goalDate} onChange={(e) => setGoalDate(e.target.value)} style={{ marginTop: 8 }} />
                  )}
                  <p className="hint" style={{ marginTop: 8 }}>Tracked cumulatively toward the target, not a monthly amount that resets.</p>
                </>
              )}
            </>
          )}

          {category && (
            <button className="danger-button" onClick={handleDelete}>Delete Category</button>
          )}
        </div>
      </div>
    </div>
  )
}
