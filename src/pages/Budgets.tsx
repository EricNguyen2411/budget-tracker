import { useState } from 'react'
import type { Category, Transaction } from '../types'
import { netSpentForCategory, effectiveBudget, formatCurrency } from '../calculations'
import AnimatedProgressBar from '../components/AnimatedProgressBar'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onOpenCategory: (id: string) => void
}

export default function Budgets({ categories, transactions, onOpenCategory }: Props) {
  const now = new Date()
  const [sortMode, setSortMode] = useState<'default' | 'status'>('default')

  const withStatus = categories
    .filter((c) => !c.parentId)
    .map((category) => {
      const budget = effectiveBudget(category, categories)
      const spent = Math.max(0, netSpentForCategory(category, categories, transactions, now))
      return { category, budget, spent, remaining: budget - spent }
    })

  // "Status" order: over budget first (worst overage at the very top),
  // then under budget (closest to the limit next), categories with no
  // budget set at all pushed to the end — sorting by "remaining" alone
  // would put those at a meaningless, arbitrary position since a $0
  // budget and $0 spent both compute to remaining=0, indistinguishable
  // from being exactly on budget.
  const topLevel = sortMode === 'default'
    ? withStatus.sort((a, b) => a.category.sortOrder - b.category.sortOrder).map((w) => w.category)
    : withStatus
        .sort((a, b) => {
          if (a.budget <= 0 && b.budget <= 0) return a.category.sortOrder - b.category.sortOrder
          if (a.budget <= 0) return 1
          if (b.budget <= 0) return -1
          return a.remaining - b.remaining
        })
        .map((w) => w.category)

  return (
    <div className="screen">
      <div className="screen-header-row">
        <h1 className="screen-title" style={{ margin: 0 }}>Budgets</h1>
        <div style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 8, padding: 2 }}>
          <button
            onClick={() => setSortMode('default')}
            style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, fontWeight: sortMode === 'default' ? 600 : 400, background: sortMode === 'default' ? 'var(--surface)' : 'transparent' }}
          >
            Default
          </button>
          <button
            onClick={() => setSortMode('status')}
            style={{ fontSize: 12, padding: '5px 10px', borderRadius: 6, fontWeight: sortMode === 'status' ? 600 : 400, background: sortMode === 'status' ? 'var(--surface)' : 'transparent' }}
          >
            Over Budget First
          </button>
        </div>
      </div>

      {topLevel.map((category) => {
        const budget = effectiveBudget(category, categories)
        const spent = Math.max(0, netSpentForCategory(category, categories, transactions, now))
        const fraction = budget > 0 ? Math.min(1, spent / budget) : 0
        const over = budget > 0 && spent > budget
        const subs = categories.filter((c) => c.parentId === category.id)

        return (
          <button className="card" key={category.id} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 12 }} onClick={() => onOpenCategory(category.id)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontFamily: 'var(--font-display)', fontWeight: 600 }}>
                {category.icon} {category.name}
                {category.isSavingsCategory && <span className="badge">Savings</span>}
              </span>
              <span className="amount" style={{ color: over ? 'var(--red)' : 'var(--text-dim)', fontSize: 13 }}>
                {formatCurrency(spent)}{budget > 0 ? ` / ${formatCurrency(budget)}` : ''}
              </span>
            </div>
            {budget > 0 && (
              <AnimatedProgressBar fraction={fraction} color={over ? 'var(--red)' : category.color} trackStyle={{ marginTop: 10 }} />
            )}
            {subs.length > 0 && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {subs.map((s) => {
                  const subSpent = Math.max(0, netSpentForCategory(s, categories, transactions, now))
                  return (
                    <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-dim)' }}>
                      <span>{s.icon} {s.name}</span>
                      <span className="amount">{formatCurrency(subSpent)}{s.monthlyBudget > 0 ? ` / ${formatCurrency(s.monthlyBudget)}` : ''}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}
