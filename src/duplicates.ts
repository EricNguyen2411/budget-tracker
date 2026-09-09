import type { Transaction } from './types'

export interface PotentialDuplicateGroup {
  id: string
  transactions: Transaction[]
  hasSharedToken: boolean
}

// Shared with healthCheck.ts's stale-transit-fare detection — kept in
// one place after confirming this exact keyword list once already
// silently failed to match the real-world "Transport NSW (Contactless)"
// format because it lived in two separate copies that had drifted.
export const TRANSIT_FARE_KEYWORDS = ['opal', 'transport nsw', 'transportfornsw', 'transport for nsw', 'tfnsw']

/** A flat-fee transit tap (Opal/Transport NSW confirmed as the real
 * case) legitimately recurs multiple times a DAY — a normal commute is
 * two taps minimum, more with transfers — and every occurrence carries
 * the exact same note text, since there's no trip-specific detail in
 * it. Confirmed directly this makes ordinary same-day commuting look
 * like duplicate transactions to the matcher below: two genuinely
 * separate $1.00 taps, hours apart, with identical notes, are
 * indistinguishable from a true duplicate by amount or by text alone.
 * Excluded from duplicate detection entirely instead of trying to
 * out-clever it with a smaller time window, since imported/manual
 * transactions in this app don't reliably carry a real time-of-day to
 * split same-day taps apart by anyway. No amount check here — both the
 * $1.00 pending hold AND whatever the trip's real finalized fare turns
 * out to be can equally recur several times a day, so restricting this
 * to only very small amounts would miss the settled-fare case. */
export function isLikelyTransitFare(note: string): boolean {
  const lower = note.toLowerCase()
  return TRANSIT_FARE_KEYWORDS.some((k) => lower.includes(k))
}

const STOP_WORDS = new Set([
  'eftpos', 'debit', 'credit', 'purchase', 'card', 'payment', 'payments',
  'transaction', 'transfer', 'deposit', 'deposits', 'withdrawal', 'osko',
  'visa', 'mastercard', 'pty', 'ltd', 'aus', 'australia', 'the', 'and',
  'beem', 'be', 'online', 'mobile', 'tfr', 'at', 'of', 'on', 'for'
])

export function significantTokens(note: string): Set<string> {
  const tokens = note.toLowerCase().split(/[^a-z0-9]+/)
  return new Set(tokens.filter((t) => t.length >= 3 && !STOP_WORDS.has(t)))
}

function isDisjoint(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return false
  return true
}

/** Whether two transactions look like the same real-world event —
 * requires an exact same day, OR a shared significant name token AND
 * being within a reasonable date window. A name match alone is NOT
 * enough on its own: two purchases at the same cafe three months apart
 * are legitimately different transactions, not duplicates, and treating
 * name-match as sufficient regardless of date produced exactly that
 * false-positive pattern. The optional `generic` set filters out tokens
 * that show up across many different merchants (most often a shared
 * suburb name) — without it, two unrelated businesses in the same
 * suburb with a coincidentally matching amount could be flagged as
 * duplicates purely from sharing a location word. */
interface DuplicateCandidate {
  amount: number
  isExpense: boolean
  date: string
  note: string
}

export function isLikelyDuplicate(a: DuplicateCandidate, b: DuplicateCandidate, windowDays = 3, generic: Set<string> = new Set()): boolean {
  if (Math.abs(a.amount - b.amount) >= 0.01) return false
  if (a.isExpense !== b.isExpense) return false

  const dayDiffMs = Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime())
  const sameDay = new Date(a.date).toDateString() === new Date(b.date).toDateString()
  if (sameDay) return true

  const withinWindow = dayDiffMs <= windowDays * 24 * 60 * 60 * 1000
  if (!withinWindow) return false

  const aTokens = new Set([...significantTokens(a.note)].filter((t) => !generic.has(t)))
  const bTokens = new Set([...significantTokens(b.note)].filter((t) => !generic.has(t)))
  return !isDisjoint(aTokens, bTokens)
}

export function findDuplicates(transactions: Transaction[], windowDays = 3): PotentialDuplicateGroup[] {
  const generic = genericTokens(transactions)
  const sorted = [...transactions]
    .filter((t) => !isLikelyTransitFare(t.note))
    .sort((a, b) => (a.amount !== b.amount ? a.amount - b.amount : a.date.localeCompare(b.date)))
  const used = new Set<string>()
  const groups: { transactions: Transaction[]; hasSharedToken: boolean }[] = []

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i]
    if (used.has(anchor.id)) continue
    const anchorTokens = new Set([...significantTokens(anchor.note)].filter((t) => !generic.has(t)))
    const cluster = [anchor]
    let hasSharedToken = false

    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j]
      if (used.has(candidate.id)) continue
      if (Math.abs(candidate.amount - anchor.amount) >= 0.01) break
      if (!isLikelyDuplicate(anchor, candidate, windowDays, generic)) continue

      const candidateTokens = new Set([...significantTokens(candidate.note)].filter((t) => !generic.has(t)))
      const sharesToken = !isDisjoint(anchorTokens, candidateTokens)
      cluster.push(candidate)
      if (sharesToken) hasSharedToken = true
    }

    if (cluster.length > 1) {
      cluster.forEach((t) => used.add(t.id))
      groups.push({ transactions: cluster.sort((a, b) => a.date.localeCompare(b.date)), hasSharedToken })
    }
  }

  return groups
    .map((g, i) => ({ id: `dup-${i}`, ...g }))
    .sort((a, b) => b.transactions[0].date.localeCompare(a.transactions[0].date))
}

/** Tokens that show up across many genuinely different merchants aren't
 * merchant-identifying — most commonly a shared suburb or street name
 * (e.g. "CANLEY HEIGHT" appearing in several unrelated businesses'
 * addresses). A fixed stop-word list can't anticipate every location
 * name, so this derives it from the data instead: a token used across
 * several distinct notes is treated as generic and ignored for
 * similarity matching, keeping only the words that actually identify
 * one specific merchant. */
export function genericTokens(transactions: Transaction[]): Set<string> {
  const tokenToNotes = new Map<string, Set<string>>()
  for (const t of transactions) {
    const noteKey = t.note.trim().toLowerCase()
    if (!noteKey) continue
    for (const token of significantTokens(t.note)) {
      if (!tokenToNotes.has(token)) tokenToNotes.set(token, new Set())
      tokenToNotes.get(token)!.add(noteKey)
    }
  }
  const generic = new Set<string>()
  for (const [token, notes] of tokenToNotes) {
    if (notes.size >= 4) generic.add(token)
  }
  return generic
}

export function transactionsWithSimilarName(note: string, categoryId: string, excludingId: string | null, transactions: Transaction[]): Transaction[] {
  if (/beem/i.test(note)) return []
  const generic = genericTokens(transactions)
  const targetTokens = new Set([...significantTokens(note)].filter((t) => !generic.has(t)))
  if (targetTokens.size === 0) return []

  return transactions.filter((candidate) => {
    if (candidate.id === excludingId) return false
    if (candidate.categoryId === categoryId) return false
    if (/beem/i.test(candidate.note)) return false
    const candidateTokens = new Set([...significantTokens(candidate.note)].filter((t) => !generic.has(t)))
    return !isDisjoint(targetTokens, candidateTokens)
  })
}
