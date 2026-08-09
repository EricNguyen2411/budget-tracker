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
  categoryId: string
}

function readRules(): MerchantRule[] {
  try {
    const raw = localStorage.getItem(MERCHANT_RULES_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function writeRules(rules: MerchantRule[]) {
  localStorage.setItem(MERCHANT_RULES_KEY, JSON.stringify(rules))
}

export function learnMerchant(note: string, categoryId: string | null) {
  if (!categoryId) return
  if (/beem/i.test(note)) return
  const key = normalizeMerchantKey(note)
  if (!key) return

  const rules = readRules()
  const existing = rules.find((r) => r.key === key)
  if (existing) {
    existing.categoryId = categoryId
  } else {
    rules.push({ key, categoryId })
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
