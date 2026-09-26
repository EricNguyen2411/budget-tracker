/** A payday routine — the accounts someone routinely moves money to the
 * moment a payslip lands (savings, paying down a credit card), and how
 * much they sent last time, so the next prompt starts pre-filled
 * instead of asking from scratch every payday. Deliberately just a
 * remembered list, not a rigid fixed/percentage rule — real amounts
 * vary paycheck to paycheck, and a number that's easy to adjust in the
 * moment is more honest than one that pretends to be automatic. */

const TARGETS_KEY = 'budget-tracker-payday-targets'

export interface PaydayTarget {
  accountId: string
  lastAmount: number
}

export function getPaydayTargets(): PaydayTarget[] {
  try {
    const raw = localStorage.getItem(TARGETS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeTargets(targets: PaydayTarget[]) {
  try {
    localStorage.setItem(TARGETS_KEY, JSON.stringify(targets))
  } catch {
    // Storage unavailable or full — not worth failing the save over.
  }
}

export function addPaydayTarget(accountId: string) {
  const current = getPaydayTargets()
  if (current.some((t) => t.accountId === accountId)) return
  writeTargets([...current, { accountId, lastAmount: 0 }])
}

export function removePaydayTarget(accountId: string) {
  writeTargets(getPaydayTargets().filter((t) => t.accountId !== accountId))
}

/** Called after each round of transfers actually goes through — updates
 * what's pre-filled next time, per account, since different targets
 * often get genuinely different amounts (more to the credit card some
 * months, more to savings others). */
export function recordPaydayAmount(accountId: string, amount: number) {
  const current = getPaydayTargets()
  const existing = current.find((t) => t.accountId === accountId)
  if (existing) existing.lastAmount = amount
  else current.push({ accountId, lastAmount: amount })
  writeTargets(current)
}
