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

interface BarDatum {
  label: string
  value: number
  color?: string
}

export function BarChart({ data, height = 140, positiveColor = 'var(--green)', negativeColor = 'var(--red)' }: {
  data: BarDatum[]
  height?: number
  positiveColor?: string
  negativeColor?: string
}) {
  if (data.length === 0) return null
  const maxAbs = Math.max(1, ...data.map((d) => Math.abs(d.value)))
  const hasNegative = data.some((d) => d.value < 0)
  const zeroLine = hasNegative ? height / 2 : height

  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height, gap: Math.max(2, 6 - data.length / 5) }}>
      {data.map((d, i) => {
        const barHeight = (Math.abs(d.value) / maxAbs) * (hasNegative ? height / 2 : height)
        const color = d.color ?? (d.value >= 0 ? positiveColor : negativeColor)
        return (
          <div key={i} title={d.label} style={{ flex: 1, height: '100%', position: 'relative', display: 'flex', alignItems: hasNegative ? 'flex-start' : 'flex-end' }}>
            <div
              style={{
                width: '100%',
                height: Math.max(2, barHeight),
                background: color,
                borderRadius: 3,
                position: 'absolute',
                top: hasNegative ? (d.value >= 0 ? zeroLine - barHeight : zeroLine) : undefined,
                bottom: !hasNegative ? 0 : undefined
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
