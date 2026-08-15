import type { Category, Transaction, RecurringTransaction, ShoppingList, RecurrenceFrequency } from './types'

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
export function isNativeBackupFormat(data: unknown): data is NativeBackupFile {
  if (!data || typeof data !== 'object') return false
  const obj = data as Record<string, unknown>
  if (!Array.isArray(obj.categories) || !Array.isArray(obj.transactions)) return false
  const firstCategory = obj.categories[0] as Record<string, unknown> | undefined
  if (!firstCategory) return true // empty categories array, ambiguous but assume native if no PWA-only field found
  return 'colorHex' in firstCategory || 'parentName' in firstCategory
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
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  shoppingLists: ShoppingList[]
  merchantRules: { key: string; categoryId: string }[]
}

export function translateNativeBackup(data: NativeBackupFile): TranslatedBackup {
  const idByCategoryName = new Map<string, string>()
  const categories: Category[] = []

  // Pass 1: top-level categories, so subcategories always have a parent
  // id to resolve against.
  const topLevelDefs = data.categories.filter((c) => !c.parentName)
  for (const def of topLevelDefs) {
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
      isSavingsCategory: def.isSavingsCategory ?? false,
      goalTargetAmount: def.goalTargetAmount ?? 0,
      goalTargetDate: def.goalTargetDate ?? null,
      goalStartDate: def.goalStartDate ?? null,
      needWantType: null,
      goalRecurring: false
    })
  }

  // Pass 2: subcategories.
  const subDefs = data.categories.filter((c) => c.parentName)
  for (const def of subDefs) {
    const id = crypto.randomUUID()
    idByCategoryName.set(def.name.toLowerCase(), id)
    categories.push({
      id,
      name: def.name,
      icon: sfSymbolToEmoji(def.icon),
      color: normalizeHex(def.colorHex),
      monthlyBudget: def.monthlyBudget,
      sortOrder: def.sortOrder,
      parentId: idByCategoryName.get(def.parentName!.toLowerCase()) ?? null,
      isSavingsCategory: def.isSavingsCategory ?? false,
      goalTargetAmount: def.goalTargetAmount ?? 0,
      goalTargetDate: def.goalTargetDate ?? null,
      goalStartDate: def.goalStartDate ?? null,
      needWantType: null,
      goalRecurring: false
    })
  }

  function resolveCategory(name: string | null | undefined): string | null {
    if (!name) return null
    return idByCategoryName.get(name.toLowerCase()) ?? null
  }

  // Transactions: create all first with real ids, tracking each by its
  // backup-file-local id, then a second pass to resolve reimbursement
  // links — a transaction can reference one that appears later in the
  // file.
  const idByLocalId = new Map<string, string>()
  const transactions: Transaction[] = data.transactions.map((def) => {
    const id = crypto.randomUUID()
    if (def.localID) idByLocalId.set(def.localID, id)
    return {
      id,
      amount: def.amount,
      note: def.note,
      date: def.date,
      isExpense: def.isExpense,
      categoryId: resolveCategory(def.categoryName),
      reimbursesExpenseId: null // resolved below
    }
  })
  data.transactions.forEach((def, i) => {
    if (def.reimbursesLocalID) {
      transactions[i].reimbursesExpenseId = idByLocalId.get(def.reimbursesLocalID) ?? null
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

  return { categories, transactions, recurring, shoppingLists, merchantRules }
}
