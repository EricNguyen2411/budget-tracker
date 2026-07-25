import { useEffect, useState, useCallback } from 'react'
import type { Category, Transaction, RecurringTransaction, ShoppingList } from './types'
import {
  ensureDefaultCategories, getCategories, getTransactions, createTransaction, saveTransaction, deleteTransaction,
  getRecurring, saveRecurring, getShoppingLists
} from './db'
import { processDueRecurring } from './recurring'
import { getSettings } from './budgetPeriod'
import { checkInAppNudge } from './notifications'
import Dashboard from './pages/Dashboard'
import TransactionsPage from './pages/Transactions'
import Budgets from './pages/Budgets'
import More from './pages/More'
import RecurringPage from './pages/Recurring'
import ShoppingLists from './pages/ShoppingLists'
import DuplicateCheck from './pages/DuplicateCheck'
import HealthCheck from './pages/HealthCheck'
import CategoryDetail from './pages/CategoryDetail'
import { DashboardIcon, ListIcon, TargetIcon, MoreIcon } from './icons'

type Tab = 'dashboard' | 'transactions' | 'budgets' | 'more' | 'recurring' | 'shopping' | 'duplicates' | 'health'

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [categories, setCategories] = useState<Category[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [recurring, setRecurring] = useState<RecurringTransaction[]>([])
  const [shoppingLists, setShoppingLists] = useState<ShoppingList[]>([])
  const [loaded, setLoaded] = useState(false)
  const [categoryDetailId, setCategoryDetailId] = useState<string | null>(null)

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
      const rec = await getRecurring()
      const { newTransactions, updatedRecurring } = processDueRecurring(rec)
      for (const t of newTransactions) await createTransaction(t)
      for (const r of updatedRecurring) await saveRecurring(r)
      await reload()
      setLoaded(true)

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
      ) : (
        <>
      {tab === 'dashboard' && <Dashboard categories={categories} transactions={transactions} onOpenCategory={(id) => setCategoryDetailId(id)} />}
      {tab === 'transactions' && (
        <TransactionsPage
          categories={categories}
          transactions={transactions}
          onSave={handleSaveTransaction}
          onDelete={handleDeleteTransaction}
        />
      )}
      {tab === 'budgets' && <Budgets categories={categories} transactions={transactions} onOpenCategory={(id) => setCategoryDetailId(id)} />}
      {tab === 'more' && (
        <More
          categories={categories}
          onCategoriesChanged={reload}
          onNavigate={(t) => setTab(t as Tab)}
          transactions={transactions}
        />
      )}
      {tab === 'recurring' && <RecurringPage categories={categories} transactions={transactions} recurring={recurring} onChanged={reload} />}
      {tab === 'shopping' && <ShoppingLists lists={shoppingLists} categories={categories} transactions={transactions} onChanged={reload} />}
      {tab === 'duplicates' && <DuplicateCheck transactions={transactions} onChanged={reload} />}
      {tab === 'health' && <HealthCheck transactions={transactions} recurring={recurring} categories={categories} />}

      {(tab === 'recurring' || tab === 'shopping' || tab === 'duplicates' || tab === 'health') && (
        <div style={{ position: 'fixed', bottom: 100, right: 20, maxWidth: 560, margin: '0 auto' }}>
          <button className="round-icon-button" style={{ background: 'var(--surface-3)' }} onClick={() => setTab('more')}>‹</button>
        </div>
      )}
        </>
      )}

      <nav className="tab-bar">
        <button className={`tab-button ${tab === 'dashboard' && !categoryDetail ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setTab('dashboard') }}>
          <DashboardIcon active={tab === 'dashboard' && !categoryDetail} />
          Dashboard
        </button>
        <button className={`tab-button ${tab === 'transactions' && !categoryDetail ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setTab('transactions') }}>
          <ListIcon active={tab === 'transactions' && !categoryDetail} />
          Transactions
        </button>
        <button className={`tab-button ${tab === 'budgets' && !categoryDetail ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setTab('budgets') }}>
          <TargetIcon active={tab === 'budgets' && !categoryDetail} />
          Budgets
        </button>
        <button className={`tab-button ${['more', 'recurring', 'shopping', 'duplicates', 'health'].includes(tab) && !categoryDetail ? 'active' : ''}`} onClick={() => { setCategoryDetailId(null); setTab('more') }}>
          <MoreIcon active={['more', 'recurring', 'shopping', 'duplicates', 'health'].includes(tab) && !categoryDetail} />
          More
        </button>
      </nav>
    </div>
  )
}
