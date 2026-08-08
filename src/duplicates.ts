import type { Transaction } from './types'

export interface PotentialDuplicateGroup {
  id: string
  transactions: Transaction[]
  hasSharedToken: boolean
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
 * false-positive pattern. */
interface DuplicateCandidate {
  amount: number
  isExpense: boolean
  date: string
  note: string
}

export function isLikelyDuplicate(a: DuplicateCandidate, b: DuplicateCandidate, windowDays = 3): boolean {
  if (Math.abs(a.amount - b.amount) >= 0.01) return false
  if (a.isExpense !== b.isExpense) return false

  const dayDiffMs = Math.abs(new Date(a.date).getTime() - new Date(b.date).getTime())
  const sameDay = new Date(a.date).toDateString() === new Date(b.date).toDateString()
  if (sameDay) return true

  const withinWindow = dayDiffMs <= windowDays * 24 * 60 * 60 * 1000
  if (!withinWindow) return false

  const sharesToken = !isDisjoint(significantTokens(a.note), significantTokens(b.note))
  return sharesToken
}

export function findDuplicates(transactions: Transaction[], windowDays = 3): PotentialDuplicateGroup[] {
  const sorted = [...transactions].sort((a, b) => (a.amount !== b.amount ? a.amount - b.amount : a.date.localeCompare(b.date)))
  const used = new Set<string>()
  const groups: { transactions: Transaction[]; hasSharedToken: boolean }[] = []

  for (let i = 0; i < sorted.length; i++) {
    const anchor = sorted[i]
    if (used.has(anchor.id)) continue
    const anchorTokens = significantTokens(anchor.note)
    const cluster = [anchor]
    let hasSharedToken = false

    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j]
      if (used.has(candidate.id)) continue
      if (Math.abs(candidate.amount - anchor.amount) >= 0.01) break
      if (!isLikelyDuplicate(anchor, candidate, windowDays)) continue

      const sharesToken = !isDisjoint(anchorTokens, significantTokens(candidate.note))
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

/** Explicitly excludes Beem, even though it's already a stop word, since other tokens
 * (like a sender's name) can still coincidentally match unrelated Beem payments. */
/** Tokens that show up across many genuinely different merchants aren't
 * merchant-identifying — most commonly a shared suburb or street name
 * (e.g. "CANLEY HEIGHT" appearing in several unrelated businesses'
 * addresses). A fixed stop-word list can't anticipate every location
 * name, so this derives it from the data instead: a token used across
 * several distinct notes is treated as generic and ignored for
 * similarity matching, keeping only the words that actually identify
 * one specific merchant. */
function genericTokens(transactions: Transaction[]): Set<string> {
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
