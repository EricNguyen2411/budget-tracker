import { useMemo, useState } from 'react'
import type { Category, Transaction } from '../types'
import { suggestBudgets } from '../budgetSuggestions'
import { formatCurrency, goalProgress, computeDashboardTotals } from '../calculations'
import { saveCategory } from '../db'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onChanged: () => void
}

export default function TotalBudgetPlanner({ categories, transactions, onBack, onChanged }: Props) {
  useSwipeBack(onBack)
  const [income, setIncome] = useState('')
  const [incomeTouched, setIncomeTouched] = useState(false)
  const [savings, setSavings] = useState('')
  const [savingsTouched, setSavingsTouched] = useState(false)
  const [totalBudget, setTotalBudget] = useState('')
  const [totalBudgetTouched, setTotalBudgetTouched] = useState(false)

  // A category with subcategories never gets its own editable box here
  // — see subsOf() below — so the only things that ever need an entry
  // in this map are actual leaf categories: top-level categories with
  // no children, plus every subcategory. This is what makes the
  // planner and Safe to Spend agree by construction: there's no longer
  // a parent-level number that can silently be overridden, because the
  // planner never writes one in the first place when subcategories
  // exist.
  const [budgets, setBudgets] = useState<Map<string, string>>(
    new Map(categories.filter((c) => isLeaf(c, categories)).map((c) => [c.id, c.monthlyBudget ? String(c.monthlyBudget) : '']))
  )

  const now = new Date()

  function subsOf(categoryId: string): Category[] {
    return categories.filter((s) => s.parentId === categoryId)
  }

  // Auto-populated from what you actually earned last month — the last
  // FULL month, not the still-in-progress current one, since that
  // wouldn't be a complete figure yet. Still fully editable, same as
  // savings and the total below.
  const lastMonth = useMemo(() => new Date(now.getFullYear(), now.getMonth() - 1, 1), [])
  const lastMonthTotals = useMemo(() => computeDashboardTotals(categories, transactions, lastMonth), [categories, transactions, lastMonth])
  const suggestedIncome = lastMonthTotals.income

  const effectiveIncome = incomeTouched ? (parseFloat(income) || 0) : suggestedIncome
  const parsedIncome = effectiveIncome

  // A smart starting point for the savings field: what your existing
  // goals with a target date actually need this month to stay on pace,
  // summed up — not a guess, the real gap-over-months-remaining math.
  // Falls back to what you actually saved last month if there's no
  // goal with a target date to calculate a pace from at all.
  const goalPaceSavings = useMemo(() => {
    const goalCats = categories.filter((c) => !c.parentId && c.isSavingsCategory && c.goalTargetDate && c.goalTargetAmount > 0)
    return goalCats.reduce((sum, c) => {
      const remaining = c.goalTargetAmount - goalProgress(c, transactions)
      if (remaining <= 0) return sum
      const target = new Date(c.goalTargetDate!)
      const monthsLeft = Math.max(1, (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth()))
      return sum + remaining / monthsLeft
    }, 0)
  }, [categories, transactions])
  const suggestedSavings = goalPaceSavings > 0 ? goalPaceSavings : lastMonthTotals.saved


  const effectiveSavings = savingsTouched ? (parseFloat(savings) || 0) : suggestedSavings
  const suggestions = parsedIncome > 0 ? suggestBudgets(categories, parsedIncome, effectiveSavings, transactions, now) : []
  const suggestionByCategory = new Map(suggestions.map((s) => [s.categoryId, s]))

  const topLevel = categories.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder)
  const spendingCats = topLevel.filter((c) => !c.isSavingsCategory)
  // "Other" is the catch-all — whatever's left of the total budget once
  // every other category (spending AND savings both, since the total is
  // your full income now, not just what's left after savings) has its
  // own number set, computed fresh on every render rather than stored
  // and kept in sync by hand, so it can never drift out of date with
  // whatever you've typed elsewhere. Matched by name since there's no
  // dedicated flag for "this is the leftover bucket." Assumes "Other"
  // itself has no subcategories — a category being both a leftover
  // bucket and split into subcategories isn't a combination this
  // handles specially, since there'd be no single field to write the
  // remainder into.
  const otherCategory = spendingCats.find((c) => c.name.trim().toLowerCase() === 'other')

  // Defaults straight to your income — the whole point is putting your
  // real income in and allocating every dollar of it yourself, not a
  // pre-reduced figure you'd then have to add savings back on top of.
  const effectiveTotalBudget = totalBudgetTouched ? (parseFloat(totalBudget) || 0) : parsedIncome

  // What a top-level category will actually contribute to Safe to
  // Spend once saved. For a category split into subcategories, that's
  // the live sum of what's currently in each subcategory's own box
  // here — not a separate parent number, since one is never shown or
  // saved for it. This is what makes "Total Allocated" below always
  // equal to what Safe to Spend will show immediately after Save, with
  // no separate override step to go out of sync.
  function actualContribution(categoryId: string): number {
    const subs = subsOf(categoryId)
    if (subs.length > 0) {
      return subs.reduce((sum, s) => sum + (parseFloat(displayBudget(s.id)) || 0), 0)
    }
    return parseFloat(displayBudget(categoryId)) || 0
  }

  const otherRemainder = useMemo(() => {
    if (!otherCategory) return 0
    const othersSum = topLevel
      .filter((c) => c.id !== otherCategory.id)
      .reduce((sum, c) => sum + actualContribution(c.id), 0)
    return Math.max(0, effectiveTotalBudget - othersSum)
  }, [otherCategory, topLevel, budgets, categories, effectiveTotalBudget])

  // What's actually shown/saved per leaf category — Other is overridden
  // with the live-computed remainder instead of whatever's sitting in
  // the budgets map for it.
  function displayBudget(categoryId: string): string {
    if (otherCategory && categoryId === otherCategory.id) return String(Math.round(otherRemainder))
    return budgets.get(categoryId) ?? ''
  }

  const totalAllocated = topLevel.reduce((sum, c) => sum + actualContribution(c.id), 0)

  /** Splits a suggested total evenly across a category's subcategories
   * as whole dollars, giving any leftover cent-of-a-dollar to the first
   * few rather than letting rounding silently drop it — so the split
   * always reconstructs the original suggested amount exactly. */
  function splitEvenly(total: number, count: number): number[] {
    const base = Math.floor(total / count)
    const remainder = Math.round(total - base * count)
    return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
  }

  function applySuggestion(categoryId: string) {
    const s = suggestionByCategory.get(categoryId)
    if (!s) return
    const subs = subsOf(categoryId)
    if (subs.length > 0) {
      const shares = splitEvenly(s.suggestedAmount, subs.length)
      setBudgets((prev) => {
        const next = new Map(prev)
        subs.forEach((sub, i) => next.set(sub.id, String(shares[i])))
        return next
      })
    } else {
      setBudgets((prev) => new Map(prev).set(categoryId, String(s.suggestedAmount)))
    }
  }

  function fillAllRecognized() {
    const next = new Map(budgets)
    for (const s of suggestions) {
      const subs = subsOf(s.categoryId)
      if (subs.length > 0) {
        if (subs.some((sub) => next.get(sub.id))) continue // at least one already has a number — leave the group alone
        const shares = splitEvenly(s.suggestedAmount, subs.length)
        subs.forEach((sub, i) => next.set(sub.id, String(shares[i])))
      } else if (!next.get(s.categoryId)) {
        next.set(s.categoryId, String(s.suggestedAmount))
      }
    }
    setBudgets(next)
  }

  async function handleSave() {
    for (const c of categories.filter((cat) => isLeaf(cat, categories))) {
      const value = parseFloat(displayBudget(c.id)) || 0
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

      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--blue)' }}>
        <p style={{ fontSize: 13, lineHeight: 1.5 }}>
          Use this for setting up all your budgets at once against your income, or a full rebalance — it saves every category's budget together when you tap Save above. For a quick one-off tweak to a single category, edit it directly in <strong>More → Categories</strong> instead, which is faster and saves immediately.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-row">
          <span className="form-row-label">Total Monthly Income</span>
          <input
            type="number" inputMode="decimal"
            placeholder={suggestedIncome > 0 ? suggestedIncome.toFixed(0) : '0.00'}
            value={incomeTouched ? income : (suggestedIncome > 0 ? String(Math.round(suggestedIncome)) : '')}
            onChange={(e) => { setIncome(e.target.value); setIncomeTouched(true) }}
          />
        </div>
        {suggestedIncome > 0 && (
          <p className="hint" style={{ marginTop: 10 }}>Pre-filled with what you actually earned last month ({formatCurrency(suggestedIncome)}) — change it to whatever you're expecting this month instead.</p>
        )}

        <div className="form-row">
          <span className="form-row-label">Set Aside for Savings</span>
          <input
            type="number" inputMode="decimal"
            placeholder={suggestedSavings > 0 ? suggestedSavings.toFixed(0) : '0.00'}
            value={savingsTouched ? savings : (suggestedSavings > 0 ? String(Math.round(suggestedSavings)) : '')}
            onChange={(e) => { setSavings(e.target.value); setSavingsTouched(true) }}
          />
        </div>
        {suggestedSavings > 0 && (
          <p className="hint" style={{ marginTop: 10 }}>
            {goalPaceSavings > 0
              ? `Pre-filled with what your savings goals with a target date actually need this month to stay on pace (${formatCurrency(suggestedSavings)}) — a real number from your goals, not a guess.`
              : `Pre-filled with what you actually saved last month (${formatCurrency(suggestedSavings)}) — no goal with a target date to calculate a pace from yet.`} Change it to whatever you'd rather set aside.
          </p>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          Used to work out spending suggestions below (splitting whatever's left of income after this, weighted by ABS Household Expenditure Survey averages) — doesn't reduce the Total Budget below, which is your full income. Set the actual savings budget in the category list like any other category.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="form-row">
          <span className="form-row-label">Total Budget</span>
          <input
            type="number" inputMode="decimal"
            placeholder={parsedIncome > 0 ? parsedIncome.toFixed(0) : '0.00'}
            value={totalBudgetTouched ? totalBudget : (parsedIncome > 0 ? String(Math.round(parsedIncome)) : '')}
            onChange={(e) => { setTotalBudget(e.target.value); setTotalBudgetTouched(true) }}
          />
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Defaults to your income above — put in the real number and allocate every dollar of it yourself, savings included (set a budget on your savings categories below just like any spending category). {otherCategory ? `"${otherCategory.name}" automatically absorbs whatever's left once everything else has a number, so it always adds up without working out the remainder by hand.` : 'Add a category named "Other" to have it automatically absorb whatever\u2019s left.'}
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
          const isOther = otherCategory?.id === c.id
          const subs = subsOf(c.id)
          const hasSubs = subs.length > 0

          return (
            <div key={c.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: hasSubs ? 8 : 6 }}>
                <span style={{ flex: 1, fontSize: 14 }}>{c.icon} {c.name}{c.isSavingsCategory && <span className="badge">Savings</span>}</span>
                {hasSubs ? (
                  // No editable box for a category split into
                  // subcategories — its number is always the live sum
                  // of the boxes below, shown read-only so it's clear
                  // this row itself isn't what to edit.
                  <span className="amount" style={{ fontSize: 14, color: 'var(--text-dim)' }}>{formatCurrency(actualContribution(c.id))}</span>
                ) : (
                  <input
                    type="number" inputMode="decimal" placeholder="0.00"
                    value={displayBudget(c.id)}
                    onChange={(e) => !isOther && setBudgets((prev) => new Map(prev).set(c.id, e.target.value))}
                    readOnly={isOther}
                    style={{ width: 100, textAlign: 'right', color: isOther ? 'var(--text-dim)' : undefined }}
                  />
                )}
              </div>

              {hasSubs && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 16, marginBottom: 4 }}>
                  {subs.map((s) => (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-dim)' }}>{s.icon} {s.name}</span>
                      <input
                        type="number" inputMode="decimal" placeholder="0.00"
                        value={displayBudget(s.id)}
                        onChange={(e) => setBudgets((prev) => new Map(prev).set(s.id, e.target.value))}
                        style={{ width: 90, textAlign: 'right', fontSize: 13 }}
                      />
                    </div>
                  ))}
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Split across subcategories — {c.name}'s own total above is just their sum.</span>
                </div>
              )}

              {isOther && (
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Automatically the remainder of your total spending budget</span>
              )}
              {suggestion && !isOther && (
                <button onClick={() => applySuggestion(c.id)} style={{ fontSize: 12, color: 'var(--blue)' }}>
                  Suggested: {formatCurrency(suggestion.suggestedAmount)} ({suggestion.explanation}){hasSubs ? ' — split evenly across subcategories' : ''}
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="card" style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 14 }}>Total Allocated</span>
        <span className="amount" style={{ fontWeight: 600, color: effectiveTotalBudget > 0 && totalAllocated > effectiveTotalBudget ? 'var(--red)' : 'var(--text)' }}>
          {formatCurrency(totalAllocated)}{effectiveTotalBudget > 0 ? ` / ${formatCurrency(effectiveTotalBudget)}` : ''}
        </span>
      </div>
    </div>
  )
}

function isLeaf(category: Category, allCategories: Category[]): boolean {
  return !allCategories.some((c) => c.parentId === category.id)
}
