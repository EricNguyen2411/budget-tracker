const IMPORT_MAPPING_KEY = 'budget-tracker-import-account-mapping'

export type ImportSource = 'nab' | 'westpac' | 'beem'

export interface ImportAccountMapping {
  nab: string | null
  westpac: string | null
  beem: string | null
}

const DEFAULT_MAPPING: ImportAccountMapping = {
  nab: null,
  westpac: null,
  beem: null
}

export function getImportAccountMapping(): ImportAccountMapping {
  try {
    const raw = localStorage.getItem(IMPORT_MAPPING_KEY)
    if (!raw) return { ...DEFAULT_MAPPING }
    return { ...DEFAULT_MAPPING, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_MAPPING }
  }
}

export function saveImportAccountMapping(mapping: ImportAccountMapping) {
  localStorage.setItem(IMPORT_MAPPING_KEY, JSON.stringify(mapping))
}

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  nab: 'NAB',
  westpac: 'Westpac',
  beem: 'Beem'
}

/** A best-effort guess at which bank a "generic banking app screenshot"
 * (the appScreenshot / notificationScreenshot formats, which don't
 * distinguish banks from each other the way the dedicated beemScreenshot
 * format does) actually came from, so the account picker on the import
 * review screen can start pre-selected on a sensible default instead of
 * blank. Deliberately just a starting point the person can freely
 * change, not something applied silently — guessing wrong here would
 * mean money silently landing against the wrong account's balance, so
 * the picker staying visible and editable matters more than the guess
 * being right every time.
 *
 * Checks specifically for "Westpac" appearing in the screenshot's OCR'd
 * text, falling back to NAB otherwise — not the other way around.
 * Confirmed directly against real screenshots from earlier in this
 * project: a real Westpac screenshot's own header literally reads
 * "Westpac Choice Basic", but a real NAB credit card screenshot's
 * header just says "Credit Card #6177" — the word "NAB" doesn't appear
 * anywhere in it. Checking for "NAB" and falling back to Westpac (the
 * initial, untested design) would have silently misdetected every real
 * NAB screenshot as Westpac. */
export function guessImportSource(format: 'appScreenshot' | 'notificationScreenshot' | 'beemScreenshot' | 'unknown', allText: string): ImportSource | null {
  if (format === 'beemScreenshot') return 'beem'
  if (format === 'unknown') return null
  const lower = allText.toLowerCase()
  if (lower.includes('westpac')) return 'westpac'
  return 'nab'
}
