import type { PeriodForecast } from '../forecast'
import { formatCurrency } from '../calculations'

function dayMonth(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

function Row({ label, value, strong, tone }: { label: React.ReactNode; value: string; strong?: boolean; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '7px 0', fontSize: 14, fontWeight: strong ? 600 : 400, borderTop: strong ? '1px solid var(--border)' : undefined, marginTop: strong ? 4 : 0 }}>
      <span style={{ color: strong ? 'var(--text)' : 'var(--text-dim)', minWidth: 0 }}>{label}</span>
      <span className="amount" style={{ color: tone ?? 'var(--text)', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

const RATE_NOTE: Record<PeriodForecast['rateSource'], string> = {
  'this-period': 'The everyday pace comes from your spending so far this period.',
  blend: "The everyday pace blends last period's with the days so far, since it's still early.",
  'last-period': "The everyday pace comes from last period, as nothing is logged yet this period.",
  none: ''
}

/** Where Safe to Spend is heading by the last day: today's spending plus
 * bills with known dates plus everyday spending at the current pace. */
export default function ForecastCard({ forecast }: { forecast: PeriodForecast }) {
  const f = forecast
  const hasBudget = f.budget > 0
  const over = f.projectedLeftover < 0
  const shownBills = f.upcomingBills.slice(0, 4)

  return (
    <div className="card" style={{ marginTop: 16 }} data-testid="forecast-card">
      <span className="section-heading" style={{ margin: '0 0 8px' }}>End of Period Forecast</span>
      {hasBudget ? (
        <>
          <div style={{ textAlign: 'center', padding: '4px 0 10px' }}>
            <div className="hero-label">{f.daysLeft === 0 ? 'Final day —' : `By ${dayMonth(f.lastDay)} at this pace, Safe to Spend ends at`}</div>
            <div className="hero-amount amount" data-testid="forecast-leftover" style={{ fontSize: 30, color: over ? 'var(--red)' : 'var(--green)' }}>
              {over ? '−' : ''}{formatCurrency(Math.abs(f.projectedLeftover))}
            </div>
            <div style={{ fontSize: 13, color: over ? 'var(--red)' : 'var(--green)' }}>{over ? 'projected over budget' : 'projected to spare'}</div>
          </div>
          <Row label="Budget" value={formatCurrency(f.budget)} />
          <Row label="Spent so far" value={`−${formatCurrency(f.spentToDate)}`} />
          {f.upcomingBills.length > 0 && <Row label={`Bills still to come (${f.upcomingBills.length})`} value={`−${formatCurrency(f.upcomingTotal)}`} />}
          {f.daysLeft > 0 && <Row label={<>Everyday spending<br /><span style={{ fontSize: 12, color: 'var(--text-faint)' }}>~{formatCurrency(f.dailyRate)}/day × {f.daysLeft} days</span></>} value={`−${formatCurrency(f.projectedEverydayRemaining)}`} />}
          {f.saved !== 0 && <Row label={f.saved > 0 ? 'Set aside for savings' : 'Drawn from savings'} value={`${f.saved > 0 ? '−' : '+'}${formatCurrency(Math.abs(f.saved))}`} />}
          {f.reserveHeld > 0 && <Row label="Held for yearly bills" value={`−${formatCurrency(f.reserveHeld)}`} />}
          <Row strong label={`Projected Safe to Spend`} value={`${over ? '−' : ''}${formatCurrency(Math.abs(f.projectedLeftover))}`} tone={over ? 'var(--red)' : 'var(--green)'} />
        </>
      ) : (
        <>
          <div style={{ textAlign: 'center', padding: '4px 0 10px' }}>
            <div className="hero-label">Projected spending by {dayMonth(f.lastDay)}</div>
            <div className="hero-amount amount" data-testid="forecast-spend" style={{ fontSize: 30 }}>{formatCurrency(f.projectedSpend)}</div>
          </div>
          <Row label="Spent so far" value={formatCurrency(f.spentToDate)} />
          {f.upcomingBills.length > 0 && <Row label={`Bills still to come (${f.upcomingBills.length})`} value={formatCurrency(f.upcomingTotal)} />}
          {f.daysLeft > 0 && <Row label={`Everyday spending (~${formatCurrency(f.dailyRate)}/day × ${f.daysLeft})`} value={formatCurrency(f.projectedEverydayRemaining)} />}
          <p className="hint" style={{ marginTop: 6 }}>Set category budgets to see how this compares with what you plan to spend.</p>
        </>
      )}
      {shownBills.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {shownBills.map((b, i) => (
            <div key={`${b.id}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)', padding: '2px 0' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 8 }}>{dayMonth(b.date)} · {b.note}</span>
              <span className="amount">{formatCurrency(b.amount)}</span>
            </div>
          ))}
          {f.upcomingBills.length > shownBills.length && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>+ {f.upcomingBills.length - shownBills.length} more</div>}
        </div>
      )}
      <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
        {f.daysLeft > 0 && RATE_NOTE[f.rateSource] ? `${RATE_NOTE[f.rateSource]} ` : ''}
        Bills already paid aren't counted twice, and one-off big purchases can skew the pace — it's an estimate, not a promise.
      </p>
    </div>
  )
}
