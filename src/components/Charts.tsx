import { useState } from 'react'
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
export function BarChart({ data, height = 140, positiveColor = 'var(--blue)', negativeColor = 'var(--red)' }: {
  data: BarDatum[]
  height?: number
  positiveColor?: string
  negativeColor?: string
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  if (data.length === 0) return null

  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.value)))
  const hasNegative = data.some((d) => d.value < 0)
  const zeroLine = hasNegative ? height / 2 : height

  // Round the axis max up to a "nice" number (nearest 10/50/100/500/1000
  // depending on scale) so gridline labels read like "600" not "583.20".
  function niceMax(n: number): number {
    const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(1, n))))
    const step = magnitude / 2
    return Math.ceil(n / step) * step
  }
  const axisMax = niceMax(maxAbs)
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(axisMax * f))

  const selected = selectedIndex !== null ? data[selectedIndex] : null

  return (
    <div>
      {selected && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 13 }}>
          <span style={{ color: 'var(--text-dim)' }}>{selected.label}</span>
          <span className="amount" style={{ fontWeight: 600 }}>{formatCurrency(selected.value)}</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', height, fontSize: 10, color: 'var(--text-faint)', textAlign: 'right' }}>
          {[...gridLines].reverse().map((v, i) => <span key={i}>{v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}</span>)}
        </div>
        <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'flex-end', height, gap: Math.max(2, 6 - data.length / 5), borderLeft: '1px solid var(--border)' }}>
          {gridLines.map((_, i) => (
            <div key={i} style={{ position: 'absolute', left: 0, right: 0, bottom: `${(i / (gridLines.length - 1)) * 100}%`, borderTop: '1px dashed var(--border)' }} />
          ))}
          {data.map((d, i) => {
            const barHeight = (Math.abs(d.value) / axisMax) * (hasNegative ? height / 2 : height)
            const color = d.color ?? (d.value >= 0 ? positiveColor : negativeColor)
            const isSelected = selectedIndex === i
            return (
              <button
                key={i}
                onClick={() => { setSelectedIndex(isSelected ? null : i); d.onSelect?.() }}
                style={{ flex: 1, height: '100%', position: 'relative', display: 'flex', alignItems: hasNegative ? 'flex-start' : 'flex-end' }}
              >
                <div
                  style={{
                    width: '100%',
                    height: Math.max(2, barHeight),
                    background: color,
                    opacity: selectedIndex !== null && !isSelected ? 0.4 : 1,
                    borderRadius: 3,
                    position: 'absolute',
                    top: hasNegative ? (d.value >= 0 ? zeroLine - barHeight : zeroLine) : undefined,
                    bottom: !hasNegative ? 0 : undefined,
                    transition: 'opacity 0.15s ease'
                  }}
                />
              </button>
            )
          })}
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)', marginTop: 6, paddingLeft: 26 }}>
        {data.map((d, i) => <span key={i} style={{ opacity: selectedIndex === i ? 1 : 0.7, fontWeight: selectedIndex === i ? 600 : 400 }}>{d.axisLabel}</span>)}
      </div>
    </div>
  )
}
