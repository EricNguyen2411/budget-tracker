import { useState } from 'react'
import type { Category, RecurringTransaction, Transaction } from '../types'
import { runHealthCheck, type HealthFinding } from '../healthCheck'
import { formatCurrency, netAmount } from '../calculations'
import { renewRecurringGoal } from '../db'
import TransactionEditor from '../components/TransactionEditor'
import { useModalClose } from '../useModalClose'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  categories: Category[]
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onOpenDuplicateCheck: () => void
  onCategoriesChanged: () => void
  onBack: () => void
}

export default function HealthCheck({ transactions, recurring, categories, onSave, onDelete, onOpenDuplicateCheck, onCategoriesChanged, onBack }: Props) {
  useSwipeBack(onBack)
  const [findings, setFindings] = useState<HealthFinding[] | null>(null)
  const [drillDown, setDrillDown] = useState<HealthFinding | null>(null)
  const drillDownClose = useModalClose(() => setDrillDown(null))
  const [editing, setEditing] = useState<Transaction | null>(null)
  const catById = new Map(categories.map((c) => [c.id, c]))

  function run() {
    setFindings(runHealthCheck(transactions, recurring, categories))
  }

  async function handleFindingTap(f: HealthFinding) {
    // Duplicates has its own dedicated tool with real resolve actions
    // (dismiss a group as not-a-duplicate, delete inline, grouped by
    // confidence) that this drill-down doesn't have and isn't trying to
    // rebuild — go straight there instead of a lighter-weight list.
    if (f.icon === '📑') { onOpenDuplicateCheck(); return }

    // Recurring annual goals ready to renew — a direct action, not a
    // list to drill into, since there's nothing to review per-item.
    if (f.renewableCategoryIds && f.renewableCategoryIds.length > 0) {
      const names = f.renewableCategoryIds.map((id) => catById.get(id)?.name).filter(Boolean).join(', ')
      if (!confirm(`Renew ${names} for next year? Each target date moves forward a year and progress tracking restarts fresh.`)) return
      for (const id of f.renewableCategoryIds) {
        const cat = catById.get(id)
        if (cat) await renewRecurringGoal(cat)
      }
      onCategoriesChanged()
      setFindings(runHealthCheck(transactions, recurring, categories))
      return
    }

    if (f.transactions.length > 0) setDrillDown(f)
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Health Check</h1>
        <span style={{ width: 40 }} />
      </div>

      {findings === null && (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
            Checks your data for things worth a second look — possible duplicates, uncategorized transactions, unusually large amounts, stale pending fares, overdue recurring items, savings goals behind pace, unbudgeted categories, and undetected recurring patterns. Nothing changes automatically.
          </p>
          <button className="list-button" style={{ color: 'var(--blue)', fontWeight: 600 }} onClick={run}>Run Health Check</button>
        </div>
      )}

      {findings !== null && findings.length === 0 && (
        <p style={{ textAlign: 'center', color: 'var(--green)', marginTop: 40 }}>✅ Looking good — no issues found across {transactions.length} transactions.</p>
      )}

      {findings?.map((f, i) => (
        <button key={i} className="card" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 10 }}
          onClick={() => handleFindingTap(f)}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span>{f.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: f.severity === 'warning' ? 'var(--amber)' : 'var(--blue)' }}>{f.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{f.detail}</div>
            </div>
            {(f.transactions.length > 0 || f.icon === '📑' || (f.renewableCategoryIds && f.renewableCategoryIds.length > 0)) && <span style={{ color: 'var(--text-faint)' }}>›</span>}
          </div>
        </button>
      ))}

      {findings !== null && (
        <button className="list-button" style={{ color: 'var(--text-dim)', fontSize: 13 }} onClick={run}>Re-run</button>
      )}

      {drillDown && (
        <div className={`modal-backdrop${drillDownClose.closing ? ' modal-closing' : ''}`} onClick={() => drillDownClose.requestClose()}>
          <div className={`modal-sheet${drillDownClose.closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{drillDown.title}</span>
              <button className="text-button text-button-primary" onClick={() => drillDownClose.requestClose()}>Done</button>
            </div>
            <div className="modal-body">
              <p className="hint" style={{ marginBottom: 12 }}>Tap any transaction to fix it directly.</p>
              {drillDown.transactions.map((t) => {
                const cat = t.categoryId ? catById.get(t.categoryId) : undefined
                return (
                  <button key={t.id} className="transaction-row" style={{ borderBottom: '1px solid var(--border)' }} onClick={() => setEditing(t)}>
                    <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
                    <div className="tx-info">
                      <span className="tx-note">{t.note || 'Uncategorized'}</span>
                      <span className="tx-category">{cat?.name ?? 'Uncategorized'} · {new Date(t.date).toLocaleDateString('en-AU')}</span>
                    </div>
                    <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
                      {t.isExpense ? '-' : '+'}{formatCurrency(netAmount(t, transactions))}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {editing && (
        <TransactionEditor
          transaction={editing}
          categories={categories}
          allTransactions={transactions}
          onSave={(data) => {
            onSave(data, editing.id)
            setEditing(null)
            // Re-run automatically so the fixed transaction drops off
            // the list immediately, rather than looking unfixed until
            // a manual re-run — and keep the open drill-down modal (if
            // any) in sync too, since it otherwise holds a stale
            // snapshot from before the fix.
            const refreshed = runHealthCheck(transactions.map((t) => t.id === editing.id ? { ...t, ...data } : t), recurring, categories)
            setFindings(refreshed)
            if (drillDown) setDrillDown(refreshed.find((f) => f.icon === drillDown.icon) ?? null)
          }}
          onDelete={() => {
            onDelete(editing.id)
            setEditing(null)
            const refreshed = runHealthCheck(transactions.filter((t) => t.id !== editing.id), recurring, categories)
            setFindings(refreshed)
            if (drillDown) setDrillDown(refreshed.find((f) => f.icon === drillDown.icon) ?? null)
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
