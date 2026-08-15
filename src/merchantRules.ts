/**
 * Learns "this merchant → this category" from past categorizations, so
 * typing a note you've used before auto-suggests the right category.
 * Deliberately excludes Beem — see the matching exclusion in
 * duplicates.ts for the full reasoning: Beem payments normalize to a
 * near-identical generic key regardless of what they're actually for, so
 * learning from one would incorrectly bias every future one.
 */

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

export function suggestCategoryId(note: string): string | null {
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

  return null
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
