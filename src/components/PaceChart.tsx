import type { SpendingPace } from '../forecast'
import { formatCurrency } from '../calculations'

const W = 320
const H = 150
const PAD = { left: 38, right: 8, top: 10, bottom: 20 }

function niceAxisMax(n: number): number {
  const steps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000]
  const step = steps.find((s) => n / s <= 4) ?? 20000
  return Math.max(step, Math.ceil(n / step) * step)
}

function axisLabel(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `${v}`
}

function dayLabel(start: Date, offsetDays: number): string {
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + offsetDays).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

/** Cumulative spend through the period against an even drip of the
 * budget and against last period — "am I ahead or behind?" at a glance. */
export default function PaceChart({ pace }: { pace: SpendingPace }) {
  const { totalDays, elapsedDays, current, previous, previousDays, budget } = pace
  const showPrevious = previous.length > 0 && previous[previous.length - 1] > 0
  const maxY = niceAxisMax(Math.max(budget, showPrevious ? Math.max(...previous) : 0, ...current, 1) * 1.04)
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const x = (fraction: number) => PAD.left + fraction * innerW
  const y = (value: number) => PAD.top + innerH - (Math.max(0, value) / maxY) * innerH

  const line = (values: number[], length: number) =>
    ['M ' + x(0) + ' ' + y(0), ...values.map((v, i) => `L ${x((i + 1) / length).toFixed(1)} ${y(v).toFixed(1)}`)].join(' ')

  const ticks = [0, 0.5, 1].map((f) => Math.round(maxY * f))
  const endX = x(elapsedDays / totalDays)
  const endY = y(current[current.length - 1] ?? 0)
  const status = pace.deltaVsPace === null ? 'var(--blue)' : pace.deltaVsPace <= 0 ? 'var(--green)' : 'var(--red)'

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Cumulative spending this period compared with an even pace and last period" style={{ display: 'block', color: 'var(--text-faint)' }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.07)" />
            <text x={PAD.left - 6} y={y(t) + 3} fontSize="9" textAnchor="end" fill="currentColor">{axisLabel(t)}</text>
          </g>
        ))}
        {budget > 0 && (
          <line data-testid="pace-even-line" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(budget)} stroke="var(--text-dim)" strokeWidth="1.25" strokeDasharray="4 4" />
        )}
        {showPrevious && (
          <path data-testid="pace-previous-line" d={line(previous, previousDays)} fill="none" stroke="var(--indigo)" strokeWidth="1.5" opacity="0.65" strokeLinejoin="round" />
        )}
        <path data-testid="pace-current-line" className="pace-line" pathLength={1} d={line(current, totalDays)} fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={endX} cy={endY} r="4" fill={status} stroke="var(--surface)" strokeWidth="1.5" />
        <text x={PAD.left} y={H - 5} fontSize="9" fill="currentColor">{dayLabel(pace.periodStart, 0)}</text>
        <text x={x(0.5)} y={H - 5} fontSize="9" textAnchor="middle" fill="currentColor">{dayLabel(pace.periodStart, Math.floor((totalDays - 1) / 2))}</text>
        <text x={W - PAD.right} y={H - 5} fontSize="9" textAnchor="end" fill="currentColor">{dayLabel(pace.periodStart, totalDays - 1)}</text>
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 8, fontSize: 11, color: 'var(--text-dim)' }}>
        <span><span style={{ display: 'inline-block', width: 14, height: 3, background: 'var(--blue)', borderRadius: 2, verticalAlign: 'middle', marginRight: 5 }} />This period</span>
        {showPrevious && <span><span style={{ display: 'inline-block', width: 14, height: 3, background: 'var(--indigo)', opacity: 0.65, borderRadius: 2, verticalAlign: 'middle', marginRight: 5 }} />Last period</span>}
        {budget > 0 && <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed var(--text-dim)', verticalAlign: 'middle', marginRight: 5 }} />Even pace ({formatCurrency(budget)} budget)</span>}
      </div>
    </div>
  )
}
