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

const ORDER_KEY = 'budget-tracker-dashboard-widget-order'

export function getWidgetOrder(): WidgetId[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    const stored = raw ? (JSON.parse(raw) as WidgetId[]) : []
    // Any widget not in the stored order (e.g. added in an update) goes
    // at the end, in its default position, rather than disappearing.
    const missing = ALL_WIDGETS.filter((w) => !stored.includes(w))
    return [...stored.filter((w) => ALL_WIDGETS.includes(w)), ...missing]
  } catch {
    return ALL_WIDGETS
  }
}

export function setWidgetOrder(order: WidgetId[]) {
  localStorage.setItem(ORDER_KEY, JSON.stringify(order))
}

export function moveWidget(id: WidgetId, direction: 'up' | 'down') {
  const order = getWidgetOrder()
  const index = order.indexOf(id)
  const swapWith = direction === 'up' ? index - 1 : index + 1
  if (swapWith < 0 || swapWith >= order.length) return
  ;[order[index], order[swapWith]] = [order[swapWith], order[index]]
  setWidgetOrder(order)
}

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
