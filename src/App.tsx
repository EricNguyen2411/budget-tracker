import { useEffect, useState, useCallback } from 'react'
import type { Category, Transaction, RecurringTransaction, ShoppingList, Account, InstallmentPlan } from './types'
import {
  ensureDefaultCategories, getCategories, getTransactions, createTransaction, saveTransaction, deleteTransaction, deleteTransfer,
  getRecurring, saveRecurring, getShoppingLists, performAutoBackupIfNeeded, syncReimbursementCategoriesOnce,
  getAccounts, getInstallmentPlans, saveInstallmentPlan, recordNetWorthSnapshot, createTransfer
} from './db'
import { processDueRecurring, addInterval } from './recurring'
import { processDueInstallments } from './installments'
import { getSettings, isCustomCycle, getCycleConfig, predictedCycleFor, setCycleOverride } from './budgetPeriod'
import { localDateInputValue, findTransferPair, findFundingPair, netWorthTotal, formatCurrency } from './calculations'
import { getPaydayTargets, recordPaydayAmount } from './paydayRoutine'
import { checkInAppNudge } from './notifications'
import { useSwipeBack } from './useSwipeBack'
import Dashboard from './pages/Dashboard'
import TransactionsPage from './pages/Transactions'
import Budgets from './pages/Budgets'
import More from './pages/More'
import RecurringPage from './pages/Recurring'
import InstallmentPlansPage from './pages/InstallmentPlansPage'
import ShoppingLists from './pages/ShoppingLists'
import DuplicateCheck from './pages/DuplicateCheck'
import HealthCheck from './pages/HealthCheck'
import CategoryDetail from './pages/CategoryDetail'
import CategoryTrendPage from './pages/CategoryTrendPage'
import Insights from './pages/Insights'
import CustomRangeReport from './pages/CustomRangeReport'
import MerchantRules from './pages/MerchantRules'
import TypedTransactions, { type StatKind } from './pages/TypedTransactions'
import CategoriesScreen from './pages/CategoriesScreen'
import PeriodDetail from './pages/PeriodDetail'
import StatementImport from './pages/StatementImport'
import TotalBudgetPlanner from './pages/TotalBudgetPlanner'
import AutoBackups from './pages/AutoBackups'
import CategoryBreakdownByMonth from './pages/CategoryBreakdownByMonth'
import MonthlyRecapPage from './pages/MonthlyRecapPage'
import TagsScreen from './pages/TagsScreen'
import TagDetail from './pages/TagDetail'
import AccountsScreen from './pages/AccountsScreen'
import AccountDetail from './pages/AccountDetail'
import { DashboardIcon, ListIcon, TargetIcon, MoreIcon } from './icons'

type Tab = 'dashboard' | 'transactions' | 'budgets' | 'more' | 'recurring' | 'shopping' | 'duplicates' | 'health' | 'report' | 'merchants' | 'categories' | 'import' | 'budgetplanner' | 'autobackups' | 'categorybreakdown' | 'monthlyrecap' | 'tags' | 'accounts' | 'installments' | 'insights'

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  // Some pages (Month in Review, Spending by Category) are reachable
  // both from a Dashboard widget and from More → Tools — back needs to
  // return to wherever the person actually came from, not always
  // assume the More menu.
  const [returnTab, setReturnTab] = useState<Tab>('more')
  const [pendingImportFiles, setPendingImportFiles] = useState<FileList | null>(null)
  const [pendingTransactionsSearch, setPendingTransactionsSearch] = useState<string | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [recurring, setRecurring] = useState<RecurringTransaction[]>([])
  const [shoppingLists, setShoppingLists] = useState<ShoppingList[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [installmentPlans, setInstallmentPlans] = useState<InstallmentPlan[]>([])
  const [loaded, setLoaded] = useState(false)
  const [categoryDetailId, setCategoryDetailId] = useState<string | null>(null)
  const [viewingTagDetail, setViewingTagDetail] = useState<string | null>(null)
  const [viewingAccountDetail, setViewingAccountDetail] = useState<Account | null>(null)
  const [viewingCategoryTrend, setViewingCategoryTrend] = useState<Category | null>(null)
  const [statDetail, setStatDetail] = useState<StatKind | null>(null)
  const [dateRangeNav, setDateRangeNav] = useState<{ title: string; start: string; end: string; categoryId?: string } | null>(null)

  // "Did your pay actually land on a different day this cycle?" — the
  // last-business-day (or fixed-day) rule is a PREDICTION, and real
  // paydays sometimes shift (paid a day early for a bank holiday, an
  // employer's own irregular schedule). Rather than requiring a perfect
  // rule, a sizeable unlinked income entry whose date doesn't match the
  // prediction gets offered as a one-off correction for THAT cycle
  // specifically — see budgetPeriod.ts's override system. $500 and a
  // 10-day window are deliberately conservative defaults: high enough
  // to skip small refunds/gifts, tight enough to skip income that's
  // obviously unrelated to payday timing (which would just be an
  // unhelpful, confusing prompt) rather than a plausible payday shift.
  const SALARY_LIKE_THRESHOLD = 5000
  const MAX_CORRECTION_WINDOW_DAYS = 10
  const [cyclePrompt, setCyclePrompt] = useState<{ bucketKey: string; txDateISO: string; txDateLabel: string; predictedLabel: string } | null>(null)
  const [paydaySplitPrompt, setPaydaySplitPrompt] = useState<{ sourceAccountId: string; sourceDate: string; amounts: Map<string, string> } | null>(null)

  useSwipeBack(
    () => setTab('more'),
    tab === 'recurring' || tab === 'shopping' || tab === 'duplicates' || tab === 'health'
  )

  const reload = useCallback(async () => {
    const [cats, txs, rec, lists, accts, plans] = await Promise.all([getCategories(), getTransactions(), getRecurring(), getShoppingLists(), getAccounts(), getInstallmentPlans()])
    setCategories(cats)
    setTransactions(txs)
    setRecurring(rec)
    setShoppingLists(lists)
    setAccounts(accts)
    setInstallmentPlans(plans)
  }, [])

  // Shared between initial app load and restoring a backup — a backup
  // brought in from another device can easily contain recurring bills
  // or installment plans with payments that are now overdue, and
  // without this also running right after a restore, they'd just sit
  // there uncaught-up until the next full page reload happened to
  // trigger the init effect below, which is neither obvious nor
  // something a person restoring a backup would think to do themselves.
  const catchUpDueItems = useCallback(async () => {
    const rec = await getRecurring()
    const { newTransactions, updatedRecurring } = processDueRecurring(rec)
    for (const t of newTransactions) await createTransaction(t)
    for (const r of updatedRecurring) await saveRecurring(r)

    const plans = await getInstallmentPlans()
    const existingTx = await getTransactions()
    const { newTransactions: dueInstallments, updatedPlans } = processDueInstallments(plans, existingTx)
    for (const t of dueInstallments) await createTransaction(t)
    for (const p of updatedPlans) await saveInstallmentPlan(p)
  }, [])

  useEffect(() => {
    async function init() {
      await ensureDefaultCategories()
      await syncReimbursementCategoriesOnce()
      await catchUpDueItems()

      await reload()
      setLoaded(true)
      performAutoBackupIfNeeded()

      const settings = getSettings()
      const txs = await getTransactions()
      const mostRecent = txs[0] ? new Date(txs[0].date) : null
      checkInAppNudge(mostRecent, settings.nudgeEnabled ?? false, 3)

      // Once per calendar day is enough for a trend — recording on
      // every reload (which happens after nearly every edit) would
      // work fine too, since same-day entries overwrite rather than
      // accumulate, but there's no reason to do the extra write.
      // Fetched fresh rather than reading the accounts/transactions
      // state variables, since those won't reflect this same reload()
      // call yet inside this closure (React state updates aren't
      // synchronous) — recordNetWorthSnapshot needs the real current
      // figures, not last render's.
      const freshAccounts = await getAccounts()
      await recordNetWorthSnapshot(netWorthTotal(freshAccounts, txs))
    }
    init()
  }, [reload, catchUpDueItems])

  async function handleSaveTransaction(data: Omit<Transaction, 'id'>, existingId: string | null) {
    if (existingId) {
      await saveTransaction({ ...data, id: existingId })
    } else {
      const created = await createTransaction(data)
      maybeOfferCycleCorrection(created)
      maybeOfferPaydaySplit(created)
    }
    await reload()
  }

  function maybeOfferPaydaySplit(t: Transaction) {
    if (t.isExpense || t.reimbursesExpenseId || t.amount < SALARY_LIKE_THRESHOLD || !t.accountId) return
    const targets = getPaydayTargets().filter((target) => target.accountId !== t.accountId)
    if (targets.length === 0) return
    setPaydaySplitPrompt({
      sourceAccountId: t.accountId,
      sourceDate: t.date,
      amounts: new Map(targets.map((target) => [target.accountId, target.lastAmount > 0 ? String(target.lastAmount) : '']))
    })
  }

  async function confirmPaydaySplit() {
    if (!paydaySplitPrompt) return
    for (const [accountId, amountStr] of paydaySplitPrompt.amounts.entries()) {
      const amount = parseFloat(amountStr)
      if (!amount || amount <= 0) continue
      // Confirmed via direct testing this needed to be explicit, not
      // left to createTransfer's own default note ("Transfer from
      // [source]"): the new savings reserve (see
      // monthlyEquivalentRecurringSavingsContributions) recognizes a
      // planned contribution as fulfilled by matching a real
      // transaction's note against the recurring item's own note — a
      // generic transfer note never matches that, so the reserve kept
      // counting the full amount as still-pending even after this real
      // transfer already moved it, double-counting the same $400 twice
      // in Safe to Spend. Reusing the matching recurring item's exact
      // note here, when one exists for this destination, is what makes
      // the two features actually recognize each other.
      const matchingRecurringItem = recurring.find((r) => r.isActive && !r.isExpense && r.accountId === accountId)
      await createTransfer({ fromAccountId: paydaySplitPrompt.sourceAccountId, toAccountId: accountId, amount, date: paydaySplitPrompt.sourceDate, note: matchingRecurringItem?.note })
      recordPaydayAmount(accountId, amount)
      // Advances the recurring item's own schedule forward too, the
      // same one step processDueRecurring itself would take — without
      // this, the recurring item stays due at its old date, genuinely
      // unaware this cycle's contribution just happened manually, and
      // would generate a second, real, duplicate transaction into the
      // same account the next time the app catches up on due items.
      // Reuses processDueRecurring's own date-advancement logic
      // (addInterval) rather than a second, separately-written version
      // of the same rule that could quietly disagree with it.
      if (matchingRecurringItem) {
        const anchorDay = matchingRecurringItem.anchorDay ?? new Date(matchingRecurringItem.nextDueDate).getDate()
        const advanced = addInterval(new Date(matchingRecurringItem.nextDueDate), matchingRecurringItem.frequency, anchorDay)
        await saveRecurring({ ...matchingRecurringItem, nextDueDate: advanced.toISOString(), anchorDay })
      }
    }
    setPaydaySplitPrompt(null)
    await reload()
  }

  function maybeOfferCycleCorrection(t: Transaction) {
    const settings = getSettings()
    if (!isCustomCycle(settings)) return
    if (t.isExpense || t.reimbursesExpenseId || t.amount < SALARY_LIKE_THRESHOLD) return

    const txDate = new Date(t.date)
    const txDateOnly = new Date(txDate.getFullYear(), txDate.getMonth(), txDate.getDate())
    const { bucketKey, predictedStart } = predictedCycleFor(txDateOnly, getCycleConfig())
    const predictedOnly = new Date(predictedStart.getFullYear(), predictedStart.getMonth(), predictedStart.getDate())
    const diffDays = Math.round((txDateOnly.getTime() - predictedOnly.getTime()) / (24 * 60 * 60 * 1000))
    if (diffDays === 0 || Math.abs(diffDays) > MAX_CORRECTION_WINDOW_DAYS) return

    setCyclePrompt({
      bucketKey,
      txDateISO: localDateInputValue(txDateOnly),
      txDateLabel: txDateOnly.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' }),
      predictedLabel: predictedOnly.toLocaleDateString('en-AU', { day: 'numeric', month: 'long' })
    })
  }

  function confirmCycleCorrection() {
    if (!cyclePrompt) return
    setCycleOverride(cyclePrompt.bucketKey, cyclePrompt.txDateISO)
    setCyclePrompt(null)
    reload()
  }

  async function handleDeleteTransaction(id: string) {
    // Swipe-to-delete goes through this one shared handler from every
    // list in the app, unlike the tap-to-edit flow (TransactionEditor),
    // which already detects a transfer and deletes both halves
    // together. Confirmed via direct testing this was a real gap, not
    // just a theoretical one: swiping away either half here called
    // deleteTransaction on just that one id, leaving its other half
    // behind as an orphaned, un-paired transaction — still real money
    // correctly gone from the source account, but never arriving
    // anywhere, and no longer describable as "a transfer" at all. Same
    // detection TransactionEditor already relies on, so swiping
    // matches what tapping-then-deleting has always done.
    const target = transactions.find((t) => t.id === id)
    const other = target ? findTransferPair(target, transactions) : null
    if (target && other) {
      // Swiping only ever removes ONE row on screen, so silently taking
      // a second, different-looking transaction along with it — one
      // that might be sitting on a completely different account's
      // history, out of view — is a real surprise worth a heads-up for,
      // even though deleting both together is the correct behavior. A
      // plain single transaction still deletes with just the swipe +
      // tap, no extra step — this only fires for the linked case.
      const otherAccount = accounts.find((a) => a.id === other.accountId)
      const confirmed = confirm(`This is one half of a transfer. Deleting it will also remove the matching transaction on ${otherAccount?.name ?? 'the other account'} — both sides always go together. Continue?`)
      if (!confirmed) return
      const expenseId = target.isExpense ? target.id : other.id
      const incomeId = target.isExpense ? other.id : target.id
      await deleteTransfer(expenseId, incomeId)
    } else {
      const fundingPair = target ? findFundingPair(target, transactions) : null
      if (fundingPair && target) {
        // Whichever side got swiped, the account whose real balance is
        // affected is findable directly off it: the offset carries
        // fundedFromAccountId itself, the withdrawal carries it as its
        // own accountId — never off fundingPair, which is the OTHER
        // side and wouldn't have the right one in both directions.
        const fundingAccountId = target.fundedFromAccountId ?? target.accountId
        const fundingAccount = accounts.find((a) => a.id === fundingAccountId)
        const confirmed = confirm(`This is linked to a real withdrawal from ${fundingAccount?.name ?? 'a savings account'}. Deleting it will also remove that withdrawal, restoring the account's balance — both sides always go together. Continue?`)
        if (!confirmed) return
        await deleteTransaction(fundingPair.id)
      }
      await deleteTransaction(id)
    }
    await reload()
  }

  if (!loaded) return null

  const categoryDetail = categoryDetailId ? categories.find((c) => c.id === categoryDetailId) : null
  const anyOverlay = categoryDetail || statDetail || dateRangeNav || viewingTagDetail || viewingAccountDetail || viewingCategoryTrend

  return (
    <div className="app-shell">
      {viewingCategoryTrend ? (
        <CategoryTrendPage
          category={viewingCategoryTrend}
          categories={categories}
          transactions={transactions}
          onBack={() => setViewingCategoryTrend(null)}
        />
      ) : categoryDetail ? (
        <CategoryDetail
          category={categoryDetail}
          allCategories={categories}
          transactions={transactions}
          onBack={() => setCategoryDetailId(null)}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onOpenCategory={(c) => setCategoryDetailId(c.id)}
          onChanged={reload}
          onOpenTrend={(c) => setViewingCategoryTrend(c)}
        />
      ) : viewingAccountDetail ? (
        <AccountDetail
          account={viewingAccountDetail}
          categories={categories}
          transactions={transactions}
          onBack={() => setViewingAccountDetail(null)}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onChanged={reload}
        />
      ) : viewingTagDetail ? (
        <TagDetail
          tag={viewingTagDetail}
          categories={categories}
          transactions={transactions}
          onBack={() => setViewingTagDetail(null)}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onViewInTransactions={() => {
            const tag = viewingTagDetail
            setViewingTagDetail(null)
            setPendingTransactionsSearch(`#${tag}`)
            setTab('transactions')
          }}
          onChanged={reload}
          accounts={accounts}
        />
      ) : statDetail ? (
        <TypedTransactions
          kind={statDetail}
          categories={categories}
          transactions={transactions}
          onBack={() => setStatDetail(null)}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onChanged={reload}
          accounts={accounts}
        />
      ) : dateRangeNav ? (
        <PeriodDetail
          title={dateRangeNav.title}
          categories={categories}
          transactions={transactions}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onBack={() => setDateRangeNav(null)}
          start={dateRangeNav.start}
          end={dateRangeNav.end}
          initialCategoryId={dateRangeNav.categoryId}
          onChanged={reload}
        />
      ) : (
        <>
      {tab === 'dashboard' && (
        <Dashboard
          categories={categories}
          transactions={transactions}
          recurring={recurring}
          onOpenCategory={(id) => setCategoryDetailId(id)}
          onOpenStat={(kind) => setStatDetail(kind)}
          onOpenDateRange={(title, start, end) => setDateRangeNav({ title, start, end })}
          onOpenMonthRecap={() => { setReturnTab('dashboard'); setTab('monthlyrecap') }}
          onOpenCategoryBreakdown={() => { setReturnTab('dashboard'); setTab('categorybreakdown') }}
          onOpenImport={(files) => { setPendingImportFiles(files); setReturnTab('dashboard'); setTab('import') }}
          onOpenRecurring={() => setTab('recurring')}
          onOpenTags={() => { setReturnTab('dashboard'); setTab('tags') }}
          accounts={accounts}
          onOpenAccounts={() => { setReturnTab('dashboard'); setTab('accounts') }}
          installmentPlans={installmentPlans}
          onOpenInstallments={() => { setReturnTab('dashboard'); setTab('installments') }}
        />
      )}
      {tab === 'transactions' && (
        <TransactionsPage
          categories={categories}
          transactions={transactions}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onChanged={reload}
          initialSearch={pendingTransactionsSearch ?? undefined}
          onTransactionCreated={maybeOfferCycleCorrection}
          recurring={recurring}
          accounts={accounts}
        />
      )}
      {tab === 'budgets' && <Budgets categories={categories} transactions={transactions} onOpenCategory={(id) => setCategoryDetailId(id)} />}
      {tab === 'more' && (
        <More
          categories={categories}
          onCategoriesChanged={reload}
          onNavigate={(t) => { setReturnTab('more'); setTab(t as Tab) }}
          transactions={transactions}
          accounts={accounts}
          onRestored={catchUpDueItems}
        />
      )}
      {tab === 'recurring' && <RecurringPage categories={categories} transactions={transactions} recurring={recurring} onChanged={reload} onBack={() => setTab('more')} accounts={accounts} />}
      {tab === 'installments' && <InstallmentPlansPage categories={categories} transactions={transactions} installmentPlans={installmentPlans} onChanged={reload} onBack={() => setTab('more')} accounts={accounts} />}
      {tab === 'shopping' && <ShoppingLists lists={shoppingLists} categories={categories} transactions={transactions} onChanged={reload} />}
      {tab === 'duplicates' && <DuplicateCheck transactions={transactions} onChanged={reload} onBack={() => setTab(returnTab)} />}
      {tab === 'health' && (
        <HealthCheck
          transactions={transactions}
          recurring={recurring}
          categories={categories}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onOpenDuplicateCheck={() => { setReturnTab('health'); setTab('duplicates') }}
          onCategoriesChanged={reload}
          onBack={() => setTab('more')}
          accounts={accounts}
        />
      )}
      {tab === 'report' && <CustomRangeReport categories={categories} transactions={transactions} onSave={handleSaveTransaction} onBack={() => setTab('more')} onChanged={reload} accounts={accounts} />}
      {tab === 'merchants' && <MerchantRules categories={categories} onBack={() => setTab('more')} />}
      {tab === 'insights' && <Insights categories={categories} transactions={transactions} accounts={accounts} recurring={recurring} onBack={() => setTab('more')} />}
      {tab === 'tags' && (
        <TagsScreen
          categories={categories}
          transactions={transactions}
          onBack={() => setTab(returnTab)}
          onOpenTag={(tag) => setViewingTagDetail(tag)}
          onChanged={reload}
        />
      )}
      {tab === 'accounts' && (
        <AccountsScreen
          accounts={accounts}
          transactions={transactions}
          onBack={() => setTab('more')}
          onChanged={reload}
          onOpenAccount={(a) => setViewingAccountDetail(a)}
        />
      )}
      {tab === 'categories' && <CategoriesScreen categories={categories} onBack={() => setTab('more')} onChanged={reload} />}
      {tab === 'import' && (
        <StatementImport
          categories={categories}
          existingTransactions={transactions}
          onBack={() => { setPendingImportFiles(null); setTab(returnTab) }}
          onImported={reload}
          initialFiles={pendingImportFiles}
          accounts={accounts}
        />
      )}
      {tab === 'budgetplanner' && <TotalBudgetPlanner categories={categories} transactions={transactions} accounts={accounts} onBack={() => setTab('more')} onChanged={reload} />}
      {tab === 'autobackups' && <AutoBackups onBack={() => setTab('more')} onRestored={async () => { await catchUpDueItems(); await reload() }} />}
      {tab === 'categorybreakdown' && (
        <CategoryBreakdownByMonth
          categories={categories}
          transactions={transactions}
          onBack={() => setTab(returnTab)}
          onOpenPeriod={(title, start, end, categoryId) => setDateRangeNav({ title, start, end, categoryId })}
        />
      )}
      {tab === 'monthlyrecap' && (
        <MonthlyRecapPage
          categories={categories}
          transactions={transactions}
          accounts={accounts}
          onBack={() => setTab(returnTab)}
          onSaveTransaction={handleSaveTransaction}
          onDeleteTransaction={handleDeleteTransaction}
          onOpenCategoryPeriod={(title, start, end, categoryId) => setDateRangeNav({ title, start, end, categoryId })}
          initialMonthOffset={returnTab === 'dashboard' ? 0 : -1}
          onChanged={reload}
        />
      )}

      {(tab === 'recurring' || tab === 'shopping' || tab === 'duplicates' || tab === 'health') && (
        <div className="floating-back-button" style={{ position: 'fixed', bottom: 100, right: 20, maxWidth: 560, margin: '0 auto' }}>
          <button className="round-icon-button" style={{ background: 'var(--surface-3)' }} onClick={() => setTab('more')}>‹</button>
        </div>
      )}
        </>
      )}

      <nav className="tab-bar">
        <button className={`tab-button ${tab === 'dashboard' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setViewingAccountDetail(null); setTab('dashboard') }}>
          <DashboardIcon active={tab === 'dashboard' && !anyOverlay} />
          Dashboard
        </button>
        <button className={`tab-button ${tab === 'transactions' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setViewingAccountDetail(null); setPendingTransactionsSearch(null); setTab('transactions') }}>
          <ListIcon active={tab === 'transactions' && !anyOverlay} />
          Transactions
        </button>
        <button className={`tab-button ${tab === 'budgets' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setViewingAccountDetail(null); setTab('budgets') }}>
          <TargetIcon active={tab === 'budgets' && !anyOverlay} />
          Budgets
        </button>
        <button className={`tab-button ${['more', 'recurring', 'shopping', 'duplicates', 'health', 'report', 'merchants', 'categories', 'import', 'budgetplanner', 'autobackups', 'categorybreakdown', 'monthlyrecap', 'tags'].includes(tab) && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setViewingAccountDetail(null); setTab('more') }}>
          <MoreIcon active={['more', 'recurring', 'shopping', 'duplicates', 'health', 'report', 'merchants', 'categories', 'import', 'budgetplanner', 'autobackups', 'categorybreakdown', 'monthlyrecap', 'tags', 'accounts', 'installments'].includes(tab) && !anyOverlay} />
          More
        </button>
      </nav>

      {cyclePrompt && (
        <div className="modal-backdrop" onClick={() => setCyclePrompt(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Adjust This Cycle?</span>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 16 }}>
                This income landed on <strong>{cyclePrompt.txDateLabel}</strong>, not {cyclePrompt.predictedLabel} where your budget cycle currently expects it to start. Start this cycle from {cyclePrompt.txDateLabel} instead?
              </p>
              <p className="hint" style={{ marginBottom: 16 }}>
                This only adjusts this one cycle — next cycle goes back to predicting automatically.
              </p>
              <button
                onClick={confirmCycleCorrection}
                style={{ width: '100%', padding: '12px', borderRadius: 10, background: 'var(--blue)', color: '#fff', fontWeight: 600, marginBottom: 8 }}
              >
                Yes, start from {cyclePrompt.txDateLabel}
              </button>
              <button onClick={() => setCyclePrompt(null)} className="text-button" style={{ width: '100%', padding: '12px', textAlign: 'center' }}>
                No, keep the prediction
              </button>
            </div>
          </div>
        </div>
      )}

      {paydaySplitPrompt && (
        <div className="modal-backdrop" onClick={() => setPaydaySplitPrompt(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <button onClick={() => setPaydaySplitPrompt(null)} className="text-button">Skip</button>
              <span className="modal-title">Move Money Now?</span>
              <button onClick={confirmPaydaySplit} className="text-button text-button-primary">Transfer</button>
            </div>
            <div className="modal-body">
              <p className="hint" style={{ marginBottom: 16 }}>Pre-filled from last time — adjust or clear any you don't want to send this time.</p>
              {[...paydaySplitPrompt.amounts.entries()].map(([accountId, amountStr]) => {
                const account = accounts.find((a) => a.id === accountId)
                if (!account) return null
                return (
                  <div key={accountId} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <span style={{ flex: 1, fontSize: 14 }}>{account.icon} {account.name}</span>
                    <input
                      type="number" inputMode="decimal" placeholder="0.00"
                      value={amountStr}
                      onChange={(e) => setPaydaySplitPrompt((prev) => prev && { ...prev, amounts: new Map(prev.amounts).set(accountId, e.target.value) })}
                      style={{ width: 110, textAlign: 'right' }}
                    />
                  </div>
                )
              })}
              <p className="hint" style={{ marginTop: 4 }}>
                Leave one at $0 to skip it just this time — it'll still be offered next payday.
              </p>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Total moving</span>
                <span className="amount" style={{ fontWeight: 600 }}>
                  {formatCurrency([...paydaySplitPrompt.amounts.values()].reduce((sum, v) => sum + (parseFloat(v) || 0), 0))}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
