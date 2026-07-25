import { useEffect, useRef } from 'react'

const EDGE_ZONE_PX = 24
const TRIGGER_DISTANCE_PX = 80

/**
 * Attaches an iOS-style edge-swipe-back gesture to the whole screen: a
 * rightward drag that STARTS within a thin zone at the very left edge
 * triggers onBack, same as the native system gesture. Starting the
 * check at the edge specifically (not anywhere on screen) is
 * deliberate — it's what stops this from firing during an ordinary
 * horizontal interaction elsewhere on the page, like a chart or a
 * chip row.
 */
export function useSwipeBack(onBack: () => void, enabled = true) {
  const startX = useRef<number | null>(null)
  const startY = useRef<number | null>(null)
  const tracking = useRef(false)

  useEffect(() => {
    if (!enabled) return

    function handleStart(e: PointerEvent) {
      if (e.clientX > EDGE_ZONE_PX) { tracking.current = false; return }
      startX.current = e.clientX
      startY.current = e.clientY
      tracking.current = true
    }

    function handleMove(e: PointerEvent) {
      if (!tracking.current || startX.current === null || startY.current === null) return
      const dx = e.clientX - startX.current
      const dy = e.clientY - startY.current
      if (dx > TRIGGER_DISTANCE_PX && Math.abs(dy) < dx) {
        tracking.current = false
        onBack()
      }
    }

    function handleEnd() {
      tracking.current = false
    }

    window.addEventListener('pointerdown', handleStart)
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    return () => {
      window.removeEventListener('pointerdown', handleStart)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
    }
  }, [onBack, enabled])
}
