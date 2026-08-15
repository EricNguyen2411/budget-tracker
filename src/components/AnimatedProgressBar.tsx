import { useEffect, useState } from 'react'

interface Props {
  fraction: number // 0 to 1
  color: string
  trackStyle?: React.CSSProperties
}

/** Starts at 0 width and animates to the real value shortly after
 * mount. A plain CSS transition on width only fires when the value
 * changes on an element that's already on screen — it does nothing on
 * first appearance, since React sets the final width directly on the
 * very first render. Rendering at 0 first, then flipping to the real
 * value one frame later, gives the transition something to actually
 * animate. */
export default function AnimatedProgressBar({ fraction, color, trackStyle }: Props) {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setWidth(Math.min(1, Math.max(0, fraction)) * 100))
    return () => cancelAnimationFrame(frame)
  }, [fraction])

  return (
    <div className="progress-track" style={trackStyle}>
      <div className="progress-fill" style={{ width: `${width}%`, background: color }} />
    </div>
  )
}
