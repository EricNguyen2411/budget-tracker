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
import { computeDashboardTotals, netSpentForCategory, effectiveBudget, reimbursementBreakdown, formatCurrency, netWorthTotal, topMerchantsThisMonth, isUnlinkedIncome, type MerchantTotal } from './calculations'
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
  const total = netWorthTotal(accounts, transactions)
  return {
    text: `Net worth across all accounts: ${formatCurrency(total)}.`,
    sentiment: total >= 0 ? 'positive' : 'warning'
  }
}

export interface CashFlowProjection {
  daysUntilPayday: number
  perDayAmount: number
  source: 'known' | 'estimated'
  paydayDate: string
}

/** "Will I make it to payday" — deliberately conservative about how it
 * finds the next payday, since a confidently-wrong date here is worse
 * than not showing this at all. Prefers a real, explicitly-configured
 * recurring income item (something the person themselves set up and
 * therefore actually knows the date of) over guessing from history.
 * Only falls back to inferring a pattern from past unlinked income
 * transactions — averaging the gaps between them, projecting one more
 * gap forward — when no such recurring item exists, and always labels
 * which one it used, since an estimate should never be presented with
 * the same confidence as a real, known date. Returns null rather than
 * a guess when there's truly nothing to go on (fewer than 2 historical
 * income transactions and no recurring income item) — an estimate from
 * one data point isn't a pattern, it's a coincidence. */
export function cashFlowProjection(categories: Category[], transactions: Transaction[], accounts: Account[], recurring: RecurringTransaction[], referenceDate: Date): CashFlowProjection | null {
  const dash = computeDashboardTotals(categories, transactions, referenceDate, recurring, accounts)
  const safeToSpend = Math.max(0, dash.safeToSpend)

  const knownIncome = recurring.find((r) => r.isActive && !r.isExpense)
  if (knownIncome) {
    const paydayDate = new Date(knownIncome.nextDueDate)
    const days = Math.max(1, Math.ceil((paydayDate.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24)))
    return { daysUntilPayday: days, perDayAmount: safeToSpend / days, source: 'known', paydayDate: knownIncome.nextDueDate }
  }

  const incomeHistory = transactions
    .filter((t) => isUnlinkedIncome(t) && t.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (incomeHistory.length < 2) return null

  const gaps: number[] = []
  for (let i = 1; i < incomeHistory.length; i++) {
    const gapDays = (new Date(incomeHistory[i].date).getTime() - new Date(incomeHistory[i - 1].date).getTime()) / (1000 * 60 * 60 * 24)
    if (gapDays > 0) gaps.push(gapDays)
  }
  if (gaps.length === 0) return null
  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length

  const lastIncomeDate = new Date(incomeHistory[incomeHistory.length - 1].date)
  // Projects forward by the average gap repeatedly, not just once —
  // confirmed via direct testing this was a real edge case: if the
  // most recent recorded income is old enough that one gap lands
  // before referenceDate (income hasn't been logged in a while, say),
  // a single-step projection would land in the past, and clamping the
  // day count to a minimum of 1 then made it look like payday was
  // "tomorrow" when it had actually already passed — misleading in
  // exactly the way an estimate can't afford to be.
  let projectedPayday = new Date(lastIncomeDate.getTime() + avgGap * 24 * 60 * 60 * 1000)
  let safety = 0
  while (projectedPayday.getTime() <= referenceDate.getTime() && safety < 1000) {
    projectedPayday = new Date(projectedPayday.getTime() + avgGap * 24 * 60 * 60 * 1000)
    safety++
  }
  const days = Math.max(1, Math.ceil((projectedPayday.getTime() - referenceDate.getTime()) / (1000 * 60 * 60 * 24)))
  return { daysUntilPayday: days, perDayAmount: safeToSpend / days, source: 'estimated', paydayDate: projectedPayday.toISOString() }
}

export function cashFlowAnswer(categories: Category[], transactions: Transaction[], accounts: Account[], recurring: RecurringTransaction[], referenceDate: Date): Answer | null {
  const projection = cashFlowProjection(categories, transactions, accounts, recurring, referenceDate)
  if (!projection) return null
  const dateLabel = new Date(projection.paydayDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
  const sourceNote = projection.source === 'estimated' ? ' (estimated from your past income pattern)' : ''
  return {
    text: `${formatCurrency(projection.perDayAmount)}/day safe to spend until your next payday (${dateLabel}, ${projection.daysUntilPayday} day${projection.daysUntilPayday === 1 ? '' : 's'} away)${sourceNote}.`,
    sentiment: projection.perDayAmount > 0 ? 'neutral' : 'warning'
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

/** Weekday vs weekend, over the last 30 days rather than the current
 * budget period — a period can be as short as a few days right after
 * it starts, which isn't enough of either bucket to say anything
 * meaningful; a rolling 30-day window always has a real sample of
 * both. */
export function weekdayWeekendSplit(transactions: Transaction[], referenceDate: Date): Answer {
  const cutoff = new Date(referenceDate.getTime() - 30 * 24 * 60 * 60 * 1000)
  const recent = transactions.filter((t) => t.isExpense && t.categoryId && new Date(t.date) >= cutoff && new Date(t.date) <= referenceDate)
  let weekday = 0
  let weekdayDays = new Set<string>()
  let weekend = 0
  let weekendDays = new Set<string>()
  for (const t of recent) {
    const d = new Date(t.date)
    const dayKey = d.toDateString()
    const isWeekend = d.getDay() === 0 || d.getDay() === 6
    if (isWeekend) { weekend += t.amount; weekendDays.add(dayKey) } else { weekday += t.amount; weekdayDays.add(dayKey) }
  }
  if (weekday === 0 && weekend === 0) return { text: 'Not enough spending in the last 30 days to compare weekdays and weekends.', sentiment: 'neutral' }

  const perWeekdayDay = weekdayDays.size > 0 ? weekday / weekdayDays.size : 0
  const perWeekendDay = weekendDays.size > 0 ? weekend / weekendDays.size : 0
  if (perWeekdayDay === 0 || perWeekendDay === 0) {
    return { text: `Last 30 days: ${formatCurrency(weekday)} on weekdays, ${formatCurrency(weekend)} on weekends.`, sentiment: 'neutral' }
  }
  const higher = perWeekendDay > perWeekdayDay ? 'weekends' : 'weekdays'
  const ratio = Math.max(perWeekdayDay, perWeekendDay) / Math.min(perWeekdayDay, perWeekendDay)
  return {
    text: `You spend ${ratio.toFixed(1)}x more per day on ${higher} — ${formatCurrency(perWeekendDay)}/day on weekends vs ${formatCurrency(perWeekdayDay)}/day on weekdays, over the last 30 days.`,
    sentiment: 'neutral'
  }
}

export interface MerchantCreepItem {
  merchant: string
  recentAvg: number
  earlierAvg: number
}

/** The non-recurring counterpart to subscriptionCreep — a merchant you
 * pay irregularly (no fixed schedule, so it can't be caught by
 * comparing against a configured recurring amount) whose typical
 * transaction size has crept up over the last three periods compared
 * to the three before that. Deliberately requires at least 2
 * transactions in EACH window before comparing — one expensive trip to
 * a normally-cheap place is a coincidence, not a trend, and comparing
 * single transactions would flag ordinary variation constantly. Also
 * requires a real, meaningful rise (over 20%) before flagging, so
 * everyday price noise doesn't read as "creep." */
export function merchantSpendingCreep(transactions: Transaction[], referenceDate: Date): MerchantCreepItem[] {
  const recentStart = new Date(referenceDate.getTime() - 90 * 24 * 60 * 60 * 1000)
  const earlierStart = new Date(referenceDate.getTime() - 180 * 24 * 60 * 60 * 1000)

  const byMerchant = new Map<string, { recent: number[]; earlier: number[] }>()
  for (const t of transactions) {
    if (!t.isExpense || !t.note.trim()) continue
    const date = new Date(t.date)
    if (date > referenceDate || date < earlierStart) continue
    const key = t.note.trim().toLowerCase()
    const entry = byMerchant.get(key) ?? { recent: [], earlier: [] }
    if (date >= recentStart) entry.recent.push(t.amount)
    else entry.earlier.push(t.amount)
    byMerchant.set(key, entry)
  }

  const results: MerchantCreepItem[] = []
  for (const [merchant, { recent, earlier }] of byMerchant.entries()) {
    if (recent.length < 2 || earlier.length < 2) continue
    const recentAvg = recent.reduce((s, a) => s + a, 0) / recent.length
    const earlierAvg = earlier.reduce((s, a) => s + a, 0) / earlier.length
    if (earlierAvg <= 0) continue
    if ((recentAvg - earlierAvg) / earlierAvg > 0.2) {
      results.push({ merchant, recentAvg, earlierAvg })
    }
  }
  return results.sort((a, b) => (b.recentAvg - b.earlierAvg) - (a.recentAvg - a.earlierAvg))
}
