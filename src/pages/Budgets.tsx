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
  const topLevel = categories.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder)

  return (
    <div className="screen">
      <h1 className="screen-title">Budgets</h1>

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
