const WIDGETS_KEY = 'budget-tracker-dashboard-widgets'

export type WidgetId = 'safeToSpend' | 'stats' | 'insights' | 'goals' | 'budgetVsActual' | 'categoryPie' | 'last14Days' | 'monthlyTrend' | 'netSavingsTrend' | 'topMerchants'

export const WIDGET_LABELS: Record<WidgetId, string> = {
  safeToSpend: 'Safe to Spend',
  stats: 'Spent / Income / Reimbursed / Saved',
  insights: 'Insights',
  goals: 'Savings Goals',
  budgetVsActual: 'Budget vs Actual',
  categoryPie: 'Spending by Category',
  last14Days: 'Last 14 Days',
  monthlyTrend: 'Monthly Trend',
  netSavingsTrend: 'Net Savings Trend',
  topMerchants: 'Top Merchants This Month'
}

const ALL_WIDGETS: WidgetId[] = ['safeToSpend', 'stats', 'insights', 'goals', 'budgetVsActual', 'categoryPie', 'last14Days', 'monthlyTrend', 'netSavingsTrend', 'topMerchants']

// safeToSpend and stats are core to the dashboard and always shown —
// not offered as hideable, same as the native app treats them.
const HIDEABLE: WidgetId[] = ALL_WIDGETS.filter((w) => w !== 'safeToSpend' && w !== 'stats')

export function getHiddenWidgets(): Set<WidgetId> {
  try {
    const raw = localStorage.getItem(WIDGETS_KEY)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as WidgetId[])
  } catch {
    return new Set()
  }
}

export function setWidgetHidden(id: WidgetId, hidden: boolean) {
  const current = getHiddenWidgets()
  if (hidden) current.add(id)
  else current.delete(id)
  localStorage.setItem(WIDGETS_KEY, JSON.stringify([...current]))
}

export function hideableWidgets(): WidgetId[] {
  return HIDEABLE
}
