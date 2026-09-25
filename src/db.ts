import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import type { Category, Transaction, RecurringTransaction, ShoppingList, Account, InstallmentPlan, TransactionAllocation } from './types'
import { DEFAULT_CATEGORIES } from './types'
import { isNativeBackupFormat, translateNativeBackup } from './nativeImport'
import { learnMerchant, removeCategoryFromMerchantRules, mergeCategoryInMerchantRules } from './merchantRules'
import { getSettings, updateSettings } from './budgetPeriod'
import { getImportAccountMapping, saveImportAccountMapping } from './importSettings'
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
    dbPromise = openDB<BudgetDB>('budget-tracker', 10, {
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
        if (oldVersion < 7) {
          // Repairs data corrupted by a real bug (fixed alongside this
          // migration): editing a balance-adjustment transaction through
          // the regular transaction editor silently dropped its
          // isBalanceAdjustment flag on save, since the editor rebuilt
          // the record from only its own form fields and saveTransaction
          // fully replaces the stored record rather than merging into
          // it. Confirmed via a real screenshot: a reconciliation entry
          // that should have been excluded from the Income total instead
          // counted as ordinary income once its flag was gone.
          //
          // Re-running this is safe and a no-op for anyone unaffected —
          // it only touches transactions that still carry the exact
          // note text and null category the reconcile flow always
          // writes, and only when the flag isn't already true, so a
          // transaction a person genuinely renamed away from "Balance
          // adjustment" is left alone.
          await migrateMissingBalanceAdjustmentFlag(transaction)
        }
        if (oldVersion < 8) {
          // Repairs data corrupted by a real bug (fixed alongside this
          // migration): the bulk "Fund from Savings" action let a real
          // account be picked for the resulting transaction, same as
          // the bulk friend-reimbursement action beside it — but unlike
          // a friend's repayment, which genuinely does add money to
          // wherever it lands, a savings draw-down needs to be recorded
          // as income (isExpense: false) purely so its
          // reimbursesExpenseId/multiAllocations link works, and income
          // on a real account means "balance went up." The real money
          // was leaving that account, not arriving — so tying this to
          // an account made its tracked balance rise by exactly what
          // was actually spent, confirmed directly via a real
          // screenshot showing a Travel Savings account $1,109.76
          // higher than it should have been. The single-expense
          // version of this action never had the bug (it never set an
          // account); this backfill brings bulk-created transactions
          // already saved with one into line with that always-correct
          // behavior. Doesn't touch a genuine account Transfer's income
          // side, which this same shape could otherwise resemble — a
          // transfer always has categoryId null, while every
          // transaction this migration targets has a real (savings)
          // category, which is exactly what the fixed create-flow now
          // guarantees can never coincide with a set accountId. Not
          // touched here, and left for the person to review themselves:
          // any Balance Adjustment they created trying to manually
          // correct the resulting mismatch — that's a judgment call
          // this migration has no reliable way to make safely.
          await migrateSavingsFundingAccountId(transaction)
        }
        if (oldVersion < 9) {
          // The big one: savings goals move from being a special kind
          // of category to being a property of a real account —
          // confirmed with the person directly this was worth doing,
          // since for the ordinary case (one goal, one dedicated
          // account) the category was just a second number tracked in
          // parallel with the account's own real balance, kept in sync
          // only by convention, never usefully able to disagree on
          // purpose. Every savings category becomes (or is merged
          // into, if it already had a linkedAccountId from the
          // previous fix) a real account carrying the goal's target/
          // date/recurring fields, seeded with a snapshot of whatever
          // its cumulative progress already was so nobody's progress
          // resets to zero. Every transaction that referenced the old
          // category is re-pointed: its categoryId clears (the
          // category itself is being deleted), and if it was the
          // income-direction "offset" half of funding an expense from
          // this goal, it picks up fundedFromAccountId pointing at the
          // new account — the new signal that replaced checking a
          // transaction's category for isSavingsCategory everywhere in
          // the app.
          await migrateSavingsCategoriesToGoalAccounts(transaction)
          // The "What Changed" screen explains a Safe to Spend move by
          // diffing against a snapshot saved locally the last time the
          // dashboard was open — and it only tracks CATEGORIZED
          // transactions (see safeToSpendHistory.ts), which is exactly
          // what every transaction that used to belong to a savings
          // category just stopped being, now re-pointed onto its new
          // account instead. Left alone, the very next open would
          // report a wall of confusing "Removed" lines for things that
          // didn't actually disappear — real money and progress both
          // carried over correctly, only the category-based bookkeeping
          // that snapshot happens to track changed shape. Clearing it
          // here means that comparison starts fresh after this update,
          // rather than being made once, confusingly, against a
          // structure that no longer exists.
          try {
            localStorage.removeItem('budget-tracker-safe-to-spend-snapshot')
          } catch {
            // Storage unavailable — not worth failing the migration over.
          }
        }
        if (oldVersion < 10) {
          // Cleans up a real gap in the v9 migration above: it deleted
          // savings categories directly, re-pointing every transaction
          // that referenced one, but never checked recurring items,
          // shopping lists, or installment plans for the same thing —
          // unlike deleteCategory (the ordinary, everyday path for
          // removing a category), which already handles all four.
          // Confirmed via a real backup: a recurring "Travel Savings"
          // contribution was left pointing at a categoryId that no
          // longer existed, which would render broken (or crash) in
          // any screen that looks up that category to show its
          // icon/name. Clearing the dangling reference here is exactly
          // what deleteCategory already does for a category removed the
          // ordinary way — this just closes the same gap retroactively
          // for anyone who already went through the v9 migration before
          // this fix existed.
          await migrateOrphanedCategoryReferences(transaction)
        }
      }
    })
  }
  return dbPromise
}

async function migrateMissingBalanceAdjustmentFlag(transaction: IDBPTransaction<BudgetDB, StoreNames<BudgetDB>[], 'versionchange'>) {
  const store = transaction.objectStore('transactions')
  let cursor = await store.openCursor()
  while (cursor) {
    const t = cursor.value as Transaction
    if (t.note === 'Balance adjustment' && t.categoryId === null && t.isBalanceAdjustment !== true) {
      await cursor.update({ ...t, isBalanceAdjustment: true })
    }
    cursor = await cursor.continue()
  }
}

// The stored shape of a category from before savings goals moved onto
// accounts — IndexedDB doesn't enforce the current TypeScript type, so
// a record saved by an old version of the app still has these fields
// at runtime even though Category no longer declares them. Migrations
// reading old data need this to type-check; nothing else should.
interface LegacyCategoryFields {
  isSavingsCategory?: boolean
  goalTargetAmount?: number
  goalTargetDate?: string | null
  goalStartDate?: string | null
  goalRecurring?: boolean
  linkedAccountId?: string | null
}

async function migrateSavingsFundingAccountId(transaction: IDBPTransaction<BudgetDB, StoreNames<BudgetDB>[], 'versionchange'>) {
  const categoryStore = transaction.objectStore('categories')
  const allCategories = (await categoryStore.getAll()) as (Category & LegacyCategoryFields)[]
  const savingsCategoryIds = new Set(allCategories.filter((c) => c.isSavingsCategory).map((c) => c.id))
  const store = transaction.objectStore('transactions')
  let cursor = await store.openCursor()
  while (cursor) {
    const t = cursor.value as Transaction
    const isSavingsOffset = !t.isExpense && !!t.categoryId && savingsCategoryIds.has(t.categoryId) && (!!t.reimbursesExpenseId || !!(t.multiAllocations && t.multiAllocations.length > 0))
    if (isSavingsOffset && t.accountId !== null) {
      await cursor.update({ ...t, accountId: null })
    }
    cursor = await cursor.continue()
  }
}

async function migrateSavingsCategoriesToGoalAccounts(transaction: IDBPTransaction<BudgetDB, StoreNames<BudgetDB>[], 'versionchange'>) {
  const categoryStore = transaction.objectStore('categories')
  const accountStore = transaction.objectStore('accounts')
  const txStore = transaction.objectStore('transactions')

  const allCategories = (await categoryStore.getAll()) as (Category & LegacyCategoryFields)[]
  const allTransactions = await txStore.getAll()
  const allAccounts = await accountStore.getAll()
  const savingsCategories = allCategories.filter((c) => c.isSavingsCategory)

  for (const cat of savingsCategories) {
    const own = allTransactions.filter((t) => t.categoryId === cat.id)
    // A snapshot of cumulative progress under the old formula
    // (contributions minus withdrawals) — not pixel-perfect against
    // every edge case netAmount would have handled, but a sensible,
    // real starting balance for the new account rather than resetting
    // anyone's progress to zero.
    const contributions = own.filter((t) => t.isExpense).reduce((sum, t) => sum + t.amount, 0)
    const withdrawals = own.filter((t) => !t.isExpense).reduce((sum, t) => sum + t.amount, 0)
    const progressSnapshot = Math.max(0, Math.round((contributions - withdrawals) * 100) / 100)

    const existingLinked = cat.linkedAccountId ? allAccounts.find((a) => a.id === cat.linkedAccountId) : null
    let targetAccountId: string

    if (existingLinked) {
      targetAccountId = existingLinked.id
      await accountStore.put({
        ...existingLinked,
        goalTargetAmount: cat.goalTargetAmount ?? 0,
        goalTargetDate: cat.goalTargetDate ?? null,
        goalStartDate: cat.goalStartDate ?? null,
        goalRecurring: cat.goalRecurring ?? false
      })
    } else {
      targetAccountId = uuid()
      const newAccount: Account = {
        id: targetAccountId,
        name: cat.name,
        icon: cat.icon,
        color: cat.color,
        type: 'savings',
        openingBalance: progressSnapshot,
        openingDate: new Date().toISOString(),
        sortOrder: 999,
        isArchived: false,
        goalTargetAmount: cat.goalTargetAmount ?? 0,
        goalTargetDate: cat.goalTargetDate ?? null,
        goalStartDate: cat.goalStartDate ?? null,
        goalRecurring: cat.goalRecurring ?? false
      }
      await accountStore.put(newAccount)
    }

    for (const t of own) {
      const isOffset = !t.isExpense && (!!t.reimbursesExpenseId || !!(t.multiAllocations && t.multiAllocations.length > 0))
      await txStore.put({
        ...t,
        categoryId: null,
        fundedFromAccountId: isOffset ? targetAccountId : (t as Transaction).fundedFromAccountId ?? null
      })
    }

    await categoryStore.delete(cat.id)
  }

  // Any category that was never a savings category still needs its
  // now-nonexistent-in-the-type legacy fields (isSavingsCategory:
  // false, an empty goalTargetAmount, etc.) cleared out of the actual
  // stored record, or they'd sit there as harmless but permanent dead
  // weight in every future read.
  const remaining = (await categoryStore.getAll()) as (Category & LegacyCategoryFields)[]
  for (const c of remaining) {
    if ('isSavingsCategory' in c) {
      const clean: Category = { id: c.id, name: c.name, icon: c.icon, color: c.color, monthlyBudget: c.monthlyBudget, sortOrder: c.sortOrder, parentId: c.parentId, needWantType: c.needWantType }
      await categoryStore.put(clean)
    }
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
export async function renewRecurringGoal(account: Account): Promise<Account> {
  if (!account.goalTargetDate) return account
  const oldTarget = new Date(account.goalTargetDate)
  const newTarget = new Date(oldTarget.getFullYear() + 1, oldTarget.getMonth(), oldTarget.getDate())
  const updated: Account = {
    ...account,
    goalTargetDate: newTarget.toISOString(),
    goalStartDate: new Date().toISOString()
  }
  await saveAccount(updated)
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
    fundedFromAccountId: keep.fundedFromAccountId ?? discard.fundedFromAccountId,
    installmentPlanId: keep.installmentPlanId ?? discard.installmentPlanId,
    isBalanceAdjustment: keep.isBalanceAdjustment || discard.isBalanceAdjustment
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
    await db.put('transactions', { ...t, reimbursesExpenseId: null })
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
    if (remaining.length === 0) {
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

/** Funds one or more expenses from a real account — the account-based
 * replacement for the old category-based Fund From Savings link.
 * Deliberately two transactions, not one, mirroring createTransfer's
 * own shape: a genuine withdrawal (isExpense: true) on the funding
 * account, so its real balance correctly goes down, paired with an
 * income-direction "offset" transaction that carries the actual
 * reimbursesExpenseId/multiAllocations link (never tied to any
 * account itself, so it can't affect a real balance) plus
 * fundedFromAccountId pointing back at the withdrawal's account — the
 * signal that replaced checking a transaction's category for
 * isSavingsCategory everywhere in the app. Single expense or several
 * at once (a bulk trip-funding action) both go through the same
 * `allocations` list; a lone entry is exactly the single-expense case. */
export async function fundExpensesFromAccount(params: {
  fromAccountId: string
  allocations: TransactionAllocation[]
  date: string
  note?: string
}): Promise<{ withdrawal: Transaction; offset: Transaction }> {
  const { fromAccountId, allocations, date, note } = params
  const db = await getDB()
  const account = (await db.getAll('accounts')).find((a) => a.id === fromAccountId)
  const totalAmount = Math.round(allocations.reduce((sum, a) => sum + a.amount, 0) * 100) / 100
  const defaultNote = `Funded from ${account?.name ?? 'savings'}`

  const withdrawal: Transaction = {
    id: uuid(),
    amount: totalAmount,
    note: note?.trim() || defaultNote,
    date,
    isExpense: true,
    categoryId: null,
    reimbursesExpenseId: null,
    tags: [],
    accountId: fromAccountId
  }
  const offset: Transaction = {
    id: uuid(),
    amount: totalAmount,
    note: note?.trim() || defaultNote,
    date,
    isExpense: false,
    categoryId: null,
    reimbursesExpenseId: allocations.length === 1 ? allocations[0].expenseId : null,
    multiAllocations: allocations.length > 1 ? allocations : null,
    tags: [],
    accountId: null,
    fundedFromAccountId: fromAccountId
  }

  const tx = db.transaction('transactions', 'readwrite')
  await tx.store.put(withdrawal)
  await tx.store.put(offset)
  await tx.done

  return { withdrawal, offset }
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
    if (t.multiAllocations?.some((a) => a.expenseId === expenseId || a.expenseId === incomeId)) {
      const remaining = t.multiAllocations.filter((a) => a.expenseId !== expenseId && a.expenseId !== incomeId)
      if (remaining.length === 0) {
        await tx.store.put({ ...t, multiAllocations: null })
      } else if (remaining.length === 1) {
        await tx.store.put({ ...t, multiAllocations: null, reimbursesExpenseId: remaining[0].expenseId, amount: remaining[0].amount })
      } else {
        await tx.store.put({ ...t, multiAllocations: remaining, amount: remaining.reduce((sum, a) => sum + a.amount, 0) })
      }
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
  'budget-tracker-import-account-mapping', // which account NAB/Westpac/Beem imports default to
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
    accounts = translated.accounts
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
      accountId: remapAccountId((t as Transaction).accountId ?? null)
    }
  })
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
