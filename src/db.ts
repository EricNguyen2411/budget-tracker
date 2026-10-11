import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import type { Category, Transaction, RecurringTransaction, ShoppingList, InstallmentPlan, TransactionAllocation } from './types'
import { DEFAULT_CATEGORIES } from './types'
import { isNativeBackupFormat, translateNativeBackup } from './nativeImport'
import { learnMerchant, removeCategoryFromMerchantRules, mergeCategoryInMerchantRules } from './merchantRules'
import { normalizeTag, dedupeTags } from './tags'
import { localDateInputValue, savingsBalance } from './calculations'
import { convertAccountsToSavingsCategories, type LegacyAccount, type LegacyData, type LegacyTransaction, type LegacyRecurring, type LegacyPlan } from './accountsMigration'

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
  installmentPlans: { key: string; value: InstallmentPlan }
}

// The stores that existed before accounts were removed (schema v12).
// Only the upgrade below ever touches these — it reads them once, converts
// everything, then deletes them.
interface LegacyBudgetDB extends BudgetDB {
  accounts: { key: string; value: LegacyAccount }
  netWorthSnapshots: { key: string; value: { date: string; netWorth: number } }
}

/** localStorage key holding a one-time summary of what the accounts →
 * savings categories conversion did, so the app can show it once after
 * the update instead of changing the person's numbers silently. */
export const ACCOUNTS_MIGRATION_REPORT_KEY = 'budget-tracker-accounts-migration-report'

let dbPromise: Promise<IDBPDatabase<BudgetDB>> | null = null

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<BudgetDB>('budget-tracker', 12, {
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
        // (v5 created the accounts store, v11 net worth snapshots, and
        // v7–v9 repaired/converted account data — all superseded by v12
        // below, which converts accounts away entirely, so a fresh install
        // never needs to create them at all.)
        if (oldVersion < 6) {
          db.createObjectStore('installmentPlans', { keyPath: 'id' })
          // installmentPlanId is optional on Transaction, so no backfill
          // migration needed here — a missing field and an explicit null
          // read identically everywhere this gets checked.
        }
        if (oldVersion >= 5 && oldVersion < 10) {
          // Same fix v10 originally applied (a real gap in the old
          // category→account conversion left recurring items, shopping
          // lists and plans pointing at deleted categories); harmless and
          // still correct for anyone upgrading from an older version.
          await migrateOrphanedCategoryReferences(transaction)
        }
        if (oldVersion < 12) {
          // Accounts are removed: every savings account becomes a savings
          // category with its balance carried over exactly, transfers
          // between accounts are converted or dropped, and net worth goes
          // away. See accountsMigration.ts for the full rules and the
          // balance-preservation guarantee.
          await migrateAccountsToSavingsCategories(
            db as unknown as IDBPDatabase<LegacyBudgetDB>,
            transaction as unknown as IDBPTransaction<LegacyBudgetDB, StoreNames<LegacyBudgetDB>[], 'versionchange'>
          )
        }
      }
    })
  }
  return dbPromise
}

async function migrateAccountsToSavingsCategories(
  db: IDBPDatabase<LegacyBudgetDB>,
  transaction: IDBPTransaction<LegacyBudgetDB, StoreNames<LegacyBudgetDB>[], 'versionchange'>
) {
  const hasAccounts = db.objectStoreNames.contains('accounts')
  const categoryStore = transaction.objectStore('categories')
  const txStore = transaction.objectStore('transactions')
  const recurringStore = transaction.objectStore('recurring')
  const planStore = transaction.objectStore('installmentPlans')

  const data: LegacyData = {
    accounts: hasAccounts ? await transaction.objectStore('accounts').getAll() : [],
    categories: await categoryStore.getAll(),
    transactions: (await txStore.getAll()) as LegacyTransaction[],
    recurring: (await recurringStore.getAll()) as LegacyRecurring[],
    installmentPlans: (await planStore.getAll()) as LegacyPlan[]
  }

  const result = convertAccountsToSavingsCategories(data, () => crypto.randomUUID())

  await categoryStore.clear()
  for (const c of result.categories) await categoryStore.put(c)
  await txStore.clear()
  for (const t of result.transactions) await txStore.put(t)
  await recurringStore.clear()
  for (const r of result.recurring) await recurringStore.put(r)
  await planStore.clear()
  for (const p of result.installmentPlans) await planStore.put(p)

  if (hasAccounts) db.deleteObjectStore('accounts')
  if (db.objectStoreNames.contains('netWorthSnapshots')) db.deleteObjectStore('netWorthSnapshots')

  try {
    // The "What Changed" screen diffs against a locally cached snapshot
    // of categorized transactions — categories just changed shape, so
    // that comparison starts fresh instead of reporting a wall of
    // confusing "Removed" lines for things that didn't disappear.
    localStorage.removeItem('budget-tracker-safe-to-spend-snapshot')
    // Settings that only made sense with accounts.
    localStorage.removeItem('budget-tracker-payday-targets')
    localStorage.removeItem('budget-tracker-import-account-mapping')
    if (hasAccounts && data.accounts.length > 0) {
      localStorage.setItem(ACCOUNTS_MIGRATION_REPORT_KEY, JSON.stringify(result.report))
    }
  } catch {
    // Storage unavailable — not worth failing the migration over.
  }
}

async function migrateOrphanedCategoryReferences(transaction: IDBPTransaction<BudgetDB, StoreNames<BudgetDB>[], 'versionchange'>) {
  const categoryIds = new Set((await transaction.objectStore('categories').getAll()).map((c) => c.id))

  const recurringStore = transaction.objectStore('recurring')
  for (const r of await recurringStore.getAll()) {
    if (r.categoryId && !categoryIds.has(r.categoryId)) await recurringStore.put({ ...r, categoryId: null })
  }
  const shoppingListStore = transaction.objectStore('shoppingLists')
  for (const s of await shoppingListStore.getAll()) {
    if (s.categoryId && !categoryIds.has(s.categoryId)) await shoppingListStore.put({ ...s, categoryId: null })
  }
  const installmentPlanStore = transaction.objectStore('installmentPlans')
  for (const p of await installmentPlanStore.getAll()) {
    if (p.categoryId && !categoryIds.has(p.categoryId)) await installmentPlanStore.put({ ...p, categoryId: null })
  }
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
  const before = await db.get('categories', category.id)
  await db.put('categories', category)
  // A plain category that has just become a savings category: money already
  // logged against it as income-direction (refunds, pay-backs) would sit
  // there as ordinary income with no marker. Marked as takings-out so it
  // leaves the balance and stops counting as Income, exactly as the
  // accounts conversion treats the same shape.
  if (category.isSavingsCategory && !before?.isSavingsCategory) {
    const all = await db.getAll('transactions')
    for (const t of all) {
      if (t.categoryId === category.id && !t.isExpense && !t.fundedFromCategoryId && !t.reimbursesExpenseId && !(t.multiAllocations && t.multiAllocations.length > 0)) {
        await db.put('transactions', { ...t, fundedFromCategoryId: category.id })
      }
    }
  }
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
    const moveCategory = t.categoryId === sourceId
    const moveMarker = t.fundedFromCategoryId === sourceId
    if (moveCategory || moveMarker) {
      await tx.objectStore('transactions').put({
        ...t,
        categoryId: moveCategory ? targetId : t.categoryId,
        // A withdrawal out of the savings category being merged away now
        // comes out of the one it's merged into.
        fundedFromCategoryId: moveMarker ? targetId : t.fundedFromCategoryId
      })
      if (moveCategory) movedCount++
    }
  }
  // Merging one savings category into another also carries over what it
  // started with — otherwise the merged balance would silently shrink by
  // that amount.
  const source = await tx.objectStore('categories').get(sourceId)
  const target = await tx.objectStore('categories').get(targetId)
  if (source?.isSavingsCategory && target?.isSavingsCategory) {
    await tx.objectStore('categories').put({
      ...target,
      savingsOpeningBalance: Math.round(((target.savingsOpeningBalance ?? 0) + (source.savingsOpeningBalance ?? 0)) * 100) / 100
    })
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
  await reconcileFundingForExpense(transaction.id)
}

/** Keeps savings funding honest after an expense is edited. A funding
 * record covers a specific expense, so if that expense was turned into
 * income, or its amount lowered below what is now covered, the surplus
 * can't stay taken out of savings (it would otherwise show up as phantom
 * Income). The extra is removed from the most recent funding first, and
 * the money goes back to the savings category. Genuine reimbursements from
 * other people are never touched here. */
export async function reconcileFundingForExpense(expenseId: string) {
  const db = await getDB()
  const all = await db.getAll('transactions')
  const expense = all.find((t) => t.id === expenseId)
  if (!expense) return
  const covering = all
    .filter((t) => !t.isExpense && !!t.fundedFromCategoryId && (t.reimbursesExpenseId === expenseId || t.multiAllocations?.some((a) => a.expenseId === expenseId)))
  if (covering.length === 0) return
  const allocOf = (t: Transaction) => t.multiAllocations?.find((a) => a.expenseId === expenseId)?.amount ?? t.amount
  const fundedTotal = covering.reduce((sum, t) => sum + allocOf(t), 0)
  const others = all
    .filter((t) => !t.isExpense && !t.fundedFromCategoryId && (t.reimbursesExpenseId === expenseId || t.multiAllocations?.some((a) => a.expenseId === expenseId)))
    .reduce((sum, t) => sum + allocOf(t), 0)
  const allowed = expense.isExpense ? Math.max(0, expense.amount - others) : 0
  let cut = Math.round((fundedTotal - allowed) * 100) / 100
  if (cut <= 0.005) return
  for (const t of [...covering].sort((a, b) => b.date.localeCompare(a.date))) {
    if (cut <= 0.005) break
    const have = allocOf(t)
    const reduceBy = Math.min(have, cut)
    cut = Math.round((cut - reduceBy) * 100) / 100
    if (t.multiAllocations && t.multiAllocations.length > 0) {
      const remaining = t.multiAllocations
        .map((a) => (a.expenseId === expenseId ? { ...a, amount: Math.round((a.amount - reduceBy) * 100) / 100 } : a))
        .filter((a) => a.amount > 0.005)
      if (remaining.length === 0) await db.delete('transactions', t.id)
      else if (remaining.length === 1) await db.put('transactions', { ...t, multiAllocations: null, reimbursesExpenseId: remaining[0].expenseId, amount: remaining[0].amount })
      else await db.put('transactions', { ...t, multiAllocations: remaining, amount: Math.round(remaining.reduce((sum, a) => sum + a.amount, 0) * 100) / 100 })
    } else {
      const left = Math.round((t.amount - reduceBy) * 100) / 100
      if (left <= 0.005) await db.delete('transactions', t.id)
      else await db.put('transactions', { ...t, amount: left })
    }
  }
}

/** Applies a planSavingsGiveback plan (calculations.ts) — the one place
 * that actually knows how to turn "give back $X of what this
 * transaction covers for this expense" into the right write, since a
 * savings-funding transaction can be either a simple single-expense
 * link (reimbursesExpenseId) or one allocation inside a transaction
 * that covers several different expenses at once (multiAllocations).
 * For the simple case this reduces (or, fully consumed, deletes) the
 * whole transaction, exactly as before. For a shared one it only
 * touches THIS expense's own entry, recomputing the transaction's total
 * amount to match what's left — touching the other expenses' shares
 * would silently corrupt them. A shared transaction reduced down to
 * its last remaining allocation collapses back to the simple
 * single-link shape rather than staying a one-entry array; reduced to
 * none at all, the transaction is deleted outright, the same as the
 * simple case. */
export async function applySavingsGiveback(reductions: { transactionId: string; expenseId: string; reduceBy: number }[]) {
  const db = await getDB()
  const tx = db.transaction('transactions', 'readwrite')
  for (const r of reductions) {
    const t = await tx.store.get(r.transactionId)
    if (!t) continue

    if (t.multiAllocations && t.multiAllocations.length > 0) {
      const remaining = t.multiAllocations
        .map((a) => a.expenseId === r.expenseId ? { ...a, amount: Math.round((a.amount - r.reduceBy) * 100) / 100 } : a)
        .filter((a) => a.amount > 0.01)
      if (remaining.length === 0) {
        await tx.store.delete(r.transactionId)
      } else if (remaining.length === 1) {
        await tx.store.put({ ...t, multiAllocations: null, reimbursesExpenseId: remaining[0].expenseId, amount: remaining[0].amount })
      } else {
        await tx.store.put({ ...t, multiAllocations: remaining, amount: remaining.reduce((sum, a) => sum + a.amount, 0) })
      }
    } else {
      const newAmount = Math.round((t.amount - r.reduceBy) * 100) / 100
      if (newAmount <= 0.01) await tx.store.delete(r.transactionId)
      else await tx.store.put({ ...t, amount: newAmount })
    }
  }
  await tx.done
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
/** Merges two transactions the Duplicate Check screen has flagged as
 * likely the same real thing — not a delete-and-lose-the-other's-data
 * operation, a genuine combine: the kept transaction's own fields win
 * where it has them, but anything the DISCARDED side had that the kept
 * one doesn't (a category, a reimbursement link, tags) carries over
 * rather than being silently lost just because that was the "wrong"
 * copy. Any OTHER transaction that references the discarded one —
 * something reimbursing it, or a multi-allocation payment covering it
 * among others — gets redirected to point at the survivor instead of
 * simply losing that link the way an ordinary delete would, since the
 * underlying relationship (that expense really was covered) is still
 * true, it just needs to point at the transaction that's still around
 * to be pointed at. */
export async function mergeTransactions(keepId: string, discardId: string): Promise<Transaction> {
  const db = await getDB()
  const tx = db.transaction('transactions', 'readwrite')
  const store = tx.objectStore('transactions')

  const keep = await store.get(keepId)
  const discard = await store.get(discardId)
  if (!keep || !discard) throw new Error('One or both transactions no longer exist')

  const merged: Transaction = {
    ...keep,
    categoryId: keep.categoryId ?? discard.categoryId,
    tags: dedupeTags([...keep.tags, ...discard.tags]),
    reimbursesExpenseId: keep.reimbursesExpenseId ?? discard.reimbursesExpenseId,
    multiAllocations: keep.multiAllocations ?? discard.multiAllocations,
    fundedFromCategoryId: keep.fundedFromCategoryId ?? discard.fundedFromCategoryId,
    installmentPlanId: keep.installmentPlanId ?? discard.installmentPlanId
  }

  const all = await store.getAll()
  for (const t of all) {
    if (t.id === keepId || t.id === discardId) continue
    if (t.reimbursesExpenseId === discardId) {
      await store.put({ ...t, reimbursesExpenseId: keepId })
    }
    if (t.multiAllocations?.some((a) => a.expenseId === discardId)) {
      const remapped = t.multiAllocations.map((a) => (a.expenseId === discardId ? { ...a, expenseId: keepId } : a))
      await store.put({ ...t, multiAllocations: remapped })
    }
  }

  await store.put(merged)
  await store.delete(discardId)
  await tx.done
  return merged
}

export async function deleteTransaction(id: string) {
  const db = await getDB()
  const all = await db.getAll('transactions')

  const orphaned = all.filter((t) => t.reimbursesExpenseId === id)
  for (const t of orphaned) {
    if (t.fundedFromCategoryId) {
      // The funding record for an expense that no longer exists has nothing
      // left to fund — leaving it behind would turn it into a stray
      // take-out and silently keep the money out of savings. Removing it
      // puts the money back, which is what deleting the expense means.
      await db.delete('transactions', t.id)
    } else {
      await db.put('transactions', { ...t, reimbursesExpenseId: null })
    }
  }

  // Same orphan-safety, extended to multi-allocation transactions — if
  // the deleted expense was one of several a single payment covered,
  // only that one allocation entry is dropped, not the whole
  // transaction; its own amount is recomputed to match what's left, so
  // the "amount always equals the sum of its allocations" invariant
  // holds even after this. A transaction left with only one allocation
  // (or none) collapses back to the simple single-link shape, or plain
  // unlinked income if nothing remains — never a lone-entry array.
  const multiLinked = all.filter((t) => t.multiAllocations?.some((a) => a.expenseId === id))
  for (const t of multiLinked) {
    const remaining = t.multiAllocations!.filter((a) => a.expenseId !== id)
    if (remaining.length === 0 && t.fundedFromCategoryId) {
      await db.delete('transactions', t.id)
    } else if (remaining.length === 0) {
      await db.put('transactions', { ...t, multiAllocations: null, reimbursesExpenseId: null })
    } else if (remaining.length === 1) {
      await db.put('transactions', { ...t, multiAllocations: null, reimbursesExpenseId: remaining[0].expenseId, amount: remaining[0].amount })
    } else {
      await db.put('transactions', { ...t, multiAllocations: remaining, amount: remaining.reduce((sum, a) => sum + a.amount, 0) })
    }
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

/** Puts money into a savings category — a contribution is just an
 * expense-direction transaction in that category, so it also shows up
 * in the ordinary transaction list and in imports. */
export async function contributeToSavings(params: {
  categoryId: string
  amount: number
  date: string
  note?: string
}): Promise<Transaction> {
  const { categoryId, amount, date, note } = params
  const db = await getDB()
  const category = await db.get('categories', categoryId)
  const transaction: Transaction = {
    id: uuid(),
    amount,
    note: note?.trim() || `Added to ${category?.name ?? 'savings'}`,
    date,
    isExpense: true,
    categoryId,
    reimbursesExpenseId: null,
    tags: []
  }
  await db.put('transactions', transaction)
  return transaction
}

/** Takes money back out of a savings category without covering any
 * particular expense. An income-direction transaction carrying
 * fundedFromCategoryId — that marker is what keeps it from being counted
 * as income and what the category's balance subtracts. */
export async function withdrawFromSavings(params: {
  categoryId: string
  amount: number
  date: string
  note?: string
}): Promise<Transaction> {
  const { categoryId, amount, date, note } = params
  const db = await getDB()
  const category = await db.get('categories', categoryId)
  const transaction: Transaction = {
    id: uuid(),
    amount,
    note: note?.trim() || `Taken out of ${category?.name ?? 'savings'}`,
    date,
    isExpense: false,
    categoryId,
    reimbursesExpenseId: null,
    tags: [],
    fundedFromCategoryId: categoryId
  }
  await db.put('transactions', transaction)
  return transaction
}

/** Funds one or more expenses from a savings category. A single
 * income-direction "offset" transaction carries the link to the expense
 * (reimbursesExpenseId for one, multiAllocations for several) plus
 * fundedFromCategoryId — the marker that tells a self-funded draw-down
 * apart from a friend's repayment, and the thing the category's balance
 * subtracts. One record, not two: nothing separate to keep in sync, and
 * deleting it gives the money straight back to the category. */
export async function fundExpensesFromSavings(params: {
  categoryId: string
  allocations: TransactionAllocation[]
  date: string
  note?: string
}): Promise<Transaction> {
  const { categoryId, allocations, date, note } = params
  const db = await getDB()
  const category = await db.get('categories', categoryId)
  const totalAmount = Math.round(allocations.reduce((sum, a) => sum + a.amount, 0) * 100) / 100
  const offset: Transaction = {
    id: uuid(),
    amount: totalAmount,
    note: note?.trim() || `Funded from ${category?.name ?? 'savings'}`,
    date,
    isExpense: false,
    categoryId,
    reimbursesExpenseId: allocations.length === 1 ? allocations[0].expenseId : null,
    multiAllocations: allocations.length > 1 ? allocations : null,
    tags: [],
    fundedFromCategoryId: categoryId
  }
  await db.put('transactions', offset)
  return offset
}

/** Sets a savings category's balance to a number the person types — the
 * "this doesn't match what I actually have" correction. Adjusts the
 * category's opening balance by exactly the difference rather than
 * writing a fake transaction, so it can never show up as income or
 * spending and never appears as a period's worth of saving. */
export async function setSavingsBalance(categoryId: string, targetBalance: number): Promise<void> {
  const db = await getDB()
  const category = await db.get('categories', categoryId)
  if (!category) return
  const transactions = await db.getAll('transactions')
  const current = savingsBalance(category, transactions)
  const delta = Math.round((targetBalance - current) * 100) / 100
  if (Math.abs(delta) < 0.005) return
  await db.put('categories', {
    ...category,
    savingsOpeningBalance: Math.round(((category.savingsOpeningBalance ?? 0) + delta) * 100) / 100
  })
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
  'budget-tracker-reimbursement-contacts' // recently-used reimbursement note quick-picks
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
  const installmentPlans = await db.getAll('installmentPlans')
  const localSettings = collectLocalSettings()
  return JSON.stringify({ formatVersion: 5, exportedAt: new Date().toISOString(), categories, transactions, recurring, shoppingLists, installmentPlans, localSettings }, null, 2)
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
      accounts?: LegacyAccount[]
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
    // Written back by their own stable id, not reconciled by name the
    // way categories are — a plan doesn't have a name guaranteed
    // unique (two genuinely different purchases could both be named
    // "Laptop"), so matching by id and letting a repeat import of the
    // same backup simply overwrite the same record is the safer default.
    installmentPlans = data.installmentPlans ?? []
    // A backup made while accounts existed (formatVersion 4 or earlier,
    // or anything carrying account links) goes through the exact same
    // conversion an upgraded local database gets, so restoring an old
    // file lands on the same savings categories with the same balances.
    const legacyTransactions = transactions as LegacyTransaction[]
    const isLegacy =
      (data.accounts?.length ?? 0) > 0 ||
      legacyTransactions.some((t) => t.accountId || t.fundedFromAccountId || t.isBalanceAdjustment)
    if (isLegacy) {
      const converted = convertAccountsToSavingsCategories(
        {
          accounts: data.accounts ?? [],
          categories,
          transactions: legacyTransactions,
          recurring: recurring as LegacyRecurring[],
          installmentPlans: installmentPlans as LegacyPlan[]
        },
        () => crypto.randomUUID()
      )
      categories = converted.categories
      transactions = converted.transactions
      recurring = converted.recurring
      installmentPlans = converted.installmentPlans
    }
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
      const takeBudget = existing.monthlyBudget === 0 && c.monthlyBudget > 0
      // A plain category here that's a savings category in the backup
      // (e.g. "Travel Savings" converted from an account) becomes one
      // here too — otherwise the restored balance and goal would have
      // nowhere to live. An existing savings category is left alone.
      const takeSavings = !!c.isSavingsCategory && !existing.isSavingsCategory
      if (takeBudget || takeSavings) {
        categoriesToWrite.push({
          ...existing,
          monthlyBudget: takeBudget ? c.monthlyBudget : existing.monthlyBudget,
          ...(takeSavings
            ? {
                isSavingsCategory: true,
                goalTargetAmount: c.goalTargetAmount,
                goalTargetDate: c.goalTargetDate,
                goalStartDate: c.goalStartDate,
                goalRecurring: c.goalRecurring,
                savingsOpeningBalance: c.savingsOpeningBalance
              }
            : {})
        })
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

  const transactionsToWrite = transactions.map((t) => {
    // Confirmed via direct testing this needed guarding: a single
    // transaction with a missing, null, or non-numeric amount doesn't
    // just look wrong on its own row — NaN propagates straight through
    // netSpentForCategory into computeDashboardTotals, and from there
    // into the Spent tile, Safe to Spend, and everything downstream of
    // either, breaking the ENTIRE dashboard from one bad record in a
    // damaged or hand-edited backup file. amount is always meant to be
    // a positive magnitude (isExpense carries direction, never the
    // sign of amount itself) — a negative import value is treated as a
    // foreign system's own sign convention rather than corruption, and
    // normalized rather than rejected; only a genuinely non-numeric
    // value falls back to 0, the same "don't let one bad record take
    // the rest down with it" spirit as the tags fallback just above.
    const rawAmount = (t as Transaction).amount
    const amount = Number.isFinite(rawAmount) ? Math.abs(rawAmount) : 0
    // Same reasoning for date: an unparseable value would otherwise
    // silently become an Invalid Date that breaks any period/range
    // comparison it's later checked against (isInSamePeriod and
    // everything built on it) — falls back to the moment of import
    // rather than leaving something no calculation can safely compare.
    const rawDate = new Date((t as Transaction).date)
    const date = Number.isNaN(rawDate.getTime()) ? new Date().toISOString() : (t as Transaction).date
    return {
      ...t,
      amount,
      date,
      tags: Array.isArray(t.tags) ? t.tags : [],
      categoryId: remapCategoryId(t.categoryId),
      fundedFromCategoryId: remapCategoryId(t.fundedFromCategoryId ?? null) ?? undefined
    }
  })
  const recurringToWrite = recurring.map((r) => ({ ...r, categoryId: remapCategoryId(r.categoryId) }))
  const shoppingListsToWrite = shoppingLists.map((s) => ({ ...s, categoryId: remapCategoryId(s.categoryId) }))
  const installmentPlansToWrite = installmentPlans.map((p) => ({ ...p, categoryId: remapCategoryId(p.categoryId) }))

  const tx = db.transaction(['categories', 'transactions', 'recurring', 'shoppingLists', 'installmentPlans'], 'readwrite')
  for (const c of categoriesToWrite) await tx.objectStore('categories').put(c)
  for (const t of transactionsToWrite) await tx.objectStore('transactions').put(t)
  for (const r of recurringToWrite) await tx.objectStore('recurring').put(r)
  for (const s of shoppingListsToWrite) await tx.objectStore('shoppingLists').put(s)
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
        // A rule whose category isn't in this backup (it was deleted on the
        // source device) could never suggest anything and only shows up as
        // "Unknown category" — dropped rather than restored.
        const validIds = new Set([...existingCategories.map((c) => c.id), ...categoriesToWrite.map((c) => c.id)])
        const remapped = rules
          .map((r) => ({
            ...r,
            categoryId: remapCategoryId(r.categoryId) ?? r.categoryId,
            counts: remapCounts(r.counts)
          }))
          .filter((r) => validIds.has(r.categoryId))
        localStorage.setItem(key, JSON.stringify(remapped))
      } catch {
        // Malformed value in the backup — skip this one key rather than
        // failing the whole restore over it.
      }
    } else if (key === 'budget-tracker-settings') {
      // Older backups carry a default-account id for a feature that no
      // longer exists — left out so it doesn't linger in storage.
      try {
        const parsedSettings = JSON.parse(value) as Record<string, unknown>
        delete parsedSettings.defaultAccountId
        localStorage.setItem(key, JSON.stringify(parsedSettings))
      } catch {
        localStorage.setItem(key, value)
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
    if (t.isExpense || !t.reimbursesExpenseId || t.fundedFromCategoryId) continue
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
  const txById = new Map(transactions.map((t) => [t.id, t]))
  const header = 'Date,Note,Category,Type,Amount,Tags,Reimburses\n'
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
    const type = t.isExpense ? 'Expense' : 'Income'
    const tags = `"${(t.tags ?? []).join(', ').replace(/"/g, '""')}"`
    const reimbursedExpense = t.reimbursesExpenseId ? txById.get(t.reimbursesExpenseId) : null
    const reimburses = `"${(reimbursedExpense?.note ?? '').replace(/"/g, '""')}"`
    return `${date},${note},${category},${type},${t.amount.toFixed(2)},${tags},${reimburses}`
  })
  return header + rows.join('\n')
}
