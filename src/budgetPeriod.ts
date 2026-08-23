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

/** The calendar date the RULE (unadjusted by any override) predicts for
 * the cycle boundary in the given (year, month), under the given
 * config. For 'fixedDay', clamped to that month's real last day — so a
 * startDay of 31 means "the last day of the month" for a 30-day month
 * rather than silently rolling into the next month, which is what
 * native Date rollover would otherwise do with `new Date(year, month,
 * 31)` on a 30-day month. */
function cycleBoundaryDate(year: number, month: number, config: CycleConfig): Date {
  if (config.mode === 'lastBusinessDay') {
    return lastBusinessDayOfMonth(year, month)
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  return new Date(year, month, Math.min(config.startDay, daysInMonth))
}

// ---------- Per-cycle overrides ----------
//
// The rule (fixed day, or last business day) is a PREDICTION — real
// paydays sometimes land on a different date than predicted (paid a
// day early for a bank holiday, an irregular employer schedule, etc).
// Rather than requiring a new rule for every such quirk, a single
// cycle's actual start can be confirmed/corrected directly (offered
// when an income transaction's date doesn't match the prediction — see
// App.tsx) and remembered here, without changing the rule itself or
// any other cycle.
//
// Overrides are keyed by "bucket" (the YYYY-MM the RULE would have
// used for that cycle) rather than by the resulting date, so the key
// stays stable even after an override changes what date it points to.

const OVERRIDES_KEY = 'budget-tracker-cycle-overrides'

interface CycleOverride {
  bucketKey: string // YYYY-MM, the rule's own (unoverridden) bucket label
  actualStart: string // YYYY-MM-DD
}

function readOverrides(): CycleOverride[] {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function writeOverrides(list: CycleOverride[]) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(list))
}

function bucketKeyFor(year: number, month: number): string {
  // Routes through a real Date so a month outside 0-11 (from stepping
  // -1 or +offset elsewhere in this file) normalizes to the correct
  // adjacent year automatically, same as everywhere else in here.
  const d = new Date(year, month, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function getCycleOverrides(): CycleOverride[] {
  return readOverrides().sort((a, b) => b.bucketKey.localeCompare(a.bucketKey))
}

export function setCycleOverride(bucketKey: string, actualStart: string) {
  writeOverrides([...readOverrides().filter((o) => o.bucketKey !== bucketKey), { bucketKey, actualStart }])
}

export function clearCycleOverride(bucketKey: string) {
  writeOverrides(readOverrides().filter((o) => o.bucketKey !== bucketKey))
}

function parseLocalDateString(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** The actual resolved start of the given bucket — the confirmed
 * override if one's been set for it, otherwise the rule's own
 * prediction. This is the one place override-awareness lives; every
 * period calculation below is built from this. */
function resolveBucketStart(year: number, month: number, config: CycleConfig): Date {
  const predicted = cycleBoundaryDate(year, month, config)
  const override = readOverrides().find((o) => o.bucketKey === bucketKeyFor(year, month))
  return override ? parseLocalDateString(override.actualStart) : predicted
}

/** Which (year, month) bucket referenceDate falls into, under the
 * given config — i.e. whether it's on or after that bucket's resolved
 * start but before the next bucket's. Shared by periodContaining and
 * periodOffsetBy so both step through buckets exactly the same way. */
function resolveBucketFor(referenceDate: Date, config: CycleConfig): { bucketYear: number; bucketMonth: number } {
  const bucketYear = referenceDate.getFullYear()
  let bucketMonth = referenceDate.getMonth()
  const periodStart = resolveBucketStart(bucketYear, bucketMonth, config)
  if (referenceDate < periodStart) {
    bucketMonth -= 1
  }
  return { bucketYear, bucketMonth }
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

  const { bucketYear, bucketMonth } = resolveBucketFor(referenceDate, resolved)
  const start = resolveBucketStart(bucketYear, bucketMonth, resolved)
  const end = resolveBucketStart(bucketYear, bucketMonth + 1, resolved)
  return { start, end }
}

/** The bucket key and rule prediction for a boundary in referenceDate's
 * OWN calendar month — what to compare an actual date (like a payslip)
 * against to decide whether it's meant to BE that boundary. Note this
 * is deliberately NOT the same lookup as resolveBucketFor: that answers
 * "which already-in-progress cycle is referenceDate currently inside"
 * (backward-looking — Aug 15 belongs to the cycle that started in
 * July), which would give the wrong bucket to correct here. A payslip
 * dated Aug 28 is meant to correct AUGUST's boundary, not July's, even
 * though Aug 28 itself would currently be classified as still "inside"
 * July's ongoing cycle under the unoverridden rule. */
export function predictedCycleFor(referenceDate: Date, config: CycleConfig | number = getCycleConfig()): { bucketKey: string; predictedStart: Date } {
  const resolved: CycleConfig = typeof config === 'number' ? { mode: 'fixedDay', startDay: config } : config
  const year = referenceDate.getFullYear()
  const month = referenceDate.getMonth()
  return { bucketKey: bucketKeyFor(year, month), predictedStart: cycleBoundaryDate(year, month, resolved) }
}

export function isInSamePeriod(date: Date, referenceDate: Date = new Date(), config: CycleConfig | number = getCycleConfig()): boolean {
  const period = periodContaining(referenceDate, config)
  return date >= period.start && date < period.end
}

/** The period `offset` cycles before (negative) or after (positive) the one containing referenceDate. */
export function periodOffsetBy(offset: number, referenceDate: Date = new Date(), config: CycleConfig | number = getCycleConfig()): Period {
  const resolved: CycleConfig = typeof config === 'number' ? { mode: 'fixedDay', startDay: config } : config

  if (resolved.mode === 'fixedDay' && resolved.startDay <= 1) {
    const base = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + offset, 1)
    return periodContaining(base, resolved)
  }

  // Stepping the BUCKET coordinates by `offset` months (not the
  // resolved start date itself) is what keeps this correct once
  // overrides are in play — an override can land close to either edge
  // of its rule-predicted month, and re-deriving a reference date from
  // it risks miscounting which bucket that lands back in. Stepping the
  // bucket directly sidesteps that entirely.
  const { bucketYear, bucketMonth } = resolveBucketFor(referenceDate, resolved)
  const targetMonth = bucketMonth + offset
  const start = resolveBucketStart(bucketYear, targetMonth, resolved)
  const end = resolveBucketStart(bucketYear, targetMonth + 1, resolved)
  return { start, end }
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
