const HIDDEN_KEY = 'budget-tracker-hidden-insights'

export type InsightId = 'period' | 'cashFlow' | 'comparison' | 'biggestChange' | 'needsWants' | 'weekday' | 'netWorth' | 'subscriptionCreep' | 'merchantCreep' | 'topMerchants'

export const INSIGHT_LABELS: Record<InsightId, string> = {
  period: 'Spent this period',
  cashFlow: 'Cash flow until payday',
  comparison: 'This period vs last',
  biggestChange: 'Biggest category change',
  needsWants: 'Needs vs wants',
  weekday: 'Weekday vs weekend',
  netWorth: 'Net worth (and trend)',
  subscriptionCreep: 'Subscription price changes',
  merchantCreep: 'Gradual merchant price creep',
  topMerchants: 'Top merchants this period'
}

export const ALL_INSIGHTS: InsightId[] = ['period', 'cashFlow', 'comparison', 'biggestChange', 'needsWants', 'weekday', 'netWorth', 'subscriptionCreep', 'merchantCreep', 'topMerchants']

export function getHiddenInsights(): Set<InsightId> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as InsightId[])
  } catch {
    return new Set()
  }
}

export function setInsightHidden(id: InsightId, hidden: boolean) {
  const current = getHiddenInsights()
  if (hidden) current.add(id)
  else current.delete(id)
  localStorage.setItem(HIDDEN_KEY, JSON.stringify([...current]))
}
