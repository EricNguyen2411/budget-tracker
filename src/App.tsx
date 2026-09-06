import { useEffect, useState, useCallback } from 'react'
import type { Category, Transaction, RecurringTransaction, ShoppingList } from './types'
import {
  ensureDefaultCategories, getCategories, getTransactions, createTransaction, saveTransaction, deleteTransaction,
  getRecurring, saveRecurring, getShoppingLists, performAutoBackupIfNeeded, syncReimbursementCategoriesOnce
} from './db'
import { processDueRecurring } from './recurring'
import { getSettings, isCustomCycle, getCycleConfig, predictedCycleFor, setCycleOverride } from './budgetPeriod'
import { localDateInputValue } from './calculations'
import { checkInAppNudge } from './notifications'
import { useSwipeBack } from './useSwipeBack'
import Dashboard from './pages/Dashboard'
import TransactionsPage from './pages/Transactions'
import Budgets from './pages/Budgets'
import More from './pages/More'
import RecurringPage from './pages/Recurring'
import ShoppingLists from './pages/ShoppingLists'
import DuplicateCheck from './pages/DuplicateCheck'
import HealthCheck from './pages/HealthCheck'
import CategoryDetail from './pages/CategoryDetail'
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
import { DashboardIcon, ListIcon, TargetIcon, MoreIcon } from './icons'

type Tab = 'dashboard' | 'transactions' | 'budgets' | 'more' | 'recurring' | 'shopping' | 'duplicates' | 'health' | 'report' | 'merchants' | 'categories' | 'import' | 'budgetplanner' | 'autobackups' | 'categorybreakdown' | 'monthlyrecap' | 'tags'

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
  const [loaded, setLoaded] = useState(false)
  const [categoryDetailId, setCategoryDetailId] = useState<string | null>(null)
  const [viewingTagDetail, setViewingTagDetail] = useState<string | null>(null)
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

  useSwipeBack(
    () => setTab('more'),
    tab === 'recurring' || tab === 'shopping' || tab === 'duplicates' || tab === 'health'
  )

  const reload = useCallback(async () => {
    const [cats, txs, rec, lists] = await Promise.all([getCategories(), getTransactions(), getRecurring(), getShoppingLists()])
    setCategories(cats)
    setTransactions(txs)
    setRecurring(rec)
    setShoppingLists(lists)
  }, [])

  useEffect(() => {
    async function init() {
      await ensureDefaultCategories()
      await syncReimbursementCategoriesOnce()
      const rec = await getRecurring()
      const { newTransactions, updatedRecurring } = processDueRecurring(rec)
      for (const t of newTransactions) await createTransaction(t)
      for (const r of updatedRecurring) await saveRecurring(r)
      await reload()
      setLoaded(true)
      performAutoBackupIfNeeded()

      const settings = getSettings()
      const txs = await getTransactions()
      const mostRecent = txs[0] ? new Date(txs[0].date) : null
      checkInAppNudge(mostRecent, settings.nudgeEnabled ?? false, 3)
    }
    init()
  }, [reload])

  async function handleSaveTransaction(data: Omit<Transaction, 'id'>, existingId: string | null) {
    if (existingId) {
      await saveTransaction({ ...data, id: existingId })
    } else {
      const created = await createTransaction(data)
      maybeOfferCycleCorrection(created)
    }
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
    await deleteTransaction(id)
    await reload()
  }

  if (!loaded) return null

  const categoryDetail = categoryDetailId ? categories.find((c) => c.id === categoryDetailId) : null
  const anyOverlay = categoryDetail || statDetail || dateRangeNav || viewingTagDetail

  return (
    <div className="app-shell">
      {categoryDetail ? (
        <CategoryDetail
          category={categoryDetail}
          allCategories={categories}
          transactions={transactions}
          onBack={() => setCategoryDetailId(null)}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
          onOpenCategory={(c) => setCategoryDetailId(c.id)}
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
        />
      )}
      {tab === 'budgets' && <Budgets categories={categories} transactions={transactions} onOpenCategory={(id) => setCategoryDetailId(id)} />}
      {tab === 'more' && (
        <More
          categories={categories}
          onCategoriesChanged={reload}
          onNavigate={(t) => { setReturnTab('more'); setTab(t as Tab) }}
          transactions={transactions}
        />
      )}
      {tab === 'recurring' && <RecurringPage categories={categories} transactions={transactions} recurring={recurring} onChanged={reload} onBack={() => setTab('more')} />}
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
        />
      )}
      {tab === 'report' && <CustomRangeReport categories={categories} transactions={transactions} onSave={handleSaveTransaction} onBack={() => setTab('more')} onChanged={reload} />}
      {tab === 'merchants' && <MerchantRules categories={categories} onBack={() => setTab('more')} />}
      {tab === 'tags' && (
        <TagsScreen
          categories={categories}
          transactions={transactions}
          onBack={() => setTab(returnTab)}
          onOpenTag={(tag) => setViewingTagDetail(tag)}
          onChanged={reload}
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
        />
      )}
      {tab === 'budgetplanner' && <TotalBudgetPlanner categories={categories} transactions={transactions} onBack={() => setTab('more')} onChanged={reload} />}
      {tab === 'autobackups' && <AutoBackups onBack={() => setTab('more')} onRestored={reload} />}
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
        <button className={`tab-button ${tab === 'dashboard' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setTab('dashboard') }}>
          <DashboardIcon active={tab === 'dashboard' && !anyOverlay} />
          Dashboard
        </button>
        <button className={`tab-button ${tab === 'transactions' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setPendingTransactionsSearch(null); setTab('transactions') }}>
          <ListIcon active={tab === 'transactions' && !anyOverlay} />
          Transactions
        </button>
        <button className={`tab-button ${tab === 'budgets' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setTab('budgets') }}>
          <TargetIcon active={tab === 'budgets' && !anyOverlay} />
          Budgets
        </button>
        <button className={`tab-button ${['more', 'recurring', 'shopping', 'duplicates', 'health', 'report', 'merchants', 'categories', 'import', 'budgetplanner', 'autobackups', 'categorybreakdown', 'monthlyrecap', 'tags'].includes(tab) && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setViewingTagDetail(null); setTab('more') }}>
          <MoreIcon active={['more', 'recurring', 'shopping', 'duplicates', 'health', 'report', 'merchants', 'categories', 'import', 'budgetplanner', 'autobackups', 'categorybreakdown', 'monthlyrecap', 'tags'].includes(tab) && !anyOverlay} />
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
    </div>
  )
}
