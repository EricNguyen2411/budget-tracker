import { useEffect, useMemo, useState } from 'react'
import type { Category, Transaction, Account, RecurringTransaction, NetWorthSnapshot } from '../types'
import { spentThisPeriod, spentByCategory, spentByTag, budgetComparison, biggestCategoryChange, topMerchants, needsWantsSplit, netWorth, subscriptionCreep, cashFlowAnswer, weekdayWeekendSplit, merchantSpendingCreep, type Answer } from '../insightQueries'
import { getNetWorthSnapshots } from '../db'
import { getHiddenInsights, setInsightHidden, ALL_INSIGHTS, INSIGHT_LABELS, type InsightId } from '../insightPreferences'
import { normalizeTag } from '../tags'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  accounts: Account[]
  recurring: RecurringTransaction[]
  onBack: () => void
}

function AnswerCard({ answer }: { answer: Answer }) {
  const color = answer.sentiment === 'warning' ? 'var(--red)' : answer.sentiment === 'positive' ? 'var(--green)' : 'var(--text)'
  return (
    <div className="card" style={{ marginBottom: 10, padding: 12 }}>
      <p style={{ fontSize: 14, color }}>{answer.text}</p>
    </div>
  )
}

export default function Insights({ categories, transactions, accounts, recurring, onBack }: Props) {
  useSwipeBack(onBack)
  const now = new Date()
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [netWorthHistory, setNetWorthHistory] = useState<NetWorthSnapshot[]>([])
  const [hidden, setHidden] = useState<Set<InsightId>>(() => getHiddenInsights())
  const [customizing, setCustomizing] = useState(false)

  function toggleInsight(id: InsightId) {
    const nowHidden = !hidden.has(id)
    setInsightHidden(id, nowHidden)
    setHidden(getHiddenInsights())
  }

  useEffect(() => {
    getNetWorthSnapshots().then((snapshots) => setNetWorthHistory(snapshots.slice(-30)))
  }, [])

  const topLevel = categories.filter((c) => !c.parentId)
  const allTags = useMemo(() => {
    const seen = new Set<string>()
    for (const t of transactions) for (const raw of t.tags) { const tag = normalizeTag(raw); if (tag) seen.add(tag) }
    return Array.from(seen)
  }, [transactions])

  // These three don't need a tap at all — cheap to compute, always
  // relevant, no ambiguity to resolve, so there's no reason to make
  // them wait for a question to be asked first.
  const periodAnswer = spentThisPeriod(categories, transactions, accounts, recurring, now)
  const comparisonAnswer = budgetComparison(categories, transactions, accounts, recurring, now)
  const changeAnswer = biggestCategoryChange(categories, transactions, now)
  const needsWantsAnswer = needsWantsSplit(categories, transactions, now)
  const netWorthAnswer = netWorth(accounts, transactions)
  const cashFlow = cashFlowAnswer(categories, transactions, accounts, recurring, now)
  const merchants = topMerchants(transactions, now, 5).merchants
  const weekdayAnswer = weekdayWeekendSplit(transactions, now)
  const creepItems = useMemo(() => subscriptionCreep(recurring, transactions), [recurring, transactions])
  const merchantCreepItems = merchantSpendingCreep(transactions, now)

  const selectedCategory = selectedCategoryId ? topLevel.find((c) => c.id === selectedCategoryId) : null
  const categoryAnswer = selectedCategory ? spentByCategory(selectedCategory, categories, transactions, now) : null
  const tagAnswer = selectedTag ? spentByTag(selectedTag, transactions) : null

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Insights</h1>
        <button onClick={() => setCustomizing((v) => !v)} className="text-button" style={{ fontSize: 13 }}>{customizing ? 'Done' : 'Customize'}</button>
      </div>

      {customizing && (
        <div className="card" style={{ marginBottom: 16, padding: 12 }}>
          <span className="section-heading" style={{ display: 'block', marginBottom: 8 }}>Show / hide</span>
          {ALL_INSIGHTS.map((id) => (
            <div key={id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
              <span style={{ fontSize: 14 }}>{INSIGHT_LABELS[id]}</span>
              <input type="checkbox" switch checked={!hidden.has(id)} onChange={() => toggleInsight(id)} />
            </div>
          ))}
        </div>
      )}

      {!hidden.has('period') && <AnswerCard answer={periodAnswer} />}
      {!hidden.has('cashFlow') && cashFlow && <AnswerCard answer={cashFlow} />}
      {!hidden.has('comparison') && <AnswerCard answer={comparisonAnswer} />}
      {!hidden.has('biggestChange') && <AnswerCard answer={changeAnswer} />}
      {!hidden.has('needsWants') && <AnswerCard answer={needsWantsAnswer} />}
      {!hidden.has('weekday') && <AnswerCard answer={weekdayAnswer} />}
      {!hidden.has('netWorth') && <AnswerCard answer={netWorthAnswer} />}

      {!hidden.has('netWorth') && netWorthHistory.length >= 2 && (() => {
        const values = netWorthHistory.map((s) => s.netWorth)
        const min = Math.min(...values, 0)
        const max = Math.max(...values, 0)
        const range = Math.max(1, max - min)
        return (
          <div className="card" style={{ marginBottom: 10, padding: 12 }}>
            <span className="section-heading" style={{ display: 'block', marginBottom: 8 }}>Net worth — last {netWorthHistory.length} days tracked</span>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 60 }}>
              {netWorthHistory.map((s) => {
                const heightPct = Math.max(2, ((s.netWorth - min) / range) * 100)
                return <div key={s.date} style={{ flex: 1, height: `${heightPct}%`, background: 'var(--blue)', borderRadius: 2, minHeight: 2 }} title={`${s.date}: ${s.netWorth}`} />
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{netWorthHistory[0].date}</span>
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{netWorthHistory[netWorthHistory.length - 1].date}</span>
            </div>
          </div>
        )
      })()}
      {!hidden.has('netWorth') && netWorthHistory.length < 2 && (
        <p className="hint" style={{ marginBottom: 10 }}>Net worth is now tracked once a day — a trend will build up here as more days pass.</p>
      )}

      {!hidden.has('subscriptionCreep') && creepItems.length > 0 && (
        <div className="card" style={{ marginBottom: 10, padding: 12, borderLeft: '3px solid var(--amber)' }}>
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>⚠️ Price change{creepItems.length === 1 ? '' : 's'} noticed</p>
          {creepItems.map((c, i) => (
            <p key={i} style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              {c.recurringNote}: was ${c.previousAmount.toFixed(2)}, now set to ${c.currentAmount.toFixed(2)}{c.currentAmount > c.previousAmount ? ' — went up' : ' — went down'}
            </p>
          ))}
        </div>
      )}

      {!hidden.has('merchantCreep') && merchantCreepItems.length > 0 && (
        <div className="card" style={{ marginBottom: 10, padding: 12, borderLeft: '3px solid var(--amber)' }}>
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>📈 Creeping up over time</p>
          {merchantCreepItems.slice(0, 5).map((c, i) => (
            <p key={i} style={{ fontSize: 13, color: 'var(--text-dim)', textTransform: 'capitalize' }}>
              {c.merchant}: averaged ${c.earlierAvg.toFixed(2)} a few months ago, now averaging ${c.recentAvg.toFixed(2)}
            </p>
          ))}
        </div>
      )}

      {!hidden.has('topMerchants') && merchants.length > 0 && (
        <>
          <span className="section-heading">Top merchants this period</span>
          <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            {merchants.map((m, i) => (
              <div key={m.note} className="transaction-row" style={{ borderBottom: i < merchants.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <span style={{ fontSize: 13 }}>{i + 1}. {m.note}</span>
                <span className="amount" style={{ fontSize: 13 }}>{m.amount.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {topLevel.length > 0 && (
        <>
          <span className="section-heading">By category</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {topLevel.map((c) => (
              <button
                key={c.id}
                onClick={() => setSelectedCategoryId(c.id === selectedCategoryId ? null : c.id)}
                style={{
                  fontSize: 13, padding: '6px 12px', borderRadius: 14,
                  background: c.id === selectedCategoryId ? 'var(--blue)' : 'var(--surface-2)',
                  color: c.id === selectedCategoryId ? '#fff' : 'var(--text)'
                }}
              >
                {c.icon} {c.name}
              </button>
            ))}
          </div>
          {categoryAnswer && <AnswerCard answer={categoryAnswer} />}
        </>
      )}

      {allTags.length > 0 && (
        <>
          <span className="section-heading">By trip / tag</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
            {allTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setSelectedTag(tag === selectedTag ? null : tag)}
                style={{
                  fontSize: 13, padding: '6px 12px', borderRadius: 14,
                  background: tag === selectedTag ? 'var(--blue)' : 'var(--surface-2)',
                  color: tag === selectedTag ? '#fff' : 'var(--text)'
                }}
              >
                🏷️ {tag}
              </button>
            ))}
          </div>
          {tagAnswer && <AnswerCard answer={tagAnswer} />}
        </>
      )}
    </div>
  )
}
