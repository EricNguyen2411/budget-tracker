import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { yearReview, yearsWithData } from '../yearReview'
import { formatCurrency } from '../calculations'
import { isCustomCycle } from '../budgetPeriod'
import { useSwipeBack } from '../useSwipeBack'
import { BarChart } from '../components/Charts'
import AnimatedProgressBar from '../components/AnimatedProgressBar'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
}

function dayMonth(d: Date): string {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
}

function Highlight({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '0.5px solid var(--border)' }}>
      <span style={{ color: 'var(--text-dim)', fontSize: 14, whiteSpace: 'nowrap', flexShrink: 0 }}>{label}</span>
      <span style={{ textAlign: 'right', fontSize: 14, minWidth: 0 }}>
        <span className="amount">{value}</span>
        {sub && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</span>}
      </span>
    </div>
  )
}

export default function YearInReview({ categories, transactions, onBack }: Props) {
  useSwipeBack(onBack)
  const now = new Date()
  const years = useMemo(() => yearsWithData(transactions, now), [transactions, now.toDateString()])
  const [year, setYear] = useState(years[0])
  const review = useMemo(() => yearReview(categories, transactions, year, now), [categories, transactions, year, now.toDateString()])
  const hasData = review.monthsCounted > 0
  const yearIndex = years.indexOf(year)

  const firstCounted = review.months.find((m) => m.started && m.hasData && (m.spent > 0 || m.income > 0 || m.saved !== 0))
  const lastCounted = [...review.months].reverse().find((m) => m.started && m.hasData && (m.spent > 0 || m.income > 0 || m.saved !== 0))
  const spanLabel = firstCounted && lastCounted ? `${firstCounted.label}${firstCounted === lastCounted ? '' : `–${lastCounted.label}`}` : ''

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Year in Review</h1>
        <span style={{ width: 40 }} />
      </div>

      {years.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, marginBottom: 14 }}>
          <button className="text-button-primary" aria-label="Earlier year" disabled={yearIndex >= years.length - 1} style={{ opacity: yearIndex >= years.length - 1 ? 0.3 : 1, fontSize: 22, padding: '0 8px' }} onClick={() => setYear(years[yearIndex + 1])}>‹</button>
          <span data-testid="yir-year" style={{ fontSize: 17, fontWeight: 600, minWidth: 56, textAlign: 'center' }}>{year}</span>
          <button className="text-button-primary" aria-label="Later year" disabled={yearIndex <= 0} style={{ opacity: yearIndex <= 0 ? 0.3 : 1, fontSize: 22, padding: '0 8px' }} onClick={() => setYear(years[yearIndex - 1])}>›</button>
        </div>
      )}

      {!hasData && (
        <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 40 }}>No spending or income recorded in {year} yet.</p>
      )}

      {hasData && (
        <>
          <div className="card hero-card" style={{ marginBottom: 16 }}>
            <span className="hero-label">Spent in {year}{spanLabel ? ` · ${spanLabel}` : ''}</span>
            <span className="hero-amount amount" data-testid="yir-spent" style={{ fontSize: 34 }}>{formatCurrency(review.spent)}</span>
            {review.previousYearSpent !== null && review.previousYearSpent > 0 && (() => {
              const diff = review.spent - review.previousYearSpent
              const pct = Math.round((Math.abs(diff) / review.previousYearSpent) * 100)
              return (
                <span data-testid="yir-vs-prev" style={{ fontSize: 13, color: diff <= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {diff === 0 ? 'Same as' : `${formatCurrency(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} (${pct}%) than`} the same months of {year - 1}
                </span>
              )
            })()}
          </div>

          <div className="stat-grid" style={{ marginBottom: 16 }}>
            <div className="card stat-card" style={{ background: 'color-mix(in srgb, var(--green) 8%, var(--surface))' }}>
              <span className="stat-label">Income</span>
              <span className="amount" data-testid="yir-income" style={{ color: 'var(--green)', fontSize: 20, fontWeight: 700 }}>{formatCurrency(review.income)}</span>
            </div>
            <div className="card stat-card" style={{ background: 'color-mix(in srgb, var(--indigo) 8%, var(--surface))' }}>
              <span className="stat-label">{review.saved < 0 ? 'Drawn from savings' : 'Saved'}</span>
              <span className="amount" data-testid="yir-saved" style={{ color: 'var(--indigo)', fontSize: 20, fontWeight: 700 }}>{formatCurrency(Math.abs(review.saved))}</span>
            </div>
          </div>
          <div className="card" style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div className="stat-label">Left over</div>
              <div className="hint" style={{ margin: 0 }}>Income − spent − saved</div>
            </div>
            <span className="amount" data-testid="yir-leftover" style={{ fontSize: 20, fontWeight: 700, color: review.leftOver >= 0 ? 'var(--green)' : 'var(--red)' }}>
              {review.leftOver < 0 ? '−' : ''}{formatCurrency(Math.abs(review.leftOver))}
            </span>
          </div>
          {review.savingsRate !== null && (
            <p className="hint" data-testid="yir-rate" style={{ margin: '-4px 4px 16px' }}>
              {review.savingsRate >= 0
                ? `You set aside ${Math.round(review.savingsRate * 100)}% of your income.`
                : `You drew down savings equal to ${Math.round(Math.abs(review.savingsRate) * 100)}% of your income.`}
            </p>
          )}

          <div className="card" style={{ marginBottom: 16 }}>
            <span className="section-heading" style={{ margin: '0 0 12px' }}>Spending by Month</span>
            <BarChart
              data={review.months.map((m) => ({
                label: `${dayMonth(m.start)} – ${dayMonth(new Date(m.end.getFullYear(), m.end.getMonth(), m.end.getDate() - 1))}`,
                axisLabel: m.label[0],
                value: m.started ? m.spent : 0
              }))}
              height={110}
              preferredStep={2000}
              defaultSummary={`Averaging ${formatCurrency(review.averageMonthlySpend)} a month`}
            />
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <span className="section-heading" style={{ margin: '0 0 4px' }}>Highlights</span>
            <Highlight label="Average month" value={formatCurrency(review.averageMonthlySpend)} sub={`over ${review.monthsCounted} month${review.monthsCounted === 1 ? '' : 's'}`} />
            {review.priciestMonth && <Highlight label="Priciest month" value={formatCurrency(review.priciestMonth.spent)} sub={`${review.priciestMonth.label} · ${dayMonth(review.priciestMonth.start)} – ${dayMonth(new Date(review.priciestMonth.end.getFullYear(), review.priciestMonth.end.getMonth(), review.priciestMonth.end.getDate() - 1))}`} />}
            {review.quietestMonth && <Highlight label="Quietest month" value={formatCurrency(review.quietestMonth.spent)} sub={review.quietestMonth.label} />}
            {review.biggestExpense && <Highlight label="Biggest expense" value={formatCurrency(review.biggestExpense.amount)} sub={`${review.biggestExpense.note} · ${dayMonth(review.biggestExpense.date)}`} />}
            {review.daysTracked > 0 && <Highlight label="No-spend days" value={`${review.noSpendDays} of ${review.daysTracked}`} sub="days with nothing spent" />}
            <Highlight label="Transactions" value={String(review.transactionCount)} />
          </div>

          {review.topCategories.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 8px' }}>Where It Went</span>
              {review.topCategories.map((c) => (
                <div key={c.categoryId} style={{ padding: '8px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                    <div className="tx-icon" style={{ width: 30, height: 30, background: c.color + '33', flexShrink: 0 }}>{c.icon}</div>
                    <span style={{ flex: 1, fontSize: 14 }}>{c.name}</span>
                    <span className="amount" style={{ fontSize: 14 }}>{formatCurrency(c.amount)}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-faint)', width: 36, textAlign: 'right' }}>{Math.round(c.share * 100)}%</span>
                  </div>
                  <AnimatedProgressBar fraction={c.share} color={c.color} />
                </div>
              ))}
            </div>
          )}

          {review.topMerchants.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <span className="section-heading" style={{ margin: '0 0 4px' }}>Top Merchants</span>
              {review.topMerchants.map((m, i) => (
                <div key={m.name + i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: i < review.topMerchants.length - 1 ? '0.5px solid var(--border)' : 'none' }}>
                  <span style={{ width: 20, color: 'var(--text-faint)', fontSize: 13 }}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{m.count} purchase{m.count === 1 ? '' : 's'}</div>
                  </div>
                  <span className="amount" style={{ fontSize: 14 }}>{formatCurrency(m.amount)}</span>
                </div>
              ))}
            </div>
          )}

          <p className="hint" style={{ margin: '0 4px 24px' }}>
            Spending, income and saving use the same rules as the dashboard.
            {isCustomCycle() ? ' Months follow your budget cycle and are named for the calendar month that holds most of each one.' : ''}
            {' '}Purchases are grouped by merchant name, so the same shop under different bank wording may appear separately.
          </p>
        </>
      )}
    </div>
  )
}
