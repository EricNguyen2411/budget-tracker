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

export function findDuplicates(transactions: Transaction[], windowDays = 3): PotentialDuplicateGroup[] {
  const sorted = [...transactions].sort((a, b) => (a.amount !== b.amount ? a.amount - b.amount : a.date.localeCompare(b.date)))
  const windowMs = windowDays * 24 * 60 * 60 * 1000
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
      if (candidate.isExpense !== anchor.isExpense) continue
      if (Math.abs(new Date(candidate.date).getTime() - new Date(anchor.date).getTime()) > windowMs) continue

      const candidateTokens = significantTokens(candidate.note)
      const sharesToken = !isDisjoint(anchorTokens, candidateTokens)
      const sameDay = new Date(candidate.date).toDateString() === new Date(anchor.date).toDateString()
      if (!sharesToken && !sameDay) continue

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
export function transactionsWithSimilarName(note: string, categoryId: string, excludingId: string | null, transactions: Transaction[]): Transaction[] {
  if (/beem/i.test(note)) return []
  const targetTokens = significantTokens(note)
  if (targetTokens.size === 0) return []

  return transactions.filter((candidate) => {
    if (candidate.id === excludingId) return false
    if (candidate.categoryId === categoryId) return false
    if (/beem/i.test(candidate.note)) return false
    return !isDisjoint(targetTokens, significantTokens(candidate.note))
  })
}
