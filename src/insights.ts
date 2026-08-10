import type { Category, Transaction } from './types'
import { netSpentForCategory, effectiveBudget, formatCurrency, isGoal, goalProgressFraction, projectedGoalCompletionDate, categoryAndDescendantIds } from './calculations'
import { periodContaining, referenceDateOffsetBy, isInSamePeriod } from './budgetPeriod'

export interface Insight {
  icon: string
  text: string
  sentiment: 'positive' | 'warning' | 'neutral'
}

function categoryComparisons(categories: Category[], transactions: Transaction[], referenceDate: Date): Insight[] {
  const lastPeriodRef = referenceDateOffsetBy(-1, referenceDate)
  const results: Insight[] = []

  for (const category of categories.filter((c) => !c.parentId && !c.isSavingsCategory)) {
    const thisPeriod = netSpentForCategory(category, categories, transactions, referenceDate)
    const lastPeriod = netSpentForCategory(category, categories, transactions, lastPeriodRef)
    if (lastPeriod <= 0 || thisPeriod <= 0) continue

    const change = (thisPeriod - lastPeriod) / lastPeriod
    if (Math.abs(change) < 0.15) continue

    const pct = Math.round(Math.abs(change) * 100)
    if (change > 0) {
      results.push({
        icon: '📈',
        text: `${category.name} is up ${pct}% from last period (${formatCurrency(lastPeriod)} → ${formatCurrency(thisPeriod)}).`,
        sentiment: 'warning'
      })
    } else {
      results.push({
        icon: '📉',
        text: `${category.name} is down ${pct}% from last period (${formatCurrency(lastPeriod)} → ${formatCurrency(thisPeriod)}).`,
        sentiment: 'positive'
      })
    }
  }
  return results
}

function budgetProjections(categories: Category[], transactions: Transaction[], referenceDate: Date): Insight[] {
  const period = periodContaining(referenceDate)
  const daysInPeriod = Math.round((period.end.getTime() - period.start.getTime()) / (1000 * 60 * 60 * 24))
  const daysElapsed = Math.round((referenceDate.getTime() - period.start.getTime()) / (1000 * 60 * 60 * 24)) + 1
  if (daysElapsed < 5) return []

  const results: Insight[] = []
  for (const category of categories.filter((c) => !c.parentId && !c.isSavingsCategory)) {
    const budget = effectiveBudget(category, categories)
    if (budget <= 0) continue
    const spentSoFar = netSpentForCategory(category, categories, transactions, referenceDate)
    if (spentSoFar <= 0) continue

    // A day-rate projection only means something if the spending is
    // actually spread across the period — Groceries or Dining Out with
    // a dozen small transactions genuinely has a "pace." One flight
    // booked on day 3 doesn't have a pace at all, it's a single event,
    // and extrapolating it across the rest of the month wildly
    // overstates where things will land. This isn't about which
    // category it is by name (someone's "Travel" could easily have
    // frequent small transactions, and someone's "Shopping" could be
    // one big purchase) — it's about whether there's actually a
    // pattern here to project from.
    const ids = categoryAndDescendantIds(category, categories)
    const txCountThisPeriod = transactions.filter((t) => t.categoryId && ids.has(t.categoryId) && t.isExpense && isInSamePeriod(new Date(t.date), referenceDate)).length
    if (txCountThisPeriod < 3) continue

    const dailyPace = spentSoFar / daysElapsed
    const projected = dailyPace * daysInPeriod
    const overage = projected - budget
    if (overage <= 5) continue

    const currentOverage = spentSoFar - budget
    // A simple day-rate projection assumes spending is spread evenly
    // across the period — a fair assumption for something like
    // Groceries, but a poor one for a category like Travel, where one
    // early booking can skew the daily rate and make the projection
    // wildly overstate where things will actually land. Spelling out
    // the current position alongside the projection (rather than just
    // the projected figure alone) makes that gap visible instead of
    // presenting a projection as if it were already reality.
    const text = currentOverage > 5
      ? `${category.name} is on pace to exceed budget by about ${formatCurrency(overage)} this period (currently ${formatCurrency(currentOverage)} over, projected forward at the current daily rate).`
      : `${category.name} is only ${formatCurrency(Math.max(0, currentOverage))} over budget so far, but at the current daily rate is on pace to exceed it by about ${formatCurrency(overage)} by the end of the period — worth a look if that pace was a one-off rather than ongoing.`

    results.push({
      icon: '⚠️',
      text,
      sentiment: 'warning'
    })
  }
  return results
}

function goalInsights(categories: Category[], transactions: Transaction[], referenceDate: Date): Insight[] {
  const results: Insight[] = []
  for (const category of categories.filter((c) => !c.parentId && isGoal(c))) {
    if (goalProgressFraction(category, transactions) >= 1) {
      results.push({
        icon: '✅',
        text: `${category.name} has reached its ${formatCurrency(category.goalTargetAmount)} goal.`,
        sentiment: 'positive'
      })
      continue
    }
    const projected = projectedGoalCompletionDate(category, transactions, referenceDate)
    if (!projected) continue
    const projectedText = projected.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })

    if (category.goalTargetDate) {
      const target = new Date(category.goalTargetDate)
      const targetText = target.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
      if (projected <= target) {
        results.push({ icon: '✅', text: `At your current pace, ${category.name} is on track for ${projectedText} — ahead of your ${targetText} target.`, sentiment: 'positive' })
      } else {
        results.push({ icon: '⚠️', text: `At your current pace, ${category.name} won\u2019t be ready until ${projectedText} — behind your ${targetText} target.`, sentiment: 'warning' })
      }
    } else {
      results.push({ icon: '📅', text: `At your current pace, ${category.name} will reach its goal around ${projectedText}.`, sentiment: 'neutral' })
    }
  }
  return results
}

export function generateInsights(categories: Category[], transactions: Transaction[], referenceDate: Date = new Date()): Insight[] {
  return [
    ...goalInsights(categories, transactions, referenceDate),
    ...budgetProjections(categories, transactions, referenceDate),
    ...categoryComparisons(categories, transactions, referenceDate)
  ].slice(0, 4)
}
