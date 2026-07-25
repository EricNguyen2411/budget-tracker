import { useState } from 'react'
import type { Category } from '../types'
import { suggestBudgets } from '../budgetSuggestions'
import { formatCurrency } from '../calculations'
import { saveCategory } from '../db'

interface Props {
  categories: Category[]
  onBack: () => void
  onChanged: () => void
}

export default function TotalBudgetPlanner({ categories, onBack, onChanged }: Props) {
  const [income, setIncome] = useState('')
  const [budgets, setBudgets] = useState<Map<string, string>>(new Map(categories.filter((c) => !c.parentId).map((c) => [c.id, c.monthlyBudget ? String(c.monthlyBudget) : ''])))

  const parsedIncome = parseFloat(income) || 0
  const suggestions = parsedIncome > 0 ? suggestBudgets(categories, parsedIncome) : []
  const suggestionByCategory = new Map(suggestions.map((s) => [s.categoryId, s]))

  const topLevel = categories.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder)
  const totalAllocated = [...budgets.values()].reduce((sum, v) => sum + (parseFloat(v) || 0), 0)

  function applySuggestion(categoryId: string) {
    const s = suggestionByCategory.get(categoryId)
    if (!s) return
    setBudgets((prev) => new Map(prev).set(categoryId, String(s.suggestedAmount)))
  }

  function fillAllRecognized() {
    const next = new Map(budgets)
    for (const s of suggestions) {
      if (!next.get(s.categoryId)) next.set(s.categoryId, String(s.suggestedAmount))
    }
    setBudgets(next)
  }

  async function handleSave() {
    for (const c of topLevel) {
      const value = parseFloat(budgets.get(c.id) ?? '') || 0
      if (value !== c.monthlyBudget) {
        await saveCategory({ ...c, monthlyBudget: value })
      }
    }
    onChanged()
    onBack()
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Total Budget Planner</h1>
        <button className="text-button text-button-primary" onClick={handleSave}>Save</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <label className="field-label">Total Monthly Income</label>
        <input type="number" inputMode="decimal" placeholder="0.00" value={income} onChange={(e) => setIncome(e.target.value)} />
        <p className="hint" style={{ marginTop: 8 }}>
          Savings categories get 15% of this total first — split evenly if you have more than one. What's left is divided across spending categories by typical relative weight (Rent gets the biggest share, Entertainment a smaller one), not equally.
        </p>
      </div>

      {suggestions.length > 0 && (
        <button className="list-button" style={{ marginBottom: 16, color: 'var(--blue)', fontWeight: 600 }} onClick={fillAllRecognized}>
          Fill All Empty Budgets With Suggestions
        </button>
      )}

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {topLevel.map((c) => {
          const suggestion = suggestionByCategory.get(c.id)
          return (
            <div key={c.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span style={{ flex: 1, fontSize: 14 }}>{c.icon} {c.name}{c.isSavingsCategory && <span className="badge">Savings</span>}</span>
                <input
                  type="number" inputMode="decimal" placeholder="0.00"
                  value={budgets.get(c.id) ?? ''}
                  onChange={(e) => setBudgets((prev) => new Map(prev).set(c.id, e.target.value))}
                  style={{ width: 100, textAlign: 'right' }}
                />
              </div>
              {suggestion && (
                <button onClick={() => applySuggestion(c.id)} style={{ fontSize: 12, color: 'var(--blue)' }}>
                  Suggested: {formatCurrency(suggestion.suggestedAmount)} ({suggestion.explanation})
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="card" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 14 }}>Total Allocated</span>
        <span className="amount" style={{ fontWeight: 600, color: parsedIncome > 0 && totalAllocated > parsedIncome ? 'var(--red)' : 'var(--text)' }}>
          {formatCurrency(totalAllocated)}{parsedIncome > 0 ? ` / ${formatCurrency(parsedIncome)}` : ''}
        </span>
      </div>
    </div>
  )
}
