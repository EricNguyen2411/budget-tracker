import { useEffect, useState, useCallback } from 'react'
import type { Category, Transaction, RecurringTransaction, ShoppingList } from './types'
import {
  ensureDefaultCategories, getCategories, getTransactions, createTransaction, saveTransaction, deleteTransaction,
  getRecurring, saveRecurring, getShoppingLists, performAutoBackupIfNeeded, syncReimbursementCategoriesOnce
} from './db'
import { processDueRecurring } from './recurring'
import { getSettings } from './budgetPeriod'
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
  const [statDetail, setStatDetail] = useState<StatKind | null>(null)
  const [dateRangeNav, setDateRangeNav] = useState<{ title: string; start: string; end: string; categoryId?: string } | null>(null)

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
      await createTransaction(data)
    }
    await reload()
  }

  async function handleDeleteTransaction(id: string) {
    await deleteTransaction(id)
    await reload()
  }

  if (!loaded) return null

  const categoryDetail = categoryDetailId ? categories.find((c) => c.id === categoryDetailId) : null
  const anyOverlay = categoryDetail || statDetail || dateRangeNav

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
        />
      ) : statDetail ? (
        <TypedTransactions
          kind={statDetail}
          categories={categories}
          transactions={transactions}
          onBack={() => setStatDetail(null)}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
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
          onChanged={reload}
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
      {tab === 'report' && <CustomRangeReport categories={categories} transactions={transactions} onSave={handleSaveTransaction} onBack={() => setTab('more')} />}
      {tab === 'merchants' && <MerchantRules categories={categories} onBack={() => setTab('more')} />}
      {tab === 'tags' && (
        <TagsScreen
          categories={categories}
          transactions={transactions}
          onBack={() => setTab(returnTab)}
          onOpenTag={(tag) => { setPendingTransactionsSearch(`#${tag}`); setTab('transactions') }}
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
        />
      )}

      {(tab === 'recurring' || tab === 'shopping' || tab === 'duplicates' || tab === 'health') && (
        <div style={{ position: 'fixed', bottom: 100, right: 20, maxWidth: 560, margin: '0 auto' }}>
          <button className="round-icon-button" style={{ background: 'var(--surface-3)' }} onClick={() => setTab('more')}>‹</button>
        </div>
      )}
        </>
      )}

      <nav className="tab-bar">
        <button className={`tab-button ${tab === 'dashboard' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setTab('dashboard') }}>
          <DashboardIcon active={tab === 'dashboard' && !anyOverlay} />
          Dashboard
        </button>
        <button className={`tab-button ${tab === 'transactions' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setPendingTransactionsSearch(null); setTab('transactions') }}>
          <ListIcon active={tab === 'transactions' && !anyOverlay} />
          Transactions
        </button>
        <button className={`tab-button ${tab === 'budgets' && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setTab('budgets') }}>
          <TargetIcon active={tab === 'budgets' && !anyOverlay} />
          Budgets
        </button>
        <button className={`tab-button ${['more', 'recurring', 'shopping', 'duplicates', 'health', 'report', 'merchants', 'categories', 'import', 'budgetplanner', 'autobackups', 'categorybreakdown', 'monthlyrecap', 'tags'].includes(tab) && !anyOverlay ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setStatDetail(null); setDateRangeNav(null); setTab('more') }}>
          <MoreIcon active={['more', 'recurring', 'shopping', 'duplicates', 'health', 'report', 'merchants', 'categories', 'import', 'budgetplanner', 'autobackups', 'categorybreakdown', 'monthlyrecap', 'tags'].includes(tab) && !anyOverlay} />
          More
        </button>
      </nav>
    </div>
  )
}
