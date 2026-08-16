import { useEffect, useState } from 'react'
import { formatCurrency } from '../calculations'

interface DonutSlice {
  label: string
  value: number
  color: string
}

export function DonutChart({ slices, size = 160 }: { slices: DonutSlice[]; size?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (total <= 0) return null

  const radius = size / 2
  const innerRadius = radius * 0.62
  const center = radius

  let cumulativeAngle = -90 // start at 12 o'clock

  function arcPath(startAngle: number, endAngle: number): string {
    const toXY = (angle: number, r: number) => {
      const rad = (angle * Math.PI) / 180
      return [center + r * Math.cos(rad), center + r * Math.sin(rad)]
    }
    const [x1, y1] = toXY(startAngle, radius)
    const [x2, y2] = toXY(endAngle, radius)
    const [x3, y3] = toXY(endAngle, innerRadius)
    const [x4, y4] = toXY(startAngle, innerRadius)
    const largeArc = endAngle - startAngle > 180 ? 1 : 0
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${x4} ${y4} Z`
  }

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices.map((slice, i) => {
        const sweep = (slice.value / total) * 360
        const start = cumulativeAngle
        const end = cumulativeAngle + sweep
        cumulativeAngle = end
        return <path key={i} d={arcPath(start, end)} fill={slice.color} />
      })}
    </svg>
  )
}

export interface BarDatum {
  label: string
  axisLabel: string
  value: number
  color?: string
  onSelect?: () => void
}

/**
 * Tappable bar chart with Y-axis gridlines/labels and a value readout
 * for whichever bar is selected — matching the native app's charts,
 * which show gridline numbers and let you tap a bar to see that
 * specific day/month's figure rather than just an unlabeled shape.
 */
export function BarChart({ data, height = 140, positiveColor = 'var(--blue)', negativeColor = 'var(--red)', preferredStep, defaultSummary }: {
  data: BarDatum[]
  height?: number
  positiveColor?: string
  negativeColor?: string
  preferredStep?: number
  defaultSummary?: React.ReactNode
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => setMounted(true))
    return () => cancelAnimationFrame(t)
  }, [])
  if (data.length === 0) return null

  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.value)))
  const hasNegative = data.some((d) => d.value < 0)
  const zeroLine = hasNegative ? height / 2 : height

  // With a preferred step (e.g. 200 for a daily chart, 2000 for a
  // monthly one), the axis extends in round multiples of it — matching
  // the native app's gridlines (0/200/400/600) instead of scaling to
  // whatever the data happens to be. Falls back to automatic "nice"
  // rounding if no step is given.
  function niceMax(n: number): number {
    if (preferredStep) return Math.ceil(n / preferredStep) * preferredStep
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, n))))
    const step = magnitude / 2
    return Math.ceil(n / step) * step
  }
  const axisMax = niceMax(maxAbs)
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(axisMax * f))

  const selected = selectedIndex !== null ? data[selectedIndex] : null
  const axisColumnWidth = 36
  const showBarLabels = data.length <= 14
  // 14 daily bars have much less room per bar than 6 monthly ones —
  // smaller text and whole-dollar rounding (no cents) keeps each label
  // narrow enough to avoid colliding with its neighbors.
  const dense = data.length > 8
  const labelFontSize = dense ? 8.5 : 10
  function compactValue(n: number): string {
    const abs = Math.abs(n)
    if (abs >= 1000) return `${n < 0 ? '-' : ''}$${(abs / 1000).toFixed(1)}k`
    if (dense) return `${n < 0 ? '-' : ''}$${Math.round(abs)}`
    return formatCurrency(n)
  }
  // A little more breathing room between bars than the old formula gave
  // at higher bar counts (it went almost to zero gap at 14 bars, which
  // read as cramped) — clamped to a comfortable range instead.
  const barGap = Math.min(8, Math.max(3, 10 - data.length / 3))

  return (
    <div>
      {selected ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
          <span style={{ color: 'var(--text-dim)' }}>{selected.label}</span>
          <span className="amount" style={{ fontWeight: 600 }}>{formatCurrency(selected.value)}</span>
        </div>
      ) : defaultSummary ? (
        <div style={{ marginBottom: 8, fontSize: 13, color: 'var(--text-dim)' }}>{defaultSummary}</div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, marginTop: showBarLabels ? 16 : 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', alignItems: 'flex-end', height, gap: barGap }}>
          {gridLines.map((_, i) => (
            <div key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: `${(i / (gridLines.length - 1)) * 100}%`, borderTop: '1px solid rgba(255,255,255,0.06)' }} />
          ))}
          {data.map((d, i) => {
            const barHeight = mounted ? (Math.abs(d.value) / axisMax) * (hasNegative ? height / 2 : height) : 0
            const color = d.color ?? (d.value >= 0 ? positiveColor : negativeColor)
            const isSelected = selectedIndex === i
            const isPositive = d.value >= 0
            return (
              <button
                key={i}
                onClick={() => { setSelectedIndex(isSelected ? null : i); d.onSelect?.() }}
                style={{ flex: 1, height: '100%', position: 'relative', display: 'flex', alignItems: hasNegative ? 'flex-start' : 'flex-end' }}
              >
                {showBarLabels && d.value !== 0 && (
                  <span
                    className="amount"
                    style={{
                      position: 'absolute',
                      fontSize: labelFontSize,
                      fontWeight: isSelected ? 700 : 500,
                      color: 'var(--text-dim)',
                      opacity: selectedIndex !== null && !isSelected ? 0.35 : 1,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      ...(hasNegative
                        ? isPositive
                          ? { bottom: `calc(50% + ${barHeight}px + 4px)` }
                          : { top: `calc(50% + ${barHeight}px + 4px)` }
                        : { bottom: `${barHeight + 4}px` })
                    }}
                  >
                    {compactValue(d.value)}
                  </span>
                )}
                <div
                  style={{
                    width: '100%',
                    height: Math.max(3, barHeight),
                    background: `linear-gradient(${isPositive ? '180deg' : '0deg'}, ${color} 0%, color-mix(in srgb, ${color} 65%, transparent) 100%)`,
                    opacity: selectedIndex !== null && !isSelected ? 0.35 : 1,
                    borderRadius: isPositive ? '6px 6px 2px 2px' : '2px 2px 6px 6px',
                    position: 'absolute',
                    top: hasNegative ? (isPositive ? zeroLine - barHeight : zeroLine) : undefined,
                    bottom: !hasNegative ? 0 : undefined,
                    transition: 'height 0.5s cubic-bezier(0.22, 1, 0.36, 1), top 0.5s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.15s ease'
                  }}
                />
              </button>
            )
          })}
        </div>
        {!showBarLabels && (
          <div style={{ width: axisColumnWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height, fontSize: 10, color: 'var(--text-faint)', textAlign: 'left' }}>
            {[...gridLines].reverse().map((v, i) => <span key={i}>{v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}</span>)}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)', marginTop: 6, paddingRight: showBarLabels ? 0 : axisColumnWidth + 8 }}>
        {data.map((d, i) => <span key={i} style={{ opacity: selectedIndex === i ? 1 : 0.7, fontWeight: selectedIndex === i ? 600 : 400 }}>{d.axisLabel}</span>)}
      </div>
    </div>
  )
}
