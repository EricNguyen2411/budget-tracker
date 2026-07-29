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
  const tx = db.transaction(['categories', 'transactions', 'recurring', 'shoppingLists'], 'readwrite')

  await tx.objectStore('categories').delete(id)

  // Clear the reference on anything that pointed to it, rather than
  // leaving a dangling categoryId pointing at a category that no longer
  // exists — display code falls back to "Uncategorized" either way, but
  // an explicit null is the correct state, not a stale id that happens
  // to render the same.
  const transactions = await tx.objectStore('transactions').getAll()
  for (const t of transactions) {
    if (t.categoryId === id) await tx.objectStore('transactions').put({ ...t, categoryId: null })
  }
  const recurring = await tx.objectStore('recurring').getAll()
  for (const r of recurring) {
    if (r.categoryId === id) await tx.objectStore('recurring').put({ ...r, categoryId: null })
  }
  const shoppingLists = await tx.objectStore('shoppingLists').getAll()
  for (const s of shoppingLists) {
    if (s.categoryId === id) await tx.objectStore('shoppingLists').put({ ...s, categoryId: null })
  }

  await tx.done
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

  // Reconcile incoming categories against what already exists, by name
  // (case-insensitive) rather than ID — IDs from an import are always
  // freshly generated and can never match what's already in your data,
  // so without this, re-importing (or importing after the default
  // categories were auto-seeded on first launch) creates a duplicate
  // for every category that happens to share a name, like "Dining Out"
  // ending up twice — one empty, one with your real subcategories.
  const existingCategories = await db.getAll('categories')
  const existingTopByName = new Map(existingCategories.filter((c) => !c.parentId).map((c) => [c.name.toLowerCase(), c]))

  const idRemap = new Map<string, string>() // incoming id -> id actually used
  const categoriesToWrite: Category[] = []

  const incomingTop = categories.filter((c) => !c.parentId)
  const incomingSub = categories.filter((c) => c.parentId)

  for (const c of incomingTop) {
    const existing = existingTopByName.get(c.name.toLowerCase())
    if (existing) {
      idRemap.set(c.id, existing.id)
      // Keep the existing category as-is (its own budget/color/etc. —
      // don't overwrite settings you may have already configured), but
      // if the existing one has no budget set and the incoming one
      // does, that's worth carrying over rather than discarding.
      if (existing.monthlyBudget === 0 && c.monthlyBudget > 0) {
        categoriesToWrite.push({ ...existing, monthlyBudget: c.monthlyBudget })
      }
    } else {
      categoriesToWrite.push(c)
    }
  }

  const existingSubByParentAndName = new Map(
    existingCategories.filter((c) => c.parentId).map((c) => [`${c.parentId}::${c.name.toLowerCase()}`, c])
  )
  for (const c of incomingSub) {
    const resolvedParentId = idRemap.get(c.parentId!) ?? c.parentId!
    const key = `${resolvedParentId}::${c.name.toLowerCase()}`
    const existing = existingSubByParentAndName.get(key)
    if (existing) {
      idRemap.set(c.id, existing.id)
    } else {
      categoriesToWrite.push({ ...c, parentId: resolvedParentId })
    }
  }

  function remapCategoryId(id: string | null): string | null {
    if (!id) return null
    return idRemap.get(id) ?? id
  }

  const transactionsToWrite = transactions.map((t) => ({ ...t, categoryId: remapCategoryId(t.categoryId) }))
  const recurringToWrite = recurring.map((r) => ({ ...r, categoryId: remapCategoryId(r.categoryId) }))
  const shoppingListsToWrite = shoppingLists.map((s) => ({ ...s, categoryId: remapCategoryId(s.categoryId) }))

  const tx = db.transaction(['categories', 'transactions', 'recurring', 'shoppingLists'], 'readwrite')
  for (const c of categoriesToWrite) await tx.objectStore('categories').put(c)
  for (const t of transactionsToWrite) await tx.objectStore('transactions').put(t)
  for (const r of recurringToWrite) await tx.objectStore('recurring').put(r)
  for (const s of shoppingListsToWrite) await tx.objectStore('shoppingLists').put(s)
  await tx.done

  for (const rule of merchantRulesToImport) {
    learnMerchant(rule.key, remapCategoryId(rule.categoryId))
  }

  return { categoriesCount: categoriesToWrite.length, transactionsCount: transactionsToWrite.length }
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

const REIMBURSEMENT_CATEGORY_SYNC_KEY = 'budget-tracker-reimbursement-category-sync-done'

/** One-time fix: every existing reimbursement transaction gets its
 * category updated to match the expense it repays — matching the rule
 * new reimbursements follow automatically going forward. Runs once
 * (tracked via localStorage) rather than every launch, so it doesn't
 * keep re-overwriting a category you might deliberately change later. */
export async function syncReimbursementCategoriesOnce(): Promise<number> {
  if (localStorage.getItem(REIMBURSEMENT_CATEGORY_SYNC_KEY)) return 0

  const db = await getDB()
  const all = await db.getAll('transactions')
  const byId = new Map(all.map((t) => [t.id, t]))
  let updated = 0

  const tx = db.transaction('transactions', 'readwrite')
  for (const t of all) {
    if (t.isExpense || !t.reimbursesExpenseId) continue
    const expense = byId.get(t.reimbursesExpenseId)
    if (!expense || !expense.categoryId) continue
    if (t.categoryId === expense.categoryId) continue
    await tx.store.put({ ...t, categoryId: expense.categoryId })
    updated++
  }
  await tx.done

  localStorage.setItem(REIMBURSEMENT_CATEGORY_SYNC_KEY, 'true')
  return updated
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
