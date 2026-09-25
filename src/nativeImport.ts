import type { Category, Transaction, RecurringTransaction, ShoppingList, RecurrenceFrequency, Account } from './types'

/**
 * The native Swift app's backup format — structurally very different
 * from the PWA's. Categories/transactions reference each other by NAME
 * (parentName, categoryName), not by ID — SwiftData manages its own
 * internal IDs and never exports them. Icons are SF Symbol names
 * ("cart.fill"), not emoji. Reimbursement links use a transient
 * "localID" system scoped to just that one backup file, not real IDs.
 */
interface NativeBackupCategory {
  name: string
  icon: string
  colorHex: string
  monthlyBudget: number
  sortOrder: number
  parentName?: string | null
  isSavingsCategory?: boolean
  goalTargetAmount?: number
  goalTargetDate?: string | null
  goalStartDate?: string | null
}

interface NativeBackupTransaction {
  amount: number
  note: string
  date: string
  isExpense: boolean
  categoryName?: string | null
  localID?: string
  reimbursesLocalID?: string | null
}

interface NativeBackupRecurring {
  amount: number
  note: string
  isExpense: boolean
  frequency: string
  nextDueDate: string
  isActive: boolean
  categoryName?: string | null
}

interface NativeBackupMerchantRule {
  key: string
  categoryName?: string | null
}

interface NativeBackupShoppingListItem {
  name: string
  estimatedPrice: number
  quantity: number
  isChecked: boolean
  sortOrder: number
}

interface NativeBackupShoppingList {
  name: string
  sortOrder: number
  categoryName?: string | null
  items: NativeBackupShoppingListItem[]
}

interface NativeBackupFile {
  formatVersion: number
  categories: NativeBackupCategory[]
  transactions: NativeBackupTransaction[]
  recurringTransactions?: NativeBackupRecurring[]
  merchantRules?: NativeBackupMerchantRule[]
  shoppingLists?: NativeBackupShoppingList[]
}

/** Distinguishes the native format from the PWA's own — the native one
 * always has "categories" and "transactions" arrays like the PWA does,
 * but its objects reference things by name (parentName/categoryName)
 * rather than by id (parentId/categoryId), and its objects have no "id"
 * field at all, which the PWA format always does. */
/** Distinguishes the native format from the PWA's own — the native one
 * always has "categories" and "transactions" arrays like the PWA does,
 * but its objects reference things by name (parentName/categoryName)
 * rather than by id (parentId/categoryId), and its objects have no "id"
 * field at all, which the PWA format always does.
 *
 * Checked on transactions first, not categories — confirmed via testing
 * that checking categories alone was a real bug: an empty categories
 * array (a real, if unusual, state — every category deleted) defaulted
 * to "assume native," which then discarded this app's own transaction
 * ids and dropped every reimbursement link on a routine re-import of
 * its own backup. Transactions are far less likely to be empty than
 * categories in any backup actually worth importing, and if both arrays
 * are empty there's nothing meaningful to import as either format
 * anyway. */
export function isNativeBackupFormat(data: unknown): data is NativeBackupFile {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (!Array.isArray(obj.categories) || !Array.isArray(obj.transactions)) return false
  const firstTransaction = obj.transactions[0] as Record<string, unknown> | undefined
  if (firstTransaction) return !('id' in firstTransaction)
  const firstCategory = obj.categories[0] as Record<string, unknown> | undefined
  if (firstCategory) return 'colorHex' in firstCategory || 'parentName' in firstCategory
  return false
}

/** Common SF Symbol names from the native app's default taxonomy, mapped
 * to a reasonable emoji equivalent. Keyword-matched rather than an exact
 * lookup, since custom categories could use symbols not in this list —
 * falls back to a generic folder emoji rather than failing the import
 * over an unmapped icon. */
function sfSymbolToEmoji(symbol: string): string {
  const s = symbol.toLowerCase()
  const rules: [string, string][] = [
    ['cart', '🛒'], ['basket', '🛒'],
    ['house', '🏠'], ['bed', '🏠'],
    ['fork', '🍽️'], ['cup', '☕'],
    ['car', '🚗'], ['bus', '🚌'], ['fuel', '⛽'], ['parking', '🅿️'],
    ['bolt', '💡'], ['light', '💡'],
    ['tv', '🎬'], ['film', '🎬'], ['gamecontroller', '🎮'], ['music', '🎵'],
    ['bag', '🛍️'], ['tshirt', '👕'],
    ['cross', '💊'], ['heart', '❤️'], ['pill', '💊'], ['figure', '🏋️'],
    ['airplane', '✈️'], ['plane', '✈️'], ['globe', '🌍'],
    ['banknote', '💵'], ['dollarsign', '💰'], ['chart', '📈'],
    ['gift', '🎁'], ['pawprint', '🐾'], ['graduationcap', '🎓'],
    ['wifi', '📶'], ['phone', '📱'], ['creditcard', '💳'],
    ['ellipsis', '❓'], ['questionmark', '❓']
  ]
  for (const [key, emoji] of rules) {
    if (s.includes(key)) return emoji
  }
  return '📦'
}

/** Hex colors in the native app may or may not have a leading "#" —
 * normalize either way. */
function normalizeHex(hex: string): string {
  const trimmed = hex.trim()
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

const FREQUENCY_VALUES = new Set(['weekly', 'monthly', 'yearly'])

export interface TranslatedBackup {
  categories: Category[]
  accounts: Account[]
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  shoppingLists: ShoppingList[]
  merchantRules: { key: string; categoryId: string }[]
}

export function translateNativeBackup(data: NativeBackupFile): TranslatedBackup {
  const idByCategoryName = new Map<string, string>()
  // A native savings category becomes a goal account here, not a
  // category — matching the same account-based goal model the rest of
  // this app now uses. Tracked separately from idByCategoryName so a
  // transaction that referenced one by name can be re-pointed
  // correctly below (a real account transaction for the contribution
  // side, fundedFromAccountId for the withdrawal/offset side) rather
  // than resolved as an ordinary category that no longer exists.
  const accountIdBySavingsCategoryName = new Map<string, string>()
  const categories: Category[] = []
  const accounts: Account[] = []

  // Pass 1: top-level categories, so subcategories always have a parent
  // id to resolve against.
  const topLevelDefs = data.categories.filter((c) => !c.parentName)
  for (const def of topLevelDefs) {
    if (def.isSavingsCategory) {
      const id = crypto.randomUUID()
      accountIdBySavingsCategoryName.set(def.name.toLowerCase(), id)
      accounts.push({
        id,
        name: def.name,
        icon: sfSymbolToEmoji(def.icon),
        color: normalizeHex(def.colorHex),
        type: 'savings',
        openingBalance: 0, // the native format has no account-balance concept for these — real balance builds from the transactions re-pointed below, same as any other account
        openingDate: new Date(0).toISOString(),
        sortOrder: def.sortOrder,
        isArchived: false,
        goalTargetAmount: def.goalTargetAmount ?? 0,
        goalTargetDate: def.goalTargetDate ?? null,
        goalStartDate: def.goalStartDate ?? null,
        goalRecurring: false
      })
      continue
    }
    const id = crypto.randomUUID()
    idByCategoryName.set(def.name.toLowerCase(), id)
    categories.push({
      id,
      name: def.name,
      icon: sfSymbolToEmoji(def.icon),
      color: normalizeHex(def.colorHex),
      monthlyBudget: def.monthlyBudget,
      sortOrder: def.sortOrder,
      parentId: null,
      needWantType: null
    })
  }

  // Pass 2: subcategories. A subcategory of a former savings category
  // has no equivalent in the new model (accounts don't nest) — treated
  // as an ordinary top-level category instead of dropping it entirely.
  const subDefs = data.categories.filter((c) => c.parentName)
  for (const def of subDefs) {
    const id = crypto.randomUUID()
    idByCategoryName.set(def.name.toLowerCase(), id)
    const parentId = def.parentName ? (idByCategoryName.get(def.parentName.toLowerCase()) ?? null) : null
    categories.push({
      id,
      name: def.name,
      icon: sfSymbolToEmoji(def.icon),
      color: normalizeHex(def.colorHex),
      monthlyBudget: def.monthlyBudget,
      sortOrder: def.sortOrder,
      parentId,
      needWantType: null
    })
  }

  function resolveCategory(name: string | null | undefined): string | null {
    if (!name) return null
    return idByCategoryName.get(name.toLowerCase()) ?? null
  }

  function resolveSavingsAccount(name: string | null | undefined): string | null {
    if (!name) return null
    return accountIdBySavingsCategoryName.get(name.toLowerCase()) ?? null
  }

  // Transactions: create all first with real ids, tracking each by its
  // backup-file-local id, then a second pass to resolve reimbursement
  // links — a transaction can reference one that appears later in the
  // file.
  const idByLocalId = new Map<string, string>()
  const transactions: Transaction[] = data.transactions.map((def) => {
    const id = crypto.randomUUID()
    if (def.localID) idByLocalId.set(def.localID, id)
    const savingsAccountId = resolveSavingsAccount(def.categoryName)
    if (savingsAccountId) {
      // A contribution (real deposit into the goal) or a withdrawal
      // (funding some other expense) — either way this is now a real
      // transaction ON that account, not a categorized one.
      return {
        id,
        amount: def.amount,
        note: def.note,
        date: def.date,
        isExpense: def.isExpense,
        categoryId: null,
        reimbursesExpenseId: null, // resolved below
        tags: [],
        accountId: savingsAccountId,
        fundedFromAccountId: null // resolved below, only for the withdrawal/offset side
      }
    }
    return {
      id,
      amount: def.amount,
      note: def.note,
      date: def.date,
      isExpense: def.isExpense,
      categoryId: resolveCategory(def.categoryName),
      reimbursesExpenseId: null, // resolved below
      tags: [],
      accountId: null
    }
  })
  data.transactions.forEach((def, i) => {
    if (def.reimbursesLocalID) {
      transactions[i].reimbursesExpenseId = idByLocalId.get(def.reimbursesLocalID) ?? null
    }
    // The withdrawal/offset side of a savings-funded expense: an
    // income-direction transaction that was tied to a (now-converted)
    // savings category AND covers another expense. Its own accountId
    // was just set to the goal account above, which — now that this
    // is income-direction — would wrongly read as a deposit rather
    // than the withdrawal it actually is (the exact bug already fixed
    // for the live app's own bulk-funding flow). Correcting it to the
    // real two-sided shape: accountId cleared, fundedFromAccountId set
    // instead, exactly matching what fundExpensesFromAccount produces.
    const t = transactions[i]
    if (!t.isExpense && t.reimbursesExpenseId && t.accountId && accounts.some((a) => a.id === t.accountId)) {
      t.fundedFromAccountId = t.accountId
      t.accountId = null
    }
  })

  const recurring: RecurringTransaction[] = (data.recurringTransactions ?? []).map((def) => ({
    id: crypto.randomUUID(),
    amount: def.amount,
    note: def.note,
    isExpense: def.isExpense,
    frequency: (FREQUENCY_VALUES.has(def.frequency) ? def.frequency : 'monthly') as RecurrenceFrequency,
    nextDueDate: def.nextDueDate,
    categoryId: resolveCategory(def.categoryName),
    isActive: def.isActive
  }))

  const shoppingLists: ShoppingList[] = (data.shoppingLists ?? []).map((def) => ({
    id: crypto.randomUUID(),
    name: def.name,
    sortOrder: def.sortOrder,
    categoryId: resolveCategory(def.categoryName),
    items: def.items.map((item) => ({
      id: crypto.randomUUID(),
      name: item.name,
      estimatedPrice: item.estimatedPrice,
      quantity: item.quantity,
      isChecked: item.isChecked,
      sortOrder: item.sortOrder
    }))
  }))

  const merchantRules = (data.merchantRules ?? [])
    .map((def) => ({ key: def.key, categoryId: resolveCategory(def.categoryName) }))
    .filter((r): r is { key: string; categoryId: string } => r.categoryId !== null)

  return { categories, accounts, transactions, recurring, shoppingLists, merchantRules }
}
