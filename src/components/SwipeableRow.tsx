import { useRef, useState } from 'react'

interface Props {
  onDelete: () => void
  children: React.ReactNode
  disabled?: boolean
  borderRadius?: number
}

const DELETE_WIDTH = 76
const TRIGGER_THRESHOLD = 40

export default function SwipeableRow({ onDelete, children, disabled, borderRadius = 0 }: Props) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startY = useRef(0)
  const directionLocked = useRef<'horizontal' | 'vertical' | null>(null)

  function handlePointerDown(e: React.PointerEvent) {
    if (disabled) return
    startX.current = e.clientX
    startY.current = e.clientY
    directionLocked.current = null
    setDragging(true)
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragging) return
    const dx = e.clientX - startX.current
    const dy = e.clientY - startY.current

    // Only commit to horizontal swipe handling once the gesture is
    // clearly more horizontal than vertical — otherwise let the page's
    // normal vertical scroll take over untouched.
    if (directionLocked.current === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      directionLocked.current = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical'
    }
    if (directionLocked.current !== 'horizontal') return

    e.preventDefault()
    const next = Math.min(0, Math.max(dx, -DELETE_WIDTH * 1.4))
    setOffset(next)
  }

  function handlePointerUp() {
    setDragging(false)
    if (directionLocked.current === 'horizontal' && offset < -TRIGGER_THRESHOLD) {
      setOffset(-DELETE_WIDTH)
    } else {
      setOffset(0)
    }
    directionLocked.current = null
  }

  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius }}>
      <div
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: DELETE_WIDTH,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--red)', opacity: offset < -4 ? 1 : 0, transition: dragging ? 'none' : 'opacity 0.15s ease',
          borderRadius: `0 ${borderRadius}px ${borderRadius}px 0`
        }}
      >
        <button onClick={() => { setOffset(0); onDelete() }} style={{ color: '#fff', fontWeight: 600, fontSize: 13, width: '100%', height: '100%' }}>
          Delete
        </button>
      </div>
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? 'none' : 'transform 0.2s ease',
          background: 'var(--surface)',
          touchAction: 'pan-y'
        }}
      >
        {children}
      </div>
    </div>
  )
}
