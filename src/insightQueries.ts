/** Answers to a small, fixed set of common questions — "how much have
 * I spent," "how much on X category," "how much on this trip," "this
 * period vs last," "what changed the most" — computed directly, the
 * same way an AI-based version of this was built and tested earlier,
 * minus the AI: every one of these questions turned out to be a fixed,
 * small set once actually looked at, and picking a category or tag
 * from a real list removes the one genuine source of ambiguity a
 * freeform version had ("this trip" meaning which trip, exactly) more
 * completely than any amount of language understanding could — there's
 * nothing left to guess once the person has tapped the specific thing
 * they mean.
 */
import type { Category, Transaction, Account, RecurringTransaction } from './types'
import { computeDashboardTotals, netSpentForCategory, effectiveBudget, reimbursementBreakdown, formatCurrency, accountBalance, topMerchantsThisMonth, type MerchantTotal } from './calculations'
import { referenceDateOffsetBy } from './budgetPeriod'
import { normalizeMerchantKey } from './merchantRules'

export interface Answer {
  text: string
  sentiment: 'positive' | 'warning' | 'neutral'
}

export function spentThisPeriod(categories: Category[], transactions: Transaction[], accounts: Account[], recurring: RecurringTransaction[], referenceDate: Date): Answer {
  const dash = computeDashboardTotals(categories, transactions, referenceDate, recurring, accounts)
  return { text: `You've spent ${formatCurrency(dash.spent)} this period.`, sentiment: 'neutral' }
}

export function spentByCategory(category: Category, categories: Category[], transactions: Transaction[], referenceDate: Date): Answer {
  const spent = Math.max(0, netSpentForCategory(category, categories, transactions, referenceDate))
  const budget = effectiveBudget(category, categories)
  if (budget <= 0) {
    return { text: `${category.icon} ${category.name}: ${formatCurrency(spent)} this period.`, sentiment: 'neutral' }
  }
  const over = spent > budget
  const budgetPart = over ? `over by ${formatCurrency(spent - budget)}` : `${formatCurrency(budget - spent)} left`
  return {
    text: `${category.icon} ${category.name}: ${formatCurrency(spent)} this period (budget: ${formatCurrency(budget)}, ${budgetPart}).`,
    sentiment: over ? 'warning' : 'positive'
  }
}

export function spentByTag(tag: string, transactions: Transaction[]): Answer {
  const taggedExpenses = transactions.filter((t) => t.isExpense && t.tags.some((tg) => tg.toLowerCase() === tag.toLowerCase()))
  const breakdown = reimbursementBreakdown(taggedExpenses, transactions)
  const parts: string[] = []
  if (breakdown.fundedFromSavings > 0.01) parts.push(`${formatCurrency(breakdown.fundedFromSavings)} from savings`)
  if (breakdown.reimbursedByOthers > 0.01) parts.push(`${formatCurrency(breakdown.reimbursedByOthers)} paid back by others`)
  const breakdownText = parts.length > 0 ? ` — ${formatCurrency(breakdown.outOfPocket)} out of pocket, ${parts.join(', ')}` : ''
  return { text: `"${tag}" cost ${formatCurrency(breakdown.totalCost)} in total${breakdownText}.`, sentiment: 'neutral' }
}

export function budgetComparison(categories: Category[], transactions: Transaction[], accounts: Account[], recurring: RecurringTransaction[], referenceDate: Date): Answer {
  const thisDash = computeDashboardTotals(categories, transactions, referenceDate, recurring, accounts)
  const lastDash = computeDashboardTotals(categories, transactions, referenceDateOffsetBy(-1, referenceDate), recurring, accounts)
  const delta = thisDash.spent - lastDash.spent
  const direction = delta > 0.01 ? 'more' : delta < -0.01 ? 'less' : 'about the same amount'
  const deltaPart = Math.abs(delta) > 0.01 ? ` — ${formatCurrency(Math.abs(delta))} ${direction} than last period` : ''
  return {
    text: `This period: ${formatCurrency(thisDash.spent)} spent. Last period: ${formatCurrency(lastDash.spent)} spent${deltaPart}.`,
    sentiment: delta > 0.01 ? 'warning' : delta < -0.01 ? 'positive' : 'neutral'
  }
}

export function biggestCategoryChange(categories: Category[], transactions: Transaction[], referenceDate: Date): Answer {
  const topLevel = categories.filter((c) => !c.parentId)
  let biggest: { category: Category; delta: number } | null = null
  for (const c of topLevel) {
    const thisSpent = Math.max(0, netSpentForCategory(c, categories, transactions, referenceDate))
    const lastSpent = Math.max(0, netSpentForCategory(c, categories, transactions, referenceDateOffsetBy(-1, referenceDate)))
    const delta = thisSpent - lastSpent
    if (!biggest || Math.abs(delta) > Math.abs(biggest.delta)) biggest = { category: c, delta }
  }
  if (!biggest || Math.abs(biggest.delta) < 0.01) {
    return { text: 'No category changed meaningfully compared to last period.', sentiment: 'neutral' }
  }
  const direction = biggest.delta > 0 ? 'increased' : 'decreased'
  return {
    text: `${biggest.category.icon} ${biggest.category.name} ${direction} the most — ${formatCurrency(Math.abs(biggest.delta))} compared to last period.`,
    sentiment: biggest.delta > 0 ? 'warning' : 'positive'
  }
}

export interface MerchantInsight {
  merchants: MerchantTotal[]
}

/** A thin wrapper, not new logic — topMerchantsThisMonth already
 * exists and already handles the real, confirmed edge cases (grouping
 * "WOOLWORTHS FAIRFIELD" and "WOOLWORTHS BURWOOD" as one Woolworths,
 * keeping Beem's payment-description notes ungrouped since they aren't
 * merchant names). Reusing it here rather than writing a second,
 * slightly-different version that could quietly drift from the first. */
export function topMerchants(transactions: Transaction[], referenceDate: Date, limit = 5): MerchantInsight {
  return { merchants: topMerchantsThisMonth(transactions, referenceDate, limit) }
}

/** Needs vs wants, as a share of what was actually SPENT this period
 * (not of income, which is what Month Recap's own needsPct/wantsPct
 * already answer, a different and equally valid question — "how much
 * of my spending was discretionary" is a distinct thing from "how much
 * of my income went to discretionary spending", and this is
 * deliberately the more commonly-expected framing for a standalone
 * insight rather than reusing Month Recap's income-relative version,
 * which also pulls in a full recap's worth of goal/suggestion
 * computation this doesn't need. */
export function needsWantsSplit(categories: Category[], transactions: Transaction[], referenceDate: Date): Answer {
  const topLevel = categories.filter((c) => !c.parentId)
  function splitFor(refDate: Date) {
    let needs = 0
    let wants = 0
    for (const c of topLevel) {
      const spent = Math.max(0, netSpentForCategory(c, categories, transactions, refDate))
      if (c.needWantType === 'need') needs += spent
      else if (c.needWantType === 'want') wants += spent
    }
    return { needs, wants }
  }
  const thisPeriod = splitFor(referenceDate)
  const total = thisPeriod.needs + thisPeriod.wants
  if (total <= 0.01) return { text: 'Not enough categorized spending yet this period to show a needs/wants split.', sentiment: 'neutral' }

  const needsPct = Math.round((thisPeriod.needs / total) * 100)
  const wantsPct = 100 - needsPct

  const lastPeriod = splitFor(referenceDateOffsetBy(-1, referenceDate))
  const lastTotal = lastPeriod.needs + lastPeriod.wants
  let trendPart = ''
  if (lastTotal > 0.01) {
    const lastWantsPct = Math.round((lastPeriod.wants / lastTotal) * 100)
    const diff = wantsPct - lastWantsPct
    if (Math.abs(diff) >= 3) {
      trendPart = diff > 0 ? ` — wants are up ${diff} points from last period` : ` — wants are down ${Math.abs(diff)} points from last period`
    }
  }

  return {
    text: `${needsPct}% needs / ${wantsPct}% wants this period${trendPart}.`,
    sentiment: wantsPct > 60 ? 'warning' : 'neutral'
  }
}

/** All accounts combined into one figure — credit card balances
 * subtracted rather than added, since accountBalance deliberately
 * returns a credit card's balance as a positive "amount owed" (see its
 * own comments), which is correct for showing a card's own balance but
 * would be silently wrong here, inflating net worth by the exact
 * amount actually owed on it. */
export function netWorth(accounts: Account[], transactions: Transaction[]): Answer {
  let total = 0
  for (const a of accounts) {
    const balance = accountBalance(a, transactions)
    total += a.type === 'credit_card' ? -balance : balance
  }
  return {
    text: `Net worth across all accounts: ${formatCurrency(total)}.`,
    sentiment: total >= 0 ? 'positive' : 'warning'
  }
}

export interface CreepItem {
  recurringNote: string
  previousAmount: number
  currentAmount: number
}

/** Flags a recurring item whose configured amount no longer matches
 * what it last actually charged — the common "subscription creep"
 * pattern (a streaming service quietly going from $16.99 to $19.99)
 * that's easy to miss since each individual charge still looks
 * unremarkable on its own. There's no explicit link from a generated
 * transaction back to the recurring item that created it (installments
 * have installmentPlanId for exactly this; recurring items don't), so
 * this matches historical transactions the same way the app already
 * does elsewhere (matchingRecurringItem) — by normalized note plus
 * expense direction — rather than inventing a second, different
 * matching rule that could disagree with the first. Compares against
 * the single most recent matching transaction, not an average, since
 * an average would blur together a genuine price rise with ordinary
 * variation (a coffee subscription with an occasional add-on, say). */
export function subscriptionCreep(recurring: RecurringTransaction[], transactions: Transaction[]): CreepItem[] {
  const results: CreepItem[] = []
  for (const r of recurring) {
    if (!r.isActive || !r.note.trim()) continue
    const key = normalizeMerchantKey(r.note)
    if (!key) continue
    const matches = transactions
      .filter((t) => t.isExpense === r.isExpense && normalizeMerchantKey(t.note) === key)
      .sort((a, b) => b.date.localeCompare(a.date))
    const mostRecent = matches[0]
    if (!mostRecent) continue
    if (Math.abs(mostRecent.amount - r.amount) < 0.01) continue
    results.push({ recurringNote: r.note, previousAmount: mostRecent.amount, currentAmount: r.amount })
  }
  return results
}
