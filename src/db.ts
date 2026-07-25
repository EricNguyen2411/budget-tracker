import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Category, Transaction, RecurringTransaction, ShoppingList } from './types'
import { DEFAULT_CATEGORIES } from './types'
import { isNativeBackupFormat, translateNativeBackup } from './nativeImport'
import { learnMerchant } from './merchantRules'

interface AutoBackupEntry {
  id: string
  createdAt: string
  json: string
}

interface BudgetDB extends DBSchema {
  categories: { key: string; value: Category }
  transactions: { key: string; value: Transaction; indexes: { 'by-date': string } }
  recurring: { key: string; value: RecurringTransaction }
  shoppingLists: { key: string; value: ShoppingList }
  autoBackups: { key: string; value: AutoBackupEntry }
}

let dbPromise: Promise<IDBPDatabase<BudgetDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<BudgetDB>('budget-tracker', 3, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore('categories', { keyPath: 'id' })
          const txStore = db.createObjectStore('transactions', { keyPath: 'id' })
          txStore.createIndex('by-date', 'date')
        }
        if (oldVersion < 2) {
          db.createObjectStore('recurring', { keyPath: 'id' })
          db.createObjectStore('shoppingLists', { keyPath: 'id' })
        }
        if (oldVersion < 3) {
          db.createObjectStore('autoBackups', { keyPath: 'id' })
        }
      }
    })
  }
  return dbPromise
}

function uuid() {
  return crypto.randomUUID()
}

export async function ensureDefaultCategories() {
  const db = await getDB()
  const existing = await db.count('categories')
  if (existing > 0) return
  const tx = db.transaction('categories', 'readwrite')
  for (const def of DEFAULT_CATEGORIES) {
    await tx.store.put({ ...def, id: uuid() })
  }
  await tx.done
}

export async function getCategories(): Promise<Category[]> {
  const db = await getDB()
  const all = await db.getAll('categories')
  return all.sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function saveCategory(category: Category) {
  const db = await getDB()
  await db.put('categories', category)
}

export async function createCategory(data: Omit<Category, 'id'>): Promise<Category> {
  const db = await getDB()
  const category: Category = { ...data, id: uuid() }
  await db.put('categories', category)
  return category
}

export async function deleteCategory(id: string) {
  const db = await getDB()
  await db.delete('categories', id)
}

export async function getTransactions(): Promise<Transaction[]> {
  const db = await getDB()
  const all = await db.getAllFromIndex('transactions', 'by-date')
  return all.reverse() // newest first
}

export async function createTransaction(data: Omit<Transaction, 'id'>): Promise<Transaction> {
  const db = await getDB()
  const transaction: Transaction = { ...data, id: uuid() }
  await db.put('transactions', transaction)
  return transaction
}

export async function saveTransaction(transaction: Transaction) {
  const db = await getDB()
  await db.put('transactions', transaction)
}

export async function deleteTransaction(id: string) {
  const db = await getDB()
  await db.delete('transactions', id)
}

export async function getRecurring(): Promise<RecurringTransaction[]> {
  const db = await getDB()
  return db.getAll('recurring')
}

export async function saveRecurring(item: RecurringTransaction) {
  const db = await getDB()
  await db.put('recurring', item)
}

export async function createRecurring(data: Omit<RecurringTransaction, 'id'>): Promise<RecurringTransaction> {
  const db = await getDB()
  const item: RecurringTransaction = { ...data, id: uuid() }
  await db.put('recurring', item)
  return item
}

export async function deleteRecurring(id: string) {
  const db = await getDB()
  await db.delete('recurring', id)
}

export async function getShoppingLists(): Promise<ShoppingList[]> {
  const db = await getDB()
  return db.getAll('shoppingLists')
}

export async function saveShoppingList(list: ShoppingList) {
  const db = await getDB()
  await db.put('shoppingLists', list)
}

export async function createShoppingList(data: Omit<ShoppingList, 'id'>): Promise<ShoppingList> {
  const db = await getDB()
  const list: ShoppingList = { ...data, id: uuid() }
  await db.put('shoppingLists', list)
  return list
}

export async function deleteShoppingList(id: string) {
  const db = await getDB()
  await db.delete('shoppingLists', id)
}

export function newId() {
  return uuid()
}

export async function exportBackup(): Promise<string> {
  const db = await getDB()
  const categories = await db.getAll('categories')
  const transactions = await db.getAll('transactions')
  const recurring = await db.getAll('recurring')
  const shoppingLists = await db.getAll('shoppingLists')
  return JSON.stringify({ formatVersion: 2, exportedAt: new Date().toISOString(), categories, transactions, recurring, shoppingLists }, null, 2)
}

export async function importBackup(json: string): Promise<{ categoriesCount: number; transactionsCount: number }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('That file isn\u2019t valid JSON — make sure you selected the right backup file.')
  }

  let categories: Category[]
  let transactions: Transaction[]
  let recurring: RecurringTransaction[] = []
  let shoppingLists: ShoppingList[] = []
  let merchantRulesToImport: { key: string; categoryId: string }[] = []

  if (isNativeBackupFormat(parsed)) {
    const translated = translateNativeBackup(parsed)
    categories = translated.categories
    transactions = translated.transactions
    recurring = translated.recurring
    shoppingLists = translated.shoppingLists
    merchantRulesToImport = translated.merchantRules
  } else {
    const data = parsed as {
      categories?: Category[]
      transactions?: Transaction[]
      recurring?: RecurringTransaction[]
      shoppingLists?: ShoppingList[]
    }
    if (!Array.isArray(data.categories) || !Array.isArray(data.transactions)) {
      throw new Error('That doesn\u2019t look like a Budget Tracker backup file — missing categories or transactions.')
    }
    categories = data.categories
    transactions = data.transactions
    recurring = data.recurring ?? []
    shoppingLists = data.shoppingLists ?? []
  }

  const db = await getDB()
  const tx = db.transaction(['categories', 'transactions', 'recurring', 'shoppingLists'], 'readwrite')
  for (const c of categories) await tx.objectStore('categories').put(c)
  for (const t of transactions) await tx.objectStore('transactions').put(t)
  for (const r of recurring) await tx.objectStore('recurring').put(r)
  for (const s of shoppingLists) await tx.objectStore('shoppingLists').put(s)
  await tx.done

  for (const rule of merchantRulesToImport) {
    learnMerchant(rule.key, rule.categoryId)
  }

  return { categoriesCount: categories.length, transactionsCount: transactions.length }
}

const AUTO_BACKUP_INTERVAL_HOURS = 12
const MAX_AUTO_BACKUPS = 5
const LAST_AUTO_BACKUP_KEY = 'budget-tracker-last-auto-backup'

/**
 * Local, automatic snapshots — a safety net against accidental deletion
 * or a bad edit, taken periodically without you having to remember.
 *
 * Important honest limitation: these snapshots live in the SAME
 * IndexedDB database as your live data, not somewhere separate. If iOS
 * ever evicts this site's storage (the real risk this app has had since
 * day one, being a PWA rather than a native app), the auto-backups are
 * wiped right alongside everything else — this protects against
 * accidental deletion or a bad edit, not against that specific platform
 * risk. Only an actual exported file, saved outside the browser (Files,
 * email), survives that. Auto-backup doesn't replace doing that
 * periodically — it's a second layer, not a substitute.
 */
export async function performAutoBackupIfNeeded(): Promise<void> {
  const lastRun = localStorage.getItem(LAST_AUTO_BACKUP_KEY)
  if (lastRun) {
    const hoursSince = (Date.now() - new Date(lastRun).getTime()) / (1000 * 60 * 60)
    if (hoursSince < AUTO_BACKUP_INTERVAL_HOURS) return
  }

  const json = await exportBackup()
  const db = await getDB()
  const entry: AutoBackupEntry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), json }
  await db.put('autoBackups', entry)

  const all = await db.getAll('autoBackups')
  if (all.length > MAX_AUTO_BACKUPS) {
    const sorted = all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const old of sorted.slice(0, all.length - MAX_AUTO_BACKUPS)) {
      await db.delete('autoBackups', old.id)
    }
  }

  localStorage.setItem(LAST_AUTO_BACKUP_KEY, new Date().toISOString())
}

export async function listAutoBackups(): Promise<AutoBackupEntry[]> {
  const db = await getDB()
  const all = await db.getAll('autoBackups')
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function restoreAutoBackup(id: string): Promise<{ categoriesCount: number; transactionsCount: number }> {
  const db = await getDB()
  const entry = await db.get('autoBackups', id)
  if (!entry) throw new Error('That backup could no longer be found.')
  return importBackup(entry.json)
}

const LAST_MANUAL_BACKUP_KEY = 'budget-tracker-last-manual-backup'

export function recordManualBackup() {
  localStorage.setItem(LAST_MANUAL_BACKUP_KEY, new Date().toISOString())
}

export function daysSinceLastManualBackup(): number | null {
  const last = localStorage.getItem(LAST_MANUAL_BACKUP_KEY)
  if (!last) return null
  return Math.floor((Date.now() - new Date(last).getTime()) / (1000 * 60 * 60 * 24))
}

export function exportCSV(transactions: Transaction[], categories: Category[]): string {
  const catById = new Map(categories.map((c) => [c.id, c.name]))
  const header = 'Date,Note,Category,Type,Amount\n'
  const rows = transactions.map((t) => {
    const date = new Date(t.date).toISOString().slice(0, 10)
    const note = `"${t.note.replace(/"/g, '""')}"`
    const category = catById.get(t.categoryId ?? '') ?? 'Uncategorized'
    const type = t.isExpense ? 'Expense' : 'Income'
    return `${date},${note},${category},${type},${t.amount.toFixed(2)}`
  })
  return header + rows.join('\n')
}
