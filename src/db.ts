import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import type { Category, Transaction, RecurringTransaction, ShoppingList, Account, InstallmentPlan } from './types'
import { DEFAULT_CATEGORIES } from './types'
import { isNativeBackupFormat, translateNativeBackup } from './nativeImport'
import { learnMerchant, removeCategoryFromMerchantRules, mergeCategoryInMerchantRules } from './merchantRules'
import { getSettings, updateSettings } from './budgetPeriod'
import { getImportAccountMapping, saveImportAccountMapping } from './importSettings'
import { goalProgress } from './calculations'
import { normalizeTag, dedupeTags } from './tags'
import { localDateInputValue } from './calculations'

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
  accounts: { key: string; value: Account }
  installmentPlans: { key: string; value: InstallmentPlan }
}

let dbPromise: Promise<IDBPDatabase<BudgetDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<BudgetDB>('budget-tracker', 6, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
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
        if (oldVersion < 4) {
          // Every transaction saved before tags existed is missing the
          // field entirely at runtime (IndexedDB doesn't enforce the TS
          // type) — backfill it explicitly here rather than relying on
          // `t.tags ?? []` guards scattered everywhere, so a stray spot
          // that forgets the guard doesn't silently crash on old data.
          await migrateMissingTags(transaction)
        }
        if (oldVersion < 5) {
          db.createObjectStore('accounts', { keyPath: 'id' })
          // Same reasoning as the tags backfill above — every
          // transaction saved before accounts existed is missing
          // accountId entirely at runtime, not just "null" as the type
          // would suggest.
          await migrateMissingAccountId(transaction)
        }
        if (oldVersion < 6) {
          db.createObjectStore('installmentPlans', { keyPath: 'id' })
          // installmentPlanId is optional on Transaction (unlike
          // accountId), so no backfill migration needed here — a
          // missing field and an explicit null read identically
          // everywhere this gets checked.
        }
      }
    })
  }
  return dbPromise
}

async function migrateMissingTags(transaction: IDBPTransaction<BudgetDB, StoreNames<BudgetDB>[], 'versionchange'>) {
  const store = transaction.objectStore('transactions')
  let cursor = await store.openCursor()
  while (cursor) {
    if (!Array.isArray((cursor.value as Transaction).tags)) {
      await cursor.update({ ...cursor.value, tags: [] })
    }
    cursor = await cursor.continue()
  }
}

async function migrateMissingAccountId(transaction: IDBPTransaction<BudgetDB, StoreNames<BudgetDB>[], 'versionchange'>) {
  const store = transaction.objectStore('transactions')
  let cursor = await store.openCursor()
  while (cursor) {
    const raw = cursor.value as unknown as Record<string, unknown>
    if (!('accountId' in raw)) {
      await cursor.update({ ...(cursor.value as Transaction), accountId: null })
    }
    cursor = await cursor.continue()
  }
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

/** Rolls a recurring annual goal (insurance, car registration, etc.)
 * into its next cycle — advances the target date by a year and resets
 * the start date to now, so progress tracking for goalProgress begins
 * fresh rather than still counting last year's contributions toward
 * this year's target. Deliberately a one-tap action the person
 * triggers, not silent — the premium may have changed, and they should
 * see that happen rather than have it quietly roll over unnoticed. */
export async function renewRecurringGoal(category: Category): Promise<Category> {
  if (!category.goalTargetDate) return category
  const oldTarget = new Date(category.goalTargetDate)
  const newTarget = new Date(oldTarget.getFullYear() + 1, oldTarget.getMonth(), oldTarget.getDate())
  const updated: Category = {
    ...category,
    goalTargetDate: newTarget.toISOString(),
    goalStartDate: new Date().toISOString()
  }
  await saveCategory(updated)
  return updated
}

export async function createCategory(data: Omit<Category, 'id'>): Promise<Category> {
  const db = await getDB()
  const category: Category = { ...data, id: uuid() }
  await db.put('categories', category)
  return category
}

export async function deleteCategory(id: string) {
  const db = await getDB()
  const tx = db.transaction(['categories', 'transactions', 'recurring', 'shoppingLists', 'installmentPlans'], 'readwrite')

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
  const plans = await tx.objectStore('installmentPlans').getAll()
  for (const p of plans) {
    if (p.categoryId === id) await tx.objectStore('installmentPlans').put({ ...p, categoryId: null })
  }

  await tx.done
  removeCategoryFromMerchantRules(id)
}

/** Reassigns every transaction, recurring item, and shopping list
 * pointing at sourceId to targetId instead, then deletes the (now
 * empty) source category — for merging a genuine duplicate into the
 * category you're keeping, rather than losing the categorization
 * entirely the way a plain delete does. */
export async function mergeCategoryInto(sourceId: string, targetId: string): Promise<{ movedCount: number }> {
  const db = await getDB()
  const tx = db.transaction(['categories', 'transactions', 'recurring', 'shoppingLists', 'installmentPlans'], 'readwrite')

  let movedCount = 0
  const transactions = await tx.objectStore('transactions').getAll()
  for (const t of transactions) {
    if (t.categoryId === sourceId) {
      await tx.objectStore('transactions').put({ ...t, categoryId: targetId })
      movedCount++
    }
  }
  const recurring = await tx.objectStore('recurring').getAll()
  for (const r of recurring) {
    if (r.categoryId === sourceId) await tx.objectStore('recurring').put({ ...r, categoryId: targetId })
  }
  const shoppingLists = await tx.objectStore('shoppingLists').getAll()
  for (const s of shoppingLists) {
    if (s.categoryId === sourceId) await tx.objectStore('shoppingLists').put({ ...s, categoryId: targetId })
  }
  const plans = await tx.objectStore('installmentPlans').getAll()
  for (const p of plans) {
    if (p.categoryId === sourceId) await tx.objectStore('installmentPlans').put({ ...p, categoryId: targetId })
  }

  await tx.objectStore('categories').delete(sourceId)
  await tx.done
  mergeCategoryInMerchantRules(sourceId, targetId)

  return { movedCount }
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

/** Deleting a transaction that other transactions are linked to via
 * reimbursesExpenseId (a friend's repayment, or a Fund From Savings
 * withdrawal) would otherwise leave those links pointing at nothing —
 * confirmed directly this makes the linked amount vanish from every
 * dashboard total entirely, not just stop being "reimbursed": an
 * orphaned link is neither unlinked income (it still has
 * reimbursesExpenseId set) nor a valid reimbursement (the expense it
 * points to no longer exists), so it contributes zero to Income AND
 * zero to Reimbursed — real money that's still sitting in the database
 * just disappears from view. Clearing the stale link is the safe
 * choice: it keeps the transaction and its dollar value, correctly
 * re-counting it as ordinary unlinked income instead of losing it. */
export async function deleteTransaction(id: string) {
  const db = await getDB()
  const orphaned = (await db.getAll('transactions')).filter((t) => t.reimbursesExpenseId === id)
  for (const t of orphaned) {
    await db.put('transactions', { ...t, reimbursesExpenseId: null })
  }
  await db.delete('transactions', id)
}

/** Renames a tag across every transaction that has it. If `newTag`
 * already matches an existing different tag on some of those
 * transactions, this doubles as a merge — dedupeTags collapses the two
 * into one rather than leaving a duplicate. Returns how many
 * transactions were actually touched, so the UI can report something
 * more concrete than "done." */
export async function renameTag(oldTag: string, newTag: string): Promise<number> {
  const from = normalizeTag(oldTag)
  const to = normalizeTag(newTag)
  if (!from || !to || from === to) return 0

  const db = await getDB()
  const all = await db.getAll('transactions')
  let count = 0
  for (const t of all) {
    if (!t.tags.some((tag) => normalizeTag(tag) === from)) continue
    const updatedTags = dedupeTags(t.tags.map((tag) => (normalizeTag(tag) === from ? to : tag)))
    await db.put('transactions', { ...t, tags: updatedTags })
    count++
  }
  return count
}

/** Removes a tag from every transaction that has it — the transactions
 * themselves aren't touched otherwise, only the tag association. */
export async function deleteTagEverywhere(tag: string): Promise<number> {
  const target = normalizeTag(tag)
  if (!target) return 0

  const db = await getDB()
  const all = await db.getAll('transactions')
  let count = 0
  for (const t of all) {
    if (!t.tags.some((tg) => normalizeTag(tg) === target)) continue
    await db.put('transactions', { ...t, tags: t.tags.filter((tg) => normalizeTag(tg) !== target) })
    count++
  }
  return count
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

export async function getAccounts(): Promise<Account[]> {
  const db = await getDB()
  const all = await db.getAll('accounts')
  return all.filter((a) => !a.isArchived).sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function getAllAccountsIncludingArchived(): Promise<Account[]> {
  const db = await getDB()
  const all = await db.getAll('accounts')
  return all.sort((a, b) => a.sortOrder - b.sortOrder)
}

export async function saveAccount(account: Account) {
  const db = await getDB()
  await db.put('accounts', account)
}

export async function createAccount(data: Omit<Account, 'id'>): Promise<Account> {
  const db = await getDB()
  const account: Account = { ...data, id: uuid() }
  await db.put('accounts', account)
  return account
}

/** Moves a savings category's tracking over to a real account, rather
 * than trying to replay every historical contribution and withdrawal
 * as account transfers — which would require knowing which real
 * account each one actually came from, information that was never
 * recorded and can't be honestly reconstructed now. Instead takes an
 * honest snapshot: the category's current balance (contributions minus
 * what's already been drawn down) becomes the new account's opening
 * balance, so the account starts at exactly the right number without
 * fabricating a transaction history that didn't happen.
 *
 * The category itself is never deleted or have its history touched —
 * every past transaction, and everything already shown on tag
 * breakdowns and category detail screens, stays exactly as it was.
 * Only isSavingsCategory is turned off, so Fund From Savings and the
 * dashboard's savings widget stop offering it as an active source going
 * forward — the person is expected to use the new account for that
 * from here on. */
export async function migrateCategoryToAccount(categoryId: string, accountData: Omit<Account, 'id' | 'openingBalance' | 'openingDate'>): Promise<Account> {
  const db = await getDB()
  const tx = db.transaction(['categories', 'accounts', 'transactions'], 'readwrite')

  const category = await tx.objectStore('categories').get(categoryId)
  if (!category) throw new Error('Category not found')
  const allTransactions = await tx.objectStore('transactions').getAll()
  const currentBalance = goalProgress(category, allTransactions)

  const account: Account = {
    ...accountData,
    id: uuid(),
    openingBalance: Math.round(currentBalance * 100) / 100,
    openingDate: new Date().toISOString()
  }
  await tx.objectStore('accounts').put(account)
  // needWantType defaults to 'want' here too — once isSavingsCategory
  // turns off, this category looks like any other regular spending
  // category to the rest of the app, and one with no Need/Want set
  // shows an "⚠️ Not set" warning on the categories list. Not
  // technically wrong (the field genuinely is unset), but confusing
  // for a category that isn't actually a spending category needing
  // that classification — it's just dormant now, not incomplete.
  await tx.objectStore('categories').put({ ...category, isSavingsCategory: false, needWantType: category.needWantType ?? 'want' })

  await tx.done
  return account
}

/** Moving money between two of the person's own tracked accounts —
 * paying off a credit card from a bank account, moving savings into
 * everyday spending, etc. Creates both halves as a single atomic write
 * (one succeeds, both do) rather than two separate createTransaction
 * calls, so a failure partway through can't leave one side of a
 * transfer existing without its pair.
 *
 * Deliberately reuses reimbursesExpenseId as the link between the two
 * halves — the exact same mechanism Fund From Savings already uses —
 * rather than a new field: it means a transfer automatically gets the
 * same safe-deletion handling (deleteTransaction already clears a
 * stale reimbursesExpenseId rather than orphaning it) and is already
 * excluded from the Income stat (computeDashboardTotals's unlinkedIncome
 * explicitly excludes anything with reimbursesExpenseId set) with zero
 * new calculation code needed. isAccountTransferLink in calculations.ts
 * is what later recognizes this pattern to label it "transferred" rather
 * than the generic "reimbursed" — both sides having a different
 * accountId is the signal, which is exactly what's set here. */
export async function createTransfer(params: {
  fromAccountId: string
  toAccountId: string
  amount: number
  date: string
  note?: string
}): Promise<{ expense: Transaction; income: Transaction }> {
  const { fromAccountId, toAccountId, amount, date, note } = params
  const db = await getDB()
  const accounts = await db.getAll('accounts')
  const fromAccount = accounts.find((a) => a.id === fromAccountId)
  const toAccount = accounts.find((a) => a.id === toAccountId)

  const expenseId = uuid()
  const expense: Transaction = {
    id: expenseId,
    amount,
    note: note?.trim() || `Transfer to ${toAccount?.name ?? 'another account'}`,
    date,
    isExpense: true,
    categoryId: null,
    reimbursesExpenseId: null,
    tags: [],
    accountId: fromAccountId
  }
  const income: Transaction = {
    id: uuid(),
    amount,
    note: note?.trim() || `Transfer from ${fromAccount?.name ?? 'another account'}`,
    date,
    isExpense: false,
    categoryId: null,
    reimbursesExpenseId: expenseId,
    tags: [],
    accountId: toAccountId
  }

  const tx = db.transaction('transactions', 'readwrite')
  await tx.store.put(expense)
  await tx.store.put(income)
  await tx.done

  return { expense, income }
}

/** Updates both halves of an existing transfer together, preserving
 * their ids and their link to each other — the whole point being that
 * a transfer is edited as one thing, so a corrected amount (or a
 * changed From/To account) can't end up applied to only one side while
 * the other silently keeps the old, now-wrong value. */
export async function updateTransfer(
  expenseId: string,
  incomeId: string,
  params: { fromAccountId: string; toAccountId: string; amount: number; date: string; note?: string }
): Promise<{ expense: Transaction; income: Transaction }> {
  const { fromAccountId, toAccountId, amount, date, note } = params
  const db = await getDB()
  const [existingExpense, existingIncome, accounts] = await Promise.all([
    db.get('transactions', expenseId),
    db.get('transactions', incomeId),
    db.getAll('accounts')
  ])
  if (!existingExpense || !existingIncome) throw new Error('That transfer could no longer be found.')
  const fromAccount = accounts.find((a) => a.id === fromAccountId)
  const toAccount = accounts.find((a) => a.id === toAccountId)

  const expense: Transaction = {
    ...existingExpense,
    amount,
    date,
    accountId: fromAccountId,
    note: note?.trim() || `Transfer to ${toAccount?.name ?? 'another account'}`
  }
  const income: Transaction = {
    ...existingIncome,
    amount,
    date,
    accountId: toAccountId,
    note: note?.trim() || `Transfer from ${fromAccount?.name ?? 'another account'}`
  }

  const tx = db.transaction('transactions', 'readwrite')
  await tx.store.put(expense)
  await tx.store.put(income)
  await tx.done

  return { expense, income }
}

/** Deletes both halves of a transfer together — the safe-unlink
 * behaviour in deleteTransaction handles a single side being removed
 * without crashing or losing money from view, but a transfer someone
 * is deliberately removing should disappear from both accounts, not
 * leave a stray half sitting in one of them looking like a real,
 * unrelated transaction. */
export async function deleteTransfer(expenseId: string, incomeId: string) {
  const db = await getDB()
  const tx = db.transaction('transactions', 'readwrite')
  // Same orphan-safety as deleteTransaction — if anything else somehow
  // ended up linked to either half (an edge case, but not an impossible
  // one), that link is cleared rather than left pointing at a
  // transaction that's about to stop existing.
  const all = await tx.store.getAll()
  for (const t of all) {
    if (t.reimbursesExpenseId === expenseId || t.reimbursesExpenseId === incomeId) {
      await tx.store.put({ ...t, reimbursesExpenseId: null })
    }
  }
  await tx.store.delete(expenseId)
  await tx.store.delete(incomeId)
  await tx.done
}

/** Archives rather than deletes by default — transactions already
 * linked to this account keep their history and keep contributing to
 * account-scoped totals elsewhere (Tag Detail-style reports, CSV
 * export) even after the account itself is hidden from pickers and
 * widgets. A hard delete is offered separately for a genuine mistake
 * (an account that was never real), which does clear the link on any
 * transactions pointing at it — same orphan-safety reasoning as
 * deleteTransaction and deleteCategory. */
export async function archiveAccount(id: string) {
  const db = await getDB()
  const account = await db.get('accounts', id)
  if (!account) return
  await db.put('accounts', { ...account, isArchived: true })
}

/** Deleting an account leaves stale accountId references all over the
 * app otherwise — not just on plain transactions (already handled
 * below), but anywhere else an account can be picked: the Default
 * Account used for Quick Add and completed shopping trips, the NAB/
 * Westpac/Beem Import Defaults mapping, every recurring bill pointed at
 * it, and every installment plan pointed at it. Left alone, each of
 * these would keep silently creating new transactions tagged with an
 * account id that no longer resolves to anything — not a crash, just
 * money quietly falling out of every account balance calculation
 * without any visible sign why. Cleared to null/None here rather than
 * left dangling, matching the same orphan-safety pattern already used
 * for transfers and reimbursements elsewhere in this file. */
export async function deleteAccountPermanently(id: string) {
  const db = await getDB()
  const tx = db.transaction(['accounts', 'transactions', 'recurring', 'installmentPlans'], 'readwrite')
  await tx.objectStore('accounts').delete(id)

  const transactions = await tx.objectStore('transactions').getAll()
  for (const t of transactions) {
    if (t.accountId === id) await tx.objectStore('transactions').put({ ...t, accountId: null })
  }

  const recurringItems = await tx.objectStore('recurring').getAll()
  for (const r of recurringItems) {
    if (r.accountId === id) await tx.objectStore('recurring').put({ ...r, accountId: null })
  }

  const plans = await tx.objectStore('installmentPlans').getAll()
  for (const p of plans) {
    if (p.accountId === id) await tx.objectStore('installmentPlans').put({ ...p, accountId: null })
  }

  await tx.done

  const settings = getSettings()
  if (settings.defaultAccountId === id) updateSettings({ defaultAccountId: null })

  const importMapping = getImportAccountMapping()
  const nextMapping = { ...importMapping }
  let importMappingChanged = false
  for (const source of ['nab', 'westpac', 'beem'] as const) {
    if (nextMapping[source] === id) { nextMapping[source] = null; importMappingChanged = true }
  }
  if (importMappingChanged) saveImportAccountMapping(nextMapping)
}

export async function getInstallmentPlans(): Promise<InstallmentPlan[]> {
  const db = await getDB()
  return db.getAll('installmentPlans')
}

export async function saveInstallmentPlan(plan: InstallmentPlan) {
  const db = await getDB()
  await db.put('installmentPlans', plan)
}

export async function createInstallmentPlan(data: Omit<InstallmentPlan, 'id'>): Promise<InstallmentPlan> {
  const db = await getDB()
  const plan: InstallmentPlan = { ...data, id: uuid() }
  await db.put('installmentPlans', plan)
  return plan
}

/** Deleting a plan leaves any payments already generated from it
 * exactly as they are — they're real transactions that really
 * happened, and losing that history because the plan itself got
 * removed (paid off and cleared away, or cancelled) would be actively
 * wrong. Only the link back to the plan is cleared, matching the same
 * orphan-safety pattern used for deleting an account or a category. */
export async function deleteInstallmentPlan(id: string) {
  const db = await getDB()
  const tx = db.transaction(['installmentPlans', 'transactions'], 'readwrite')
  await tx.objectStore('installmentPlans').delete(id)
  const transactions = await tx.objectStore('transactions').getAll()
  for (const t of transactions) {
    if (t.installmentPlanId === id) await tx.objectStore('transactions').put({ ...t, installmentPlanId: null })
  }
  await tx.done
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

// Preferences and learned data that live in localStorage rather than the
// IndexedDB stores above — genuine user setup that's easy to forget when
// adding a new one of these, so it's collected by explicit key here
// rather than scattered ad hoc. Deliberately an ALLOWLIST, not "every
// budget-tracker-* key": several other keys in this app (last-backup
// timestamps, a one-time migration flag, the "why did this change"
// snapshot cache) are device-local bookkeeping, not user data — blindly
// restoring those from an old backup would be actively wrong (e.g.
// resetting the "haven't backed up in a while" reminder, or replaying a
// stale Safe to Spend comparison).
const BACKED_UP_LOCAL_STORAGE_KEYS = [
  'budget-tracker-settings', // budget cycle mode/day, dismissed recurring suggestions, nudge preference
  'budget-tracker-cycle-overrides', // confirmed per-cycle payday corrections
  'budget-tracker-merchant-rules', // learned + manually pinned category suggestions
  'budget-tracker-dashboard-widgets', // hidden dashboard widgets
  'budget-tracker-dashboard-widget-order', // dashboard widget ordering
  'budget-tracker-import-account-mapping' // which account NAB/Westpac/Beem imports default to
]

function collectLocalSettings(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of BACKED_UP_LOCAL_STORAGE_KEYS) {
    const value = localStorage.getItem(key)
    if (value !== null) result[key] = value
  }
  return result
}

export async function exportBackup(): Promise<string> {
  const db = await getDB()
  const categories = await db.getAll('categories')
  const transactions = await db.getAll('transactions')
  const recurring = await db.getAll('recurring')
  const shoppingLists = await db.getAll('shoppingLists')
  const accounts = await db.getAll('accounts')
  const installmentPlans = await db.getAll('installmentPlans')
  const localSettings = collectLocalSettings()
  return JSON.stringify({ formatVersion: 4, exportedAt: new Date().toISOString(), categories, transactions, recurring, shoppingLists, accounts, installmentPlans, localSettings }, null, 2)
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
  let accounts: Account[] = []
  let merchantRulesToImport: { key: string; categoryId: string }[] = []
  let localSettings: Record<string, string> = {}
  let installmentPlans: InstallmentPlan[] = []

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
      accounts?: Account[]
      installmentPlans?: InstallmentPlan[]
      localSettings?: Record<string, string>
    }
    if (!Array.isArray(data.categories) || !Array.isArray(data.transactions)) {
      throw new Error('That doesn\u2019t look like a Budget Tracker backup file — missing categories or transactions.')
    }
    categories = data.categories
    transactions = data.transactions
    recurring = data.recurring ?? []
    shoppingLists = data.shoppingLists ?? []
    // Absent entirely in backups made before accounts existed — nothing
    // to restore in that case, transactionsToWrite below falls back to
    // accountId: null for all of them either way.
    accounts = data.accounts ?? []
    // Written back by their own stable id, not reconciled by name the
    // way accounts/categories are — a plan doesn't have a name
    // guaranteed unique the way "Everyday Account" effectively is (two
    // genuinely different purchases could both be named "Laptop"), so
    // matching by id and letting a repeat import of the same backup
    // simply overwrite the same record is the safer default here.
    installmentPlans = data.installmentPlans ?? []
    // Absent entirely in backups made before this existed — nothing to
    // restore in that case, which is fine, current settings are simply
    // left as they are rather than being cleared out.
    localSettings = data.localSettings ?? {}
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

  // Same by-name reconciliation as categories above, and for the same
  // reason — an imported account's id is always freshly generated, so
  // matching by id would create a duplicate "Everyday Account" every
  // single time the same backup (or an auto-backup) gets restored.
  const existingAccounts = await db.getAll('accounts')
  const existingAccountsByName = new Map(existingAccounts.map((a) => [a.name.toLowerCase(), a]))
  const accountIdRemap = new Map<string, string>()
  const accountsToWrite: Account[] = []
  for (const a of accounts) {
    const existing = existingAccountsByName.get(a.name.toLowerCase())
    if (existing) {
      accountIdRemap.set(a.id, existing.id)
    } else {
      accountsToWrite.push(a)
    }
  }
  function remapAccountId(id: string | null): string | null {
    if (!id) return null
    return accountIdRemap.get(id) ?? id
  }

  const transactionsToWrite = transactions.map((t) => ({
    ...t,
    tags: Array.isArray(t.tags) ? t.tags : [],
    categoryId: remapCategoryId(t.categoryId),
    accountId: remapAccountId((t as Transaction).accountId ?? null)
  }))
  const recurringToWrite = recurring.map((r) => ({ ...r, categoryId: remapCategoryId(r.categoryId) }))
  const shoppingListsToWrite = shoppingLists.map((s) => ({ ...s, categoryId: remapCategoryId(s.categoryId) }))
  const installmentPlansToWrite = installmentPlans.map((p) => ({ ...p, categoryId: remapCategoryId(p.categoryId), accountId: remapAccountId(p.accountId) }))

  const tx = db.transaction(['categories', 'transactions', 'recurring', 'shoppingLists', 'accounts', 'installmentPlans'], 'readwrite')
  for (const c of categoriesToWrite) await tx.objectStore('categories').put(c)
  for (const t of transactionsToWrite) await tx.objectStore('transactions').put(t)
  for (const r of recurringToWrite) await tx.objectStore('recurring').put(r)
  for (const s of shoppingListsToWrite) await tx.objectStore('shoppingLists').put(s)
  for (const a of accountsToWrite) await tx.objectStore('accounts').put(a)
  for (const p of installmentPlansToWrite) await tx.objectStore('installmentPlans').put(p)
  await tx.done

  for (const rule of merchantRulesToImport) {
    learnMerchant(rule.key, remapCategoryId(rule.categoryId))
  }

  // Only ever restores keys from the explicit allowlist above (enforced
  // at export time, not here) — an old or hand-edited backup file can't
  // smuggle in an arbitrary localStorage write through this path.
  //
  // Merchant rules need the same category-id remapping applied above —
  // confirmed a real bug here: a rule's categoryId (and the keys of its
  // per-category counts) point at whatever id the category had in the
  // ORIGINAL export, which is frequently NOT the id that category ends
  // up with after reconciliation-by-name against what's already local
  // (e.g. every default category name already exists on a fresh
  // install, so restoring is a rename onto existing ids, not a fresh
  // write of the exported ones). Left unmapped, every restored rule
  // pointed at a category id that no longer existed, showing as
  // "Unknown category" and never actually suggesting anything.
  for (const [key, value] of Object.entries(localSettings)) {
    if (!BACKED_UP_LOCAL_STORAGE_KEYS.includes(key)) continue
    if (key === 'budget-tracker-merchant-rules') {
      try {
        const remapCounts = (counts?: Record<string, number>) => {
          if (!counts) return counts
          const result: Record<string, number> = {}
          for (const [catId, n] of Object.entries(counts)) {
            const mapped = remapCategoryId(catId) ?? catId
            result[mapped] = (result[mapped] ?? 0) + n // sum rather than overwrite, in case two original ids happen to remap onto the same target
          }
          return result
        }
        const rules = JSON.parse(value) as { key: string; categoryId: string; counts?: Record<string, number> }[]
        const remapped = rules.map((r) => ({
          ...r,
          categoryId: remapCategoryId(r.categoryId) ?? r.categoryId,
          counts: remapCounts(r.counts)
        }))
        localStorage.setItem(key, JSON.stringify(remapped))
      } catch {
        // Malformed value in the backup — skip this one key rather than
        // failing the whole restore over it.
      }
    } else {
      localStorage.setItem(key, value)
    }
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

export function exportCSV(transactions: Transaction[], categories: Category[], accounts: Account[] = []): string {
  const catById = new Map(categories.map((c) => [c.id, c.name]))
  const acctById = new Map(accounts.map((a) => [a.id, a.name]))
  const txById = new Map(transactions.map((t) => [t.id, t]))
  const header = 'Date,Note,Category,Account,Type,Amount,Tags,Reimburses\n'
  const rows = transactions.map((t) => {
    // Same UTC-shift issue documented elsewhere in this app:
    // .toISOString() converts to UTC first, which silently shows the
    // wrong (previous) calendar day for a positive-UTC-offset timezone
    // like Australia's, for any transaction logged from early afternoon
    // onward. localDateInputValue reads the LOCAL date/month/year
    // directly instead.
    const date = localDateInputValue(new Date(t.date))
    const note = `"${t.note.replace(/"/g, '""')}"`
    const category = catById.get(t.categoryId ?? '') ?? 'Uncategorized'
    const account = acctById.get(t.accountId ?? '') ?? ''
    const type = t.isExpense ? 'Expense' : 'Income'
    const tags = `"${(t.tags ?? []).join(', ').replace(/"/g, '""')}"`
    const reimbursedExpense = t.reimbursesExpenseId ? txById.get(t.reimbursesExpenseId) : null
    const reimburses = `"${(reimbursedExpense?.note ?? '').replace(/"/g, '""')}"`
    return `${date},${note},${category},${account},${type},${t.amount.toFixed(2)},${tags},${reimburses}`
  })
  return header + rows.join('\n')
}
