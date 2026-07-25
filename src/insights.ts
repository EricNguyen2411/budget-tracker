import type { Category, Transaction } from './types'
import { netSpentForCategory, effectiveBudget, formatCurrency, isGoal, goalProgressFraction, projectedGoalCompletionDate } from './calculations'
import { periodContaining, referenceDateOffsetBy } from './budgetPeriod'

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

    const dailyPace = spentSoFar / daysElapsed
    const projected = dailyPace * daysInPeriod
    const overage = projected - budget
    if (overage <= 5) continue

    results.push({
      icon: '⚠️',
      text: `${category.name} is on pace to exceed budget by about ${formatCurrency(overage)} this period.`,
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
