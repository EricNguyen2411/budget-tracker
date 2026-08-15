import { useEffect, useRef } from 'react'

const EDGE_ZONE_PX = 24
const TRIGGER_DISTANCE_PX = 80
const TRIGGER_VELOCITY_PX_MS = 0.5 // a fast short flick should also complete, not just a long drag

/**
 * Attaches an iOS-style edge-swipe-back gesture to the whole screen: a
 * rightward drag that STARTS within a thin zone at the very left edge
 * follows the finger in real time, then either completes the
 * transition (sliding fully off-screen before calling onBack) or snaps
 * back to place — matching how the native system gesture actually
 * feels, not just firing onBack the instant a distance threshold is
 * crossed with no visual feedback during the drag itself.
 *
 * Finds the current screen element via a DOM query rather than a ref,
 * since this hook is called generically from many different page
 * components — requiring every one of them to thread a ref onto their
 * root div would mean touching every file again for what's otherwise a
 * self-contained gesture concern.
 */
export function useSwipeBack(onBack: () => void, enabled = true) {
  const startX = useRef<number | null>(null)
  const startY = useRef<number | null>(null)
  const startTime = useRef(0)
  const tracking = useRef(false)
  const dragging = useRef(false)
  const el = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!enabled) return

    function reset() {
      if (el.current) {
        el.current.style.transition = ''
        el.current.style.transform = ''
        el.current.style.filter = ''
      }
      tracking.current = false
      dragging.current = false
      el.current = null
    }

    function handleStart(e: PointerEvent) {
      if (e.clientX > EDGE_ZONE_PX) { tracking.current = false; return }
      startX.current = e.clientX
      startY.current = e.clientY
      startTime.current = performance.now()
      tracking.current = true
      dragging.current = false
    }

    function handleMove(e: PointerEvent) {
      if (!tracking.current || startX.current === null || startY.current === null) return
      const dx = e.clientX - startX.current
      const dy = e.clientY - startY.current

      // Only commit to the gesture (and start moving the screen) once
      // the drag is clearly horizontal — otherwise an ordinary vertical
      // scroll that happens to start near the edge would visually hitch.
      if (!dragging.current) {
        if (dx < 8 || Math.abs(dy) > dx) return
        dragging.current = true
        el.current = document.querySelector('.screen')
        if (el.current) el.current.style.transition = 'none'
      }

      if (!el.current) return
      const clamped = Math.max(0, dx)
      el.current.style.transform = `translateX(${clamped}px)`
      el.current.style.filter = `brightness(${Math.max(0.7, 1 - clamped / 800)})`
      e.preventDefault()
    }

    function handleEnd(e: PointerEvent) {
      if (!dragging.current || !el.current || startX.current === null) { reset(); return }
      const dx = Math.max(0, e.clientX - startX.current)
      const elapsed = Math.max(1, performance.now() - startTime.current)
      const velocity = dx / elapsed
      const shouldComplete = dx > TRIGGER_DISTANCE_PX || velocity > TRIGGER_VELOCITY_PX_MS

      const target = el.current
      target.style.transition = 'transform 0.25s cubic-bezier(0.32, 0.72, 0, 1), filter 0.25s ease'

      if (shouldComplete) {
        target.style.transform = 'translateX(100%)'
        target.style.filter = 'brightness(0.7)'
        setTimeout(() => { reset(); onBack() }, 250)
      } else {
        target.style.transform = 'translateX(0)'
        target.style.filter = 'brightness(1)'
        setTimeout(reset, 250)
      }
    }

    window.addEventListener('pointerdown', handleStart)
    window.addEventListener('pointermove', handleMove, { passive: false })
    window.addEventListener('pointerup', handleEnd)
    window.addEventListener('pointercancel', handleEnd)
    return () => {
      window.removeEventListener('pointerdown', handleStart)
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleEnd)
      window.removeEventListener('pointercancel', handleEnd)
      reset()
    }
  }, [onBack, enabled])
}
