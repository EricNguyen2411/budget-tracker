const SETTINGS_KEY = 'budget-tracker-settings'

export type CycleMode = 'fixedDay' | 'lastBusinessDay'

export interface StoredSettings {
  budgetCycleMode: CycleMode
  budgetCycleStartDay: number // meaningful only when budgetCycleMode is 'fixedDay'
  dismissedRecurringSuggestions: string[]
  nudgeEnabled: boolean
}

const DEFAULT_SETTINGS: StoredSettings = {
  budgetCycleMode: 'fixedDay',
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

/** True when the budget cycle resets on anything other than the plain
 * 1st-of-the-month default — used throughout the app to decide whether
 * a date range needs to be spelled out explicitly (e.g. "25 Jul – 24
 * Aug") rather than shown as a plain month name, since a plain month
 * name is misleading once the window doesn't line up with a calendar
 * month. */
export function isCustomCycle(settings: StoredSettings = getSettings()): boolean {
  return settings.budgetCycleMode === 'lastBusinessDay' || settings.budgetCycleStartDay > 1
}

export interface CycleConfig {
  mode: CycleMode
  startDay: number // meaningful only for 'fixedDay'
}

export function getCycleConfig(): CycleConfig {
  const s = getSettings()
  return { mode: s.budgetCycleMode, startDay: s.budgetCycleStartDay }
}

/** The last weekday (Mon–Fri) in the given month — genuinely moves
 * around month to month (the 29th, 30th, or 31st depending on both the
 * month's length and which weekday it ends on), unlike a fixed
 * day-of-month cycle. `month` is 0-indexed and can be passed outside
 * 0-11 (e.g. -1 or 12) — JS Date's own month-rollover handles stepping
 * into the adjacent year correctly. */
function lastBusinessDayOfMonth(year: number, month: number): Date {
  const d = new Date(year, month + 1, 0) // the last calendar day of the month
  while (d.getDay() === 0 || d.getDay() === 6) { // Sun = 0, Sat = 6
    d.setDate(d.getDate() - 1)
  }
  return d
}

/** The calendar date the cycle boundary falls on for the given
 * (year, month), under the given config. For 'fixedDay', clamped to
 * that month's real last day — so a startDay of 31 means "the last day
 * of the month" for a 30-day month rather than silently rolling into
 * the next month, which is what native Date rollover would otherwise
 * do with `new Date(year, month, 31)` on a 30-day month. */
function cycleBoundaryDate(year: number, month: number, config: CycleConfig): Date {
  if (config.mode === 'lastBusinessDay') {
    return lastBusinessDayOfMonth(year, month)
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(config.startDay, daysInMonth))
}

export interface Period {
  start: Date
  end: Date
}

/** The budget period containing referenceDate, given the configured
 * cycle. Accepts either a full CycleConfig, or (for backwards
 * compatibility with the simpler fixed-day-only call sites) a plain
 * startDay number. */
export function periodContaining(referenceDate: Date, config: CycleConfig | number = getCycleConfig()): Period {
  const resolved: CycleConfig = typeof config === 'number' ? { mode: 'fixedDay', startDay: config } : config

  if (resolved.mode === 'fixedDay' && resolved.startDay <= 1) {
    const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1)
    const end = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 1)
    return { start, end }
  }

  let periodStart = cycleBoundaryDate(referenceDate.getFullYear(), referenceDate.getMonth(), resolved)
  if (referenceDate < periodStart) {
    periodStart = cycleBoundaryDate(referenceDate.getFullYear(), referenceDate.getMonth() - 1, resolved)
  }
  const periodEnd = cycleBoundaryDate(periodStart.getFullYear(), periodStart.getMonth() + 1, resolved)
  return { start: periodStart, end: periodEnd }
}

export function isInSamePeriod(date: Date, referenceDate: Date = new Date(), config: CycleConfig | number = getCycleConfig()): boolean {
  const period = periodContaining(referenceDate, config)
  return date >= period.start && date < period.end
}

/** The period `offset` cycles before (negative) or after (positive) the one containing referenceDate. */
export function periodOffsetBy(offset: number, referenceDate: Date = new Date(), config: CycleConfig | number = getCycleConfig()): Period {
  const current = periodContaining(referenceDate, config)
  // Stepping by calendar months off the current period's OWN start
  // date (not a fixed day number) is what makes this correct for
  // 'lastBusinessDay' too — cycleBoundaryDate inside periodContaining
  // re-resolves the actual boundary for whichever month this lands in,
  // rather than assuming the same day-of-month applies every month.
  const shiftedRef = new Date(current.start.getFullYear(), current.start.getMonth() + offset, current.start.getDate())
  return periodContaining(shiftedRef, config)
}

export function referenceDateOffsetBy(offset: number, referenceDate: Date = new Date(), config: CycleConfig | number = getCycleConfig()): Date {
  const target = periodOffsetBy(offset, referenceDate, config)
  return new Date(target.start.getTime() + 24 * 60 * 60 * 1000)
}

export function daysRemainingInPeriod(referenceDate: Date = new Date(), config: CycleConfig | number = getCycleConfig()): number {
  const period = periodContaining(referenceDate, config)
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate())
  const periodEndDay = new Date(period.end.getFullYear(), period.end.getMonth(), period.end.getDate())
  const days = Math.round((periodEndDay.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
  return Math.max(1, days)
}
