import { useState } from 'react'
import { WIDGET_LABELS, hideableWidgets, getHiddenWidgets, setWidgetHidden } from '../dashboardWidgets'

export default function DashboardSettings({ onBack }: { onBack: () => void }) {
  const [hidden, setHidden] = useState(getHiddenWidgets())

  function toggle(id: ReturnType<typeof hideableWidgets>[number]) {
    const isHidden = hidden.has(id)
    setWidgetHidden(id, !isHidden)
    setHidden(getHiddenWidgets())
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Customize Dashboard</h1>
        <span style={{ width: 40 }} />
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
        Turn widgets on or off — Safe to Spend and the four summary cards always show, everything else is optional.
      </p>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {hideableWidgets().map((id, i, arr) => (
          <div key={id} className="transaction-row" style={{ borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <div className="tx-info"><span className="tx-note">{WIDGET_LABELS[id]}</span></div>
            <input type="checkbox" switch checked={!hidden.has(id)} onChange={() => toggle(id)} />
          </div>
        ))}
      </div>
    </div>
  )
}
