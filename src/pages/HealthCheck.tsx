import { useState } from 'react'
import type { Category, RecurringTransaction, Transaction } from '../types'
import { runHealthCheck, type HealthFinding } from '../healthCheck'
import { formatCurrency } from '../calculations'

interface Props {
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  categories: Category[]
}

export default function HealthCheck({ transactions, recurring, categories }: Props) {
  const [findings, setFindings] = useState<HealthFinding[] | null>(null)
  const [drillDown, setDrillDown] = useState<HealthFinding | null>(null)

  function run() {
    setFindings(runHealthCheck(transactions, recurring, categories))
  }

  return (
    <div className="screen">
      <h1 className="screen-title">Health Check</h1>

      {findings === null && (
        <div className="card">
          <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 12 }}>
            Checks your data for things worth a second look — possible duplicates, uncategorized transactions, unusually large amounts, stale pending fares, overdue recurring items. Nothing changes automatically.
          </p>
          <button className="list-button" style={{ color: 'var(--green)', fontWeight: 600 }} onClick={run}>Run Health Check</button>
        </div>
      )}

      {findings !== null && findings.length === 0 && (
        <p style={{ textAlign: 'center', color: 'var(--green)', marginTop: 40 }}>✅ Looking good — no issues found across {transactions.length} transactions.</p>
      )}

      {findings?.map((f, i) => (
        <button key={i} className="card" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 10 }}
          onClick={() => f.transactions.length > 0 && setDrillDown(f)}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span>{f.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, color: f.severity === 'warning' ? 'var(--amber)' : 'var(--blue)' }}>{f.title}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{f.detail}</div>
            </div>
            {f.transactions.length > 0 && <span style={{ color: 'var(--text-faint)' }}>›</span>}
          </div>
        </button>
      ))}

      {findings !== null && (
        <button className="list-button" style={{ color: 'var(--text-dim)', fontSize: 13 }} onClick={run}>Re-run</button>
      )}

      {drillDown && (
        <div className="modal-backdrop" onClick={() => setDrillDown(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">{drillDown.title}</span>
              <button className="text-button text-button-primary" onClick={() => setDrillDown(null)}>Done</button>
            </div>
            <div className="modal-body">
              {drillDown.transactions.map((t) => (
                <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <span style={{ fontSize: 14 }}>{t.note || 'Uncategorized'}</span>
                  <span className="amount">{formatCurrency(t.amount)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
