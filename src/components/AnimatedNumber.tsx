import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  format: (n: number) => string
  duration?: number
}

/** Animates a number counting up (or down) from its previous value to
 * the new one, rather than the figure just snapping to place — this is
 * the same "hero balance" treatment used by most modern finance apps
 * (Revolut, Monzo, Cash App). Uses requestAnimationFrame directly
 * rather than a CSS approach, since animating the actual displayed
 * digits isn't something CSS can do — only a numeric property like
 * width or opacity. */
export default function AnimatedNumber({ value, format, duration = 700 }: Props) {
  const [displayed, setDisplayed] = useState(0)
  const fromRef = useRef(0)
  const startRef = useRef<number | null>(null)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    const from = fromRef.current
    if (from === value) return
    startRef.current = null

    function tick(timestamp: number) {
      if (startRef.current === null) startRef.current = timestamp
      const elapsed = timestamp - startRef.current
      const progress = Math.min(1, elapsed / duration)
      // Ease-out cubic — fast start, gentle settle, matches how these
      // counters feel in the apps this pattern is borrowed from.
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplayed(from + (value - from) * eased)
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = value
      }
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return <>{format(displayed)}</>
}
