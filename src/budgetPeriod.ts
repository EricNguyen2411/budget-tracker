const SETTINGS_KEY = 'budget-tracker-settings'

export interface StoredSettings {
  budgetCycleStartDay: number
  dismissedRecurringSuggestions: string[]
  nudgeEnabled: boolean
}

const DEFAULT_SETTINGS: StoredSettings = {
  budgetCycleStartDay: 1,
  dismissedRecurringSuggestions: [],
  nudgeEnabled: false
}

export function getSettings(): StoredSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: StoredSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function updateSettings(partial: Partial<StoredSettings>) {
  const current = getSettings()
  saveSettings({ ...current, ...partial })
}

export interface Period {
  start: Date
  end: Date
}

/** The budget period containing referenceDate, given the configured cycle start day. */
export function periodContaining(referenceDate: Date, startDay = getSettings().budgetCycleStartDay): Period {
  if (startDay <= 1) {
    const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1)
    const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 1)
    return { start, end }
  }

  let periodStart = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), startDay)
  if (referenceDate < periodStart) {
    periodStart = new Date(periodStart.getFullYear(), periodStart.getMonth() - 1, startDay)
  }
  const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, startDay)
  return { start: periodStart, end: periodEnd }
}

export function isInSamePeriod(date: Date, referenceDate: Date = new Date(), startDay = getSettings().budgetCycleStartDay): boolean {
  const period = periodContaining(referenceDate, startDay)
  return date >= period.start && date < period.end
}

/** The period `offset` cycles before (negative) or after (positive) the one containing referenceDate. */
export function periodOffsetBy(offset: number, referenceDate: Date = new Date(), startDay = getSettings().budgetCycleStartDay): Period {
  const current = periodContaining(referenceDate, startDay)
  const shiftedRef = new Date(current.start.getFullYear(), current.start.getMonth() + offset, current.start.getDate())
  return periodContaining(shiftedRef, startDay)
}

export function referenceDateOffsetBy(offset: number, referenceDate: Date = new Date(), startDay = getSettings().budgetCycleStartDay): Date {
  const target = periodOffsetBy(offset, referenceDate, startDay)
  return new Date(target.start.getTime() + 24 * 60 * 60 * 1000)
}

export function daysRemainingInPeriod(referenceDate: Date = new Date(), startDay = getSettings().budgetCycleStartDay): number {
  const period = periodContaining(referenceDate, startDay)
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate())
  const periodEndDay = new Date(period.end.getFullYear(), period.end.getMonth(), period.end.getDate())
  const days = Math.round((periodEndDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  return Math.max(1, days)
}
