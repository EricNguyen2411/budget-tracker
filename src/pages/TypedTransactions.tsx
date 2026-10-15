import { spendingPace } from '../forecast'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Category, Transaction } from '../types'
import { formatCurrency, netAmount, repaysNote, excessForReimbursement, netSpentForCategory, isUnlinkedIncome, isIncomeReceipt, isLinkedReimbursement, isGenuineReimbursement, coveredExpenseIds, orderedReimbursements, savingsCategoryIds, inSavingsCategory, netSavedThisPeriod } from '../calculations'
import { isInSamePeriod, periodOffsetBy } from '../budgetPeriod'
import { normalizeTag } from '../tags'
import TransactionEditor from '../components/TransactionEditor'
import { useSwipeBack } from '../useSwipeBack'
import SortMenuButton from '../components/SortMenuButton'

export type StatKind = 'spent' | 'income' | 'reimbursed' | 'saved'

interface Props {
  kind: StatKind
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onSave: (data: Omit<Transaction, 'id'>, existingId: string | null) => void
  onDelete: (id: string) => void
  onChanged: () => void
}

const TITLES: Record<StatKind, string> = {
  spent: 'Spent',
  income: 'Income',
  reimbursed: 'Reimbursed',
  saved: 'Saved'
}

export default function TypedTransactions({ kind, categories, transactions, onBack, onSave, onDelete, onChanged }: Props) {
  useSwipeBack(onBack)
  const [sort, setSort] = useState<'recent' | 'price'>('recent')
  const [showZeroImpact, setShowZeroImpact] = useState(false)
  const [expandedTags, setExpandedTags] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<Transaction | null>(null)
  const today = useMemo(() => new Date(), [])
  // 0 = the current period, -1 = the one before it, and so on. There's
  // nothing to browse forward into, and nothing before the first
  // transaction, so both ends are bounded.
  const [offset, setOffset] = useState(0)
  const [slide, setSlide] = useState<'left' | 'right' | null>(null)
  const period = useMemo(() => periodOffsetBy(offset, today), [offset, today])
  // The period itself is what matters; any date safely inside it works as
  // the reference the calculations take. For the current period that's
  // today, exactly as before.
  const now = useMemo(() => (offset === 0 ? today : new Date(period.start.getTime() + 24 * 60 * 60 * 1000)), [offset, today, period])
  const minOffset = useMemo(() => {
    if (transactions.length === 0) return 0
    const earliest = transactions.reduce((min, t) => (t.date < min ? t.date : min), transactions[0].date)
    const earliestDate = new Date(earliest)
    let o = 0
    while (o > -240 && periodOffsetBy(o, today).start > earliestDate) o--
    return o
  }, [transactions, today])

  function goTo(next: number) {
    const clamped = Math.min(0, Math.max(minOffset, next))
    if (clamped === offset) return
    setSlide(clamped < offset ? 'right' : 'left')
    setOffset(clamped)
    setExpandedTags(new Set())
    setShowZeroImpact(false)
  }

  // Horizontal swipe on the list moves between periods: dragging right
  // goes back in time, left comes forward. The content follows the
  // finger, and a gesture that begins in the thin left-edge zone is left
  // alone for the swipe-back-to-dashboard gesture.
  const swipeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = swipeRef.current
    if (!el) return
    let startX = 0, startY = 0, active = false, dragging = false, swiped = false
    function down(e: PointerEvent) {
      if (e.clientX <= 28) { active = false; return }
      startX = e.clientX; startY = e.clientY; active = true; dragging = false
    }
    function move(e: PointerEvent) {
      if (!active || !el) return
      const dx = e.clientX - startX, dy = e.clientY - startY
      if (!dragging) {
        if (Math.abs(dx) < 10 || Math.abs(dy) > Math.abs(dx)) return
        dragging = true
        el.style.transition = 'none'
      }
      el.style.transform = `translateX(${dx * 0.5}px)`
      el.style.opacity = String(Math.max(0.5, 1 - Math.abs(dx) / 500))
    }
    function end(e: PointerEvent) {
      if (!active || !el) return
      active = false
      const dx = e.clientX - startX
      el.style.transition = 'transform 0.2s ease, opacity 0.2s ease'
      el.style.transform = ''
      el.style.opacity = ''
      if (dragging && Math.abs(dx) > 70) goToRef.current(dx > 0 ? offsetRef.current - 1 : offsetRef.current + 1)
      // A drag that began and ended on the same row would otherwise also
      // register as a click on it (mouse and some browsers do this) and
      // pop the editor open as the page slides.
      if (dragging) { swiped = true; setTimeout(() => { swiped = false }, 0) }
      dragging = false
    }
    function click(e: MouseEvent) {
      if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false }
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('click', click, true)
    return () => {
      el.removeEventListener('click', click, true)
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
    }
  }, [])
  const goToRef = useRef(goTo)
  const offsetRef = useRef(offset)
  goToRef.current = goTo
  offsetRef.current = offset

  const savingsIds = useMemo(() => savingsCategoryIds(categories), [categories])
  const thisPeriod = useMemo(() => transactions.filter((t) => isInSamePeriod(new Date(t.date), now)), [transactions, now])

  const scoped = useMemo(() => {
    switch (kind) {
      case 'spent':
        // Includes unlinked income under a category too (a refund,
        // cashback, etc. logged as plain income rather than a
        // reimbursement) — not just expenses. Confirmed via direct
        // testing that excluding it here was a real bug: the dashboard
        // stat nets that income against the category's spend (correctly
        // clamped at zero so a big refund can't drag the whole total
        // negative), but this screen's own total previously ignored it
        // completely, so tapping "Spent" could show a different number
        // than the tile you tapped.
        //
        // A plain uncategorized transaction like a salary deposit has
        // no category at all, doesn't affect any category's total, and
        // is correctly excluded by the same categoryId check.
        return thisPeriod.filter((t) => !inSavingsCategory(t, savingsIds) && (t.isExpense ? !!t.categoryId : !!t.categoryId && isUnlinkedIncome(t)))
      case 'saved':
        // Money put into a savings category this period. A withdrawal
        // (income-direction, carrying fundedFromCategoryId) reduces a
        // category rather than building it, so it isn't listed here.
        return thisPeriod.filter((t) => t.isExpense && !t.reimbursesExpenseId && inSavingsCategory(t, savingsIds))
      case 'income':
        // Also includes the EXCESS portion of an over-reimbursement (paid
        // back more than the expense cost) — confirmed via direct testing
        // this is counted in the dashboard's Income figure but was
        // previously invisible here, since the filter excluded every
        // reimbursement-linked transaction outright regardless of
        // whether part of it was genuine excess income.
        return thisPeriod.filter((t) => !t.isExpense && (isIncomeReceipt(t) || excessForReimbursement(t, transactions) > 0))
      case 'reimbursed':
        return thisPeriod.filter((t) => isGenuineReimbursement(t, transactions))
    }
  }, [thisPeriod, kind, transactions, savingsIds])

  // Computed the SAME way as the dashboard stat this screen was opened
  // from — reusing netSpentForCategory's per-category clamp directly,
  // rather than re-deriving a total from the transaction list above,
  // guarantees the two numbers can't drift apart the way they were
  // confirmed to before this fix.
  // How much of THIS reimbursement transaction actually counts as
  // "reimbursed" — summed across every expense it covers (one, for the
  // simple single-link shape; possibly several, for a multi-allocation
  // one), via the same order-aware "applied" logic used everywhere
  // else, rather than assuming a multi-allocation transaction's own
  // amount always equals its contribution — correct in the
  // overwhelmingly common case, but not if some other reimbursement on
  // the same expense came in after this one and partly displaced it,
  // or if this transaction itself overpaid the expense (the excess
  // portion belongs to Income instead, not here). Shared by the total
  // below AND each row's own display, so they can't drift apart the
  // way they were confirmed to before this fix: a reimbursement that
  // partly overpaid what it covered was showing its full face value on
  // its own row while the header above only counted the applied
  // portion, so the rows never quite summed to the header — the exact
  // same class of mismatch already fixed once for the Income list
  // above, just missed here originally.
  function appliedReimbursement(t: Transaction): number {
    let total = 0
    for (const expenseId of coveredExpenseIds(t)) {
      const expense = transactions.find((e) => e.id === expenseId)
      if (!expense) continue
      const reimbursements = orderedReimbursements(expense, transactions)
      let remaining = expense.amount
      for (const r of reimbursements) {
        const applied = Math.min(r.amount, Math.max(0, remaining))
        if (r.id === t.id) { total += applied; break }
        remaining -= applied
      }
    }
    return total
  }
  const memoizedAppliedReimbursement = useCallback(appliedReimbursement, [transactions])

  const total = useMemo(() => {
    if (kind === 'spent') {
      const topLevel = categories.filter((c) => !c.parentId && !c.isSavingsCategory)
      return topLevel.reduce((sum, c) => sum + Math.max(0, netSpentForCategory(c, categories, transactions, now)), 0)
    }
    if (kind === 'saved') {
      return netSavedThisPeriod(categories, transactions, now)
    }
    if (kind === 'income') {
      const unlinkedIncome = thisPeriod.filter((t) => isIncomeReceipt(t)).reduce((sum, t) => sum + t.amount, 0)
      const excessFromLinked = thisPeriod.filter((t) => isLinkedReimbursement(t)).reduce((sum, t) => sum + excessForReimbursement(t, transactions), 0)
      return unlinkedIncome + excessFromLinked
    }
    return scoped.reduce((sum, t) => sum + memoizedAppliedReimbursement(t), 0)
  }, [kind, categories, transactions, now, thisPeriod, scoped, memoizedAppliedReimbursement])

  // For the Income list specifically, a reimbursement-linked transaction
  // only appears here because part of it was excess (see the scoped
  // filter above) — showing the full repayment amount on its row would
  // overstate what it actually contributes to the total shown above,
  // confirmed via a real screenshot: a $130 repayment where only $30
  // was excess displayed as "+$130.00" right under a total that had
  // only added $30 of it, so the rows didn't add up to the header. Used
  // for both the row display and the "highest price" sort, so neither
  // one quietly disagrees with the other.
  //
  // Same reasoning applies to the Reimbursed list: a row there needs
  // the APPLIED portion (appliedReimbursement), not the transaction's
  // full face value — otherwise a partly-excess reimbursement shows
  // its whole amount here AND its excess sliver again over on Income,
  // double-displaying that sliver of the same real dollar in two
  // different lists.
  function rowAmount(t: Transaction): number {
    if (kind === 'income' && t.reimbursesExpenseId) return excessForReimbursement(t, transactions)
    if (kind === 'reimbursed') return appliedReimbursement(t)
    // Exclusive (budget-relative) netAmount for spent/saved specifically
    // — must match `total` above. Has no effect on a plain savings
    // contribution either way (nothing to net for an unlinked transaction).
    return netAmount(t, transactions)
  }

  // Part of this period's Spent that came out of the person's own savings
  // (expenses linked to a "fund from savings" take-out). It stays inside
  // the Spent total — the Saved figure drops by the same amount — so this
  // is only an explanatory split, never subtracted from `total`.
  const fromSavings = useMemo(() => {
    if (kind !== 'spent') return 0
    let sum = 0
    for (const t of scoped) {
      if (!t.isExpense) continue
      const funded = orderedReimbursements(t, transactions)
        .filter((r) => !!r.fundedFromCategoryId)
        .reduce((s, r) => s + r.amount, 0)
      if (funded > 0) sum += Math.min(funded, netAmount(t, transactions))
    }
    return Math.round(sum * 100) / 100
  }, [kind, scoped, transactions])

  // How this period's Spent compares with the period before it, at the
  // same point (day of the cycle). For a finished period the "same point" is
  // simply its whole length, so it reads as a period-over-period change.
  const comparison = useMemo(() => {
    if (kind !== 'spent') return null
    const ref = offset === 0 ? today : new Date(period.end.getTime() - 12 * 3600 * 1000)
    const pace = spendingPace(categories, transactions, ref)
    if (pace.previousAtSameDay === null) return null
    // A finished period is compared with the WHOLE period before it (the two
    // can differ in length, so "same day number" would cut the longer one short).
    const before = offset !== 0 ? pace.previous[pace.previous.length - 1] : pace.previousAtSameDay
    return { spentToDate: pace.spentToDate, previousAtSameDay: before, delta: pace.spentToDate - before, day: pace.previousComparedDay, ofDays: pace.previousDays, finished: offset !== 0 }
  }, [kind, offset, today, period, categories, transactions])

  const sorted = [...scoped].sort((a, b) =>
    sort === 'recent' ? b.date.localeCompare(a.date) : rowAmount(b) - rowAmount(a)
  )

  // Group tagged transactions into per-tag folders — a transaction with
  // several tags contributes to each of them, same convention
  // topTagsThisMonth already uses, so a tag's total here matches what
  // that Dashboard widget (and TagDetail) would show for the same tag.
  // Untagged transactions fall through to the flat list below exactly
  // as before.
  const tagGroups = (() => {
    const map = new Map<string, { tag: string; total: number; rows: Transaction[] }>()
    for (const t of sorted) {
      for (const rawTag of t.tags) {
        const tag = normalizeTag(rawTag)
        if (!tag) continue
        if (!map.has(tag)) map.set(tag, { tag, total: 0, rows: [] })
        const group = map.get(tag)!
        group.total += rowAmount(t)
        group.rows.push(t)
      }
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total)
  })()
  const untaggedRows = sorted.filter((t) => t.tags.length === 0)

  const zeroImpactRows = kind === 'spent' || kind === 'saved' ? untaggedRows.filter((t) => t.isExpense && rowAmount(t) === 0) : []
  const mainRows = kind === 'spent' || kind === 'saved' ? untaggedRows.filter((t) => !(t.isExpense && rowAmount(t) === 0)) : untaggedRows

  const catById = new Map(categories.map((c) => [c.id, c]))

  const periodLabel = useMemo(() => {
    const last = new Date(period.end.getFullYear(), period.end.getMonth(), period.end.getDate() - 1)
    const fmt = (d: Date, withYear: boolean) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })
    return `${fmt(period.start, period.start.getFullYear() !== last.getFullYear())} – ${fmt(last, true)}`
  }, [period])

  function TransactionRow({ t, isLast }: { t: Transaction; isLast: boolean }) {
    const cat = t.categoryId ? catById.get(t.categoryId) : undefined
    const isExcessOnlyRow = kind === 'income' && !!t.reimbursesExpenseId
    return (
      <button className="transaction-row" style={{ borderBottom: isLast ? 'none' : '1px solid var(--border)' }} onClick={() => setEditing(t)}>
        <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33' }}>{cat?.icon ?? '❓'}</div>
        <div className="tx-info">
          <span className="tx-note">{t.note || cat?.name || 'Uncategorized'}</span>
          <span className="tx-category">{new Date(t.date).toLocaleDateString('en-AU')}{repaysNote(t, transactions, categories) && ` · ${repaysNote(t, transactions, categories)}`}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flexShrink: 0 }}>
          {!isExcessOnlyRow && rowAmount(t) !== t.amount && (
            <span className="amount" style={{ fontSize: 12, color: 'var(--text-faint)', textDecoration: 'line-through' }}>
              {formatCurrency(t.amount)}
            </span>
          )}
          <span className="amount tx-amount" style={{ color: t.isExpense ? 'var(--text)' : 'var(--green)' }}>
            {t.isExpense ? '-' : '+'}{formatCurrency(rowAmount(t))}
          </span>
          {isExcessOnlyRow && (
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>(of {formatCurrency(t.amount)} repayment)</span>
          )}
        </div>
      </button>
    )
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{TITLES[kind]}</h1>
        <SortMenuButton
          options={[{ value: 'recent', label: 'Newest First' }, { value: 'price', label: 'Highest Price First' }]}
          value={sort}
          onChange={setSort}
        />
      </div>

      <div className="card" style={{ marginBottom: 16, textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <button aria-label="Previous period" data-testid="period-prev" disabled={offset <= minOffset} onClick={() => goTo(offset - 1)} style={{ fontSize: 26, padding: '0 10px', color: 'var(--blue)', opacity: offset <= minOffset ? 0.25 : 1 }}>‹</button>
          <div style={{ minWidth: 0 }}>
            <span className="hero-label" data-testid="period-label">{TITLES[kind]} {offset === 0 ? 'this period' : offset === -1 ? 'last period' : ''}</span>
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }} data-testid="period-range">{periodLabel}</div>
          </div>
          <button aria-label="Next period" data-testid="period-next" disabled={offset >= 0} onClick={() => goTo(offset + 1)} style={{ fontSize: 26, padding: '0 10px', color: 'var(--blue)', opacity: offset >= 0 ? 0.25 : 1 }}>›</button>
        </div>
        <div className="hero-amount amount" data-testid="period-total" style={{ fontSize: 32 }}>{formatCurrency(total)}</div>
        {comparison && (
          <div data-testid="period-vs-last" style={{ fontSize: 13, marginTop: 4, color: Math.abs(comparison.delta) < 0.005 ? 'var(--text-dim)' : comparison.delta > 0 ? 'var(--red)' : 'var(--green)' }}>
            {Math.abs(comparison.delta) < 0.005
              ? (comparison.finished ? 'Same as the period before' : `Same as this point last period (day ${comparison.day} of ${comparison.ofDays})`)
              : <><span className="amount">{formatCurrency(Math.abs(comparison.delta))}</span> {comparison.delta > 0 ? 'more' : 'less'} than {comparison.finished ? 'the period before' : `this point last period (day ${comparison.day} of ${comparison.ofDays})`}</>}
          </div>
        )}
        {kind === 'spent' && fromSavings > 0 && (
          <div data-testid="period-from-savings" style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 4 }}>
            of which <span className="amount">{formatCurrency(fromSavings)}</span> paid from savings
          </div>
        )}
      </div>

      <div ref={swipeRef} style={{ touchAction: 'pan-y', minHeight: '50vh' }}>
      <div key={offset} className={slide ? `period-slide-${slide}` : undefined}>

      {mainRows.length === 0 && zeroImpactRows.length === 0 && tagGroups.length === 0 && <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20 }}>Nothing here this period.</p>}
      {mainRows.length === 0 && zeroImpactRows.length > 0 && tagGroups.length === 0 && (
        <p style={{ textAlign: 'center', color: 'var(--text-dim)', marginTop: 20, fontSize: 13 }}>
          Everything this period was fully covered — see below.
        </p>
      )}

      {tagGroups.map((group) => {
        const isExpanded = expandedTags.has(group.tag)
        return (
          <div key={group.tag} className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            <button
              className="list-button"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: 14 }}
              onClick={() => setExpandedTags((prev) => {
                const next = new Set(prev)
                if (next.has(group.tag)) next.delete(group.tag)
                else next.add(group.tag)
                return next
              })}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15 }}>🏷️ {group.tag}</span>
                <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>({group.rows.length})</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="amount" style={{ fontSize: 15 }}>{formatCurrency(group.total)}</span>
                <span style={{ color: 'var(--text-faint)' }}>{isExpanded ? '▾' : '▸'}</span>
              </span>
            </button>
            {isExpanded && group.rows.map((t, i) => (
              <TransactionRow key={t.id} t={t} isLast={i === group.rows.length - 1} />
            ))}
          </div>
        )
      })}

      {mainRows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {mainRows.map((t, i) => (
            <TransactionRow key={t.id} t={t} isLast={i === mainRows.length - 1} />
          ))}
        </div>
      )}

      {zeroImpactRows.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden', marginTop: mainRows.length > 0 ? 16 : 0 }}>
          <button
            className="list-button"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: 14 }}
            onClick={() => setShowZeroImpact((v) => !v)}
          >
            <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              {zeroImpactRows.length} fully covered transaction{zeroImpactRows.length === 1 ? '' : 's'} — no budget impact this period
            </span>
            <span style={{ color: 'var(--text-faint)' }}>{showZeroImpact ? '▾' : '▸'}</span>
          </button>
          {showZeroImpact && zeroImpactRows.map((t, i) => (
            <TransactionRow key={t.id} t={t} isLast={i === zeroImpactRows.length - 1} />
          ))}
        </div>
      )}

      </div>
      </div>

      {editing && (
        <TransactionEditor
          transaction={editing}
          categories={categories}
          allTransactions={transactions}
          onSave={(data) => { onSave(data, editing.id); setEditing(null) }}
          onDelete={() => { onDelete(editing.id); setEditing(null) }}
          onClose={() => setEditing(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}
