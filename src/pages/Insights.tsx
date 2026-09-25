import { useMemo, useState } from 'react'
import type { Category, Transaction, Account, RecurringTransaction } from '../types'
import { spentThisPeriod, spentByCategory, spentByTag, budgetComparison, biggestCategoryChange, topMerchants, needsWantsSplit, netWorth, subscriptionCreep, type Answer } from '../insightQueries'
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
  const merchants = topMerchants(transactions, now, 5).merchants
  const creepItems = useMemo(() => subscriptionCreep(recurring, transactions), [recurring, transactions])

  const selectedCategory = selectedCategoryId ? topLevel.find((c) => c.id === selectedCategoryId) : null
  const categoryAnswer = selectedCategory ? spentByCategory(selectedCategory, categories, transactions, now) : null
  const tagAnswer = selectedTag ? spentByTag(selectedTag, transactions) : null

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Insights</h1>
        <span style={{ width: 40 }} />
      </div>

      <AnswerCard answer={periodAnswer} />
      <AnswerCard answer={comparisonAnswer} />
      <AnswerCard answer={changeAnswer} />
      <AnswerCard answer={needsWantsAnswer} />
      <AnswerCard answer={netWorthAnswer} />

      {creepItems.length > 0 && (
        <div className="card" style={{ marginBottom: 10, padding: 12, borderLeft: '3px solid var(--amber)' }}>
          <p style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>⚠️ Price change{creepItems.length === 1 ? '' : 's'} noticed</p>
          {creepItems.map((c, i) => (
            <p key={i} style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              {c.recurringNote}: was ${c.previousAmount.toFixed(2)}, now set to ${c.currentAmount.toFixed(2)}{c.currentAmount > c.previousAmount ? ' — went up' : ' — went down'}
            </p>
          ))}
        </div>
      )}

      {merchants.length > 0 && (
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
