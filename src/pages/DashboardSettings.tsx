import { useState } from 'react'
import { WIDGET_LABELS, hideableWidgets, getHiddenWidgets, setWidgetHidden, getWidgetOrder, moveWidget } from '../dashboardWidgets'
import { useSwipeBack } from '../useSwipeBack'

export default function DashboardSettings({ onBack }: { onBack: () => void }) {
  useSwipeBack(onBack)
  const [hidden, setHidden] = useState(getHiddenWidgets())
  const [order, setOrder] = useState(getWidgetOrder())

  const hideableSet = new Set(hideableWidgets())
  const orderedHideable = order.filter((id) => hideableSet.has(id))

  function toggle(id: ReturnType<typeof hideableWidgets>[number]) {
    const isHidden = hidden.has(id)
    setWidgetHidden(id, !isHidden)
    setHidden(getHiddenWidgets())
  }

  function move(id: ReturnType<typeof hideableWidgets>[number], direction: 'up' | 'down') {
    moveWidget(id, direction)
    setOrder(getWidgetOrder())
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Customize Dashboard</h1>
        <span style={{ width: 40 }} />
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
        Turn widgets on or off and reorder them — Safe to Spend and the four summary cards always show first, in that order.
      </p>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {orderedHideable.map((id, i, arr) => (
          <div key={id} className="transaction-row" style={{ borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button onClick={() => move(id, 'up')} disabled={i === 0} style={{ color: i === 0 ? 'var(--text-faint)' : 'var(--blue)', fontSize: 14, lineHeight: 1 }}>▲</button>
              <button onClick={() => move(id, 'down')} disabled={i === arr.length - 1} style={{ color: i === arr.length - 1 ? 'var(--text-faint)' : 'var(--blue)', fontSize: 14, lineHeight: 1 }}>▼</button>
            </div>
            <div className="tx-info"><span className="tx-note">{WIDGET_LABELS[id]}</span></div>
            <input type="checkbox" switch checked={!hidden.has(id)} onChange={() => toggle(id)} />
          </div>
        ))}
      </div>
    </div>
  )
}
