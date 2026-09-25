/**
 * Learns "this merchant → this category" from past categorizations, so
 * typing a note you've used before auto-suggests the right category.
 * Deliberately excludes Beem — see the matching exclusion in
 * duplicates.ts for the full reasoning: Beem payments normalize to a
 * near-identical generic key regardless of what they're actually for, so
 * learning from one would incorrectly bias every future one.
 */

import type { Category } from './types'

export function normalizeMerchantKey(note: string): string {
  let key = note.toLowerCase().trim()
  key = key.replace(/^eftpos\s+/, '')
  key = key.replace(/\b\d+\b/g, ' ') // strip pure digit sequences (reference numbers)
  key = key.replace(/[^a-z\s]/g, ' ') // strip punctuation/backslashes/hex fragments
  key = key.replace(/\s+/g, ' ').trim()
  const words = key.split(' ').filter(Boolean).slice(0, 3)
  return words.join(' ')
}

const MERCHANT_RULES_KEY = 'budget-tracker-merchant-rules'

interface MerchantRule {
  key: string
  categoryId: string // most-used category — kept for backwards compatibility with existing stored rules and CSV/backup export
  counts: Record<string, number> // categoryId -> number of times used, so a suggestion reflects the most common choice, not just the most recent one
}

function readRules(): MerchantRule[] {
  try {
    const raw = localStorage.getItem(MERCHANT_RULES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as MerchantRule[]
    // Migrate any rule saved before frequency-counting existed — treat
    // its single prior categoryId as one observed count, rather than
    // discarding it.
    return parsed.map((r) => r.counts ? r : { ...r, counts: { [r.categoryId]: 1 } })
  } catch {
    return []
  }
}

function writeRules(rules: MerchantRule[]) {
  localStorage.setItem(MERCHANT_RULES_KEY, JSON.stringify(rules))
}

function topCategory(counts: Record<string, number>): string {
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
}

export function learnMerchant(note: string, categoryId: string | null) {
  if (!categoryId) return
  if (/beem/i.test(note)) return
  const key = normalizeMerchantKey(note)
  if (!key) return

  const rules = readRules()
  const existing = rules.find((r) => r.key === key)
  if (existing) {
    existing.counts[categoryId] = (existing.counts[categoryId] ?? 0) + 1
    existing.categoryId = topCategory(existing.counts)
  } else {
    rules.push({ key, categoryId, counts: { [categoryId]: 1 } })
  }
  writeRules(rules)
}

/** Directly pins a keyword to a category from the Learned Merchants
 * screen, rather than waiting for it to emerge from behavior. Given a
 * starting weight of 3 (vs. 1 for an ordinary observed categorization)
 * so it takes a few genuinely contrary categorizations to shift away
 * from what was deliberately set, without making it literally
 * unchangeable — the app should still adapt if a merchant's actual
 * category changes for you over time. */
export function pinManualRule(note: string, categoryId: string) {
  const key = normalizeMerchantKey(note)
  if (!key) return
  const rules = readRules()
  const existing = rules.find((r) => r.key === key)
  if (existing) {
    existing.counts[categoryId] = Math.max(existing.counts[categoryId] ?? 0, 3)
    existing.categoryId = topCategory(existing.counts)
  } else {
    rules.push({ key, categoryId, counts: { [categoryId]: 3 } })
  }
  writeRules(rules)
}

/** Plain Levenshtein edit distance, capped early once it's clearly past
 * `max` — this only ever runs over a short list of 1-3-word merchant
 * keys, so there's no need for a fancier algorithm. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const dp: number[] = Array(b.length + 1).fill(0).map((_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]
    dp[0] = i
    let rowMin = dp[0]
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = temp
      rowMin = Math.min(rowMin, dp[j])
    }
    if (rowMin > max) return max + 1
  }
  return dp[b.length]
}

/** A small, deliberately conservative set of common Australian
 * merchant/keyword → category hints, used only as a last-resort
 * fallback when nothing has been learned yet for a note. This is what
 * makes categorization useful from the very first import, rather than
 * needing to manually correct the same handful of obvious merchants
 * (Woolworths, Uber, Netflix...) before the app starts helping. Deliberately
 * short and high-confidence — a wrong seed guess is worse than no guess,
 * since it's silently applied rather than flagged, so this only includes
 * brand names that are essentially unambiguous. Always overridden by
 * anything actually learned from your own behavior. */
const SEED_RULES: { pattern: RegExp; categoryName: string }[] = [
  { pattern: /\b(woolworths|coles|aldi|iga\b|foodland|harris farm|farmers market)\b/i, categoryName: 'Groceries' },
  { pattern: /\b(mcdonalds|kfc|hungry jacks|subway|uber\s*eats|menulog|doordash|deliveroo|guzman|grill'?d|nandos|dominos|pizza hut|starbucks|gloria jean|boost juice|zambrero)\b/i, categoryName: 'Dining Out' },
  { pattern: /\b(uber(?!\s*eats)|opal|myki|go\s*card|translink|13cabs|didi|ola\b|bp\b|shell|caltex|ampol|linkt|e-?toll|nrma|parking)\b/i, categoryName: 'Transport' },
  { pattern: /\b(agl|origin energy|energyaustralia|red energy|telstra|optus|vodafone|tpg|iinet|belong|aussie broadband|sydney water|internet|electricity)\b/i, categoryName: 'Utilities' },
  { pattern: /\b(netflix|spotify|disney\+?|stan\b|binge|amazon prime|kayo|youtube premium|apple music|hoyts|event cinemas|village cinemas)\b/i, categoryName: 'Entertainment' },
  { pattern: /\b(amazon(?!\s*prime)|ebay|kmart|target|big\s*w|jb hi-?fi|officeworks|bunnings|myer|david jones|ikea)\b/i, categoryName: 'Shopping' },
  { pattern: /\b(chemist warehouse|priceline|pharmacy|medicare|bupa|medibank|\bhcf\b|dentist|physio)\b/i, categoryName: 'Health' },
  { pattern: /\b(rent|real estate|property management)\b/i, categoryName: 'Rent' }
]

function suggestFromSeedRules(note: string, categories: Category[]): string | null {
  for (const rule of SEED_RULES) {
    if (!rule.pattern.test(note)) continue
    const match = categories.find((c) => c.name.toLowerCase() === rule.categoryName.toLowerCase())
    if (match) return match.id
  }
  return null
}

/** Last-resort fallback: the note literally names the category ("for
 * groceries", "rent", "dining out") rather than a specific merchant.
 * Matches as whole words in either direction — "groceries" matches
 * "Groceries" exactly, "dining" matches "Dining Out" as a word within
 * it — so a plural/partial phrasing still counts, without matching on
 * a loose substring that could false-positive (e.g. "rent" inside
 * "parent" or "different"). */
function suggestFromCategoryNames(note: string, categories: Category[]): string | null {
  const noteLower = note.toLowerCase()
  if (noteLower.length < 3) return null // too short to be a meaningful word match either direction
  for (const c of categories) {
    const nameLower = c.name.toLowerCase()
    const nameInNote = new RegExp(`\\b${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(noteLower)
    const noteInName = new RegExp(`\\b${noteLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(nameLower)
    if (nameInNote || noteInName) return c.id
  }
  return null
}

export function suggestCategoryId(note: string, categories: Category[] = []): string | null {
  if (!note.trim() || /beem/i.test(note)) return null
  const key = normalizeMerchantKey(note)
  if (!key) return null

  const rules = readRules()
  const exact = rules.find((r) => r.key === key)
  if (exact) return exact.categoryId

  const partial = rules.find((r) => key.includes(r.key) || r.key.includes(key))
  if (partial) return partial.categoryId

  // Different branches of the same chain (confirmed a real gap: e.g.
  // "WOOLWORTHS FAIRFIELD WEST" vs "WOOLWORTHS BURWOOD" share no exact
  // or substring match, since the key captures the varying suburb name
  // alongside the brand). The first word is the most reliable
  // brand-identifying token — everything after it is typically location
  // — so falling back to matching on it alone catches this case,
  // without the false-positive risk of matching on any shared word.
  const firstWord = key.split(' ')[0]
  if (firstWord.length >= 4) {
    const brandMatch = rules.find((r) => r.key.split(' ')[0] === firstWord)
    if (brandMatch) return brandMatch.categoryId
  }

  // Near-miss on a learned key — catches OCR/typo noise ("Woolwoths",
  // "Woolworth's") that the exact/substring/brand-word checks above all
  // require clean text for. Threshold scales with key length so short
  // keys (where one swapped letter changes the meaning, e.g. "aldi" vs
  // "aldo") stay strict, while longer keys tolerate more noise.
  let bestFuzzy: { rule: MerchantRule; distance: number } | null = null
  for (const rule of rules) {
    const maxDistance = key.length <= 4 ? 0 : key.length <= 8 ? 1 : 2
    if (maxDistance === 0) continue
    const distance = editDistance(key, rule.key, maxDistance)
    if (distance <= maxDistance && (!bestFuzzy || distance < bestFuzzy.distance)) {
      bestFuzzy = { rule, distance }
    }
  }
  if (bestFuzzy) return bestFuzzy.rule.categoryId

  // Nothing learned yet for this note — fall back to the built-in
  // common-merchant hints so categorization still does something useful
  // before you've corrected anything.
  const seedMatch = suggestFromSeedRules(note, categories)
  if (seedMatch) return seedMatch

  // Still nothing — last resort, does the note just say the category
  // name itself ("groceries", "for rent")?
  return suggestFromCategoryNames(note, categories)
}

export function getAllMerchantRules(): MerchantRule[] {
  return readRules()
}

export function deleteMerchantRule(key: string) {
  writeRules(readRules().filter((r) => r.key !== key))
}

/** Called when a category is deleted without merging — any learned
 * rule pointing at it would otherwise keep suggesting a category that
 * no longer exists. Rules with no remaining categories after removal
 * are dropped entirely; others keep their remaining counts and
 * recompute their top suggestion. */
export function removeCategoryFromMerchantRules(categoryId: string) {
  const rules = readRules()
  const updated = rules
    .map((r) => {
      if (!(categoryId in r.counts)) return r
      const { [categoryId]: _removed, ...rest } = r.counts
      return { ...r, counts: rest }
    })
    .filter((r) => Object.keys(r.counts).length > 0)
    .map((r) => ({ ...r, categoryId: topCategory(r.counts) }))
  writeRules(updated)
}

/** Called when a category is merged into another — reassigns its
 * learned counts to the target category instead of discarding them,
 * matching what "merge" means for transactions: combine, don't lose. */
export function mergeCategoryInMerchantRules(sourceId: string, targetId: string) {
  const rules = readRules()
  const updated = rules
    .map((r) => {
      if (!(sourceId in r.counts)) return r
      const sourceCount = r.counts[sourceId]
      const { [sourceId]: _removed, ...rest } = r.counts
      rest[targetId] = (rest[targetId] ?? 0) + sourceCount
      return { ...r, counts: rest }
    })
    .map((r) => ({ ...r, categoryId: topCategory(r.counts) }))
  writeRules(updated)
}
