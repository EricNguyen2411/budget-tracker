export interface Category {
  id: string
  name: string
  icon: string // emoji, since we don't have SF Symbols on web
  color: string // hex
  monthlyBudget: number
  sortOrder: number
  parentId: string | null
  isSavingsCategory: boolean
  goalTargetAmount: number
  goalTargetDate: string | null // ISO date
  goalStartDate: string | null
  needWantType: 'need' | 'want' | null // explicit override for Month in Review's 50/30/20 split — null falls back to a name-based guess
  goalRecurring: boolean // for annual expenses (insurance, registration) — once reached, offers a one-tap renewal into next year's cycle rather than staying a one-time target
}

export interface TransactionAllocation {
  expenseId: string
  amount: number
}

export interface Transaction {
  id: string
  amount: number
  note: string
  date: string // ISO date
  isExpense: boolean
  categoryId: string | null
  reimbursesExpenseId: string | null
  tags: string[] // free-form, lowercase-normalized on entry; cuts across categories (e.g. "japan 2026", "work trip")
  accountId: string | null // which real account (bank/credit card/savings) this transaction moved money through — independent of category, since one category can be paid from several accounts
  installmentPlanId?: string | null // links a generated payment back to its InstallmentPlan — optional rather than a full migration, since it's only read in a few grouping/progress-display spots, not the widespread per-transaction comparisons accountId needed
  // One real payment can cover several different expenses at once — a
  // single bulk reimbursement or Fund From Savings action, rather than
  // being forced into one transaction per expense it happens to touch.
  // Confirmed directly this was the actual source of "my transactions
  // list is filling up with reimbursement entries" — one trip's worth
  // of expenses reimbursed in one go previously meant one new
  // transaction PER expense; this holds them as a single transaction's
  // own breakdown instead. reimbursesExpenseId stays exactly as it was
  // for the single-expense case (an individual Fund From Savings link,
  // editing one transaction at a time) — this is additive, not a
  // replacement, and every calculation that reads reimbursement links
  // reads both through one shared function so nothing needed touching
  // twice. This transaction's own `amount` always equals the sum of
  // these allocations, kept in sync any time an entry changes.
  multiAllocations?: TransactionAllocation[] | null
  // A reconciliation adjustment (AccountDetail's "Doesn't match your
  // bank? Fix it") — correcting the tracked balance to match reality,
  // not a real, new financial event. Still counts toward the
  // account's own balance (that's the whole point of it), but
  // deliberately excluded from Income, Spent, and every other stat
  // that describes what actually happened this period — confirmed
  // directly this was a real gap: with nothing marking it as
  // different, a positive adjustment read exactly like a genuine,
  // unlinked income transaction (a salary deposit, a gift) everywhere
  // that stat is shown, inflating it with money that was never
  // actually earned.
  isBalanceAdjustment?: boolean
}

export type AccountType = 'bank' | 'credit_card' | 'savings' | 'cash' | 'other'

export interface Account {
  id: string
  name: string
  icon: string
  color: string
  type: AccountType
  openingBalance: number
  openingDate: string // ISO date — balance is opening balance as of this date, calculated forward from transactions after it
  sortOrder: number
  isArchived: boolean // hidden from pickers/widgets but transactions already linked to it keep working, rather than losing that history on deletion
  interestRate?: number | null // annual percentage rate (e.g. 4.5 for 4.5% p.a.), used to calculate interest earned — optional, most accounts don't earn interest
}

export type RecurrenceFrequency = 'weekly' | 'monthly' | 'yearly'

export type InstallmentFrequency = 'weekly' | 'fortnightly' | 'monthly'

export interface InstallmentPlan {
  id: string
  note: string // what was bought, e.g. "New Laptop"
  provider: string // free text — "Afterpay", "Zip", "PayPal Pay in 4", etc.
  totalAmount: number
  numberOfInstallments: number
  frequency: InstallmentFrequency
  firstDueDate: string // ISO date — when installment 1 is/was due
  categoryId: string | null
  accountId: string | null
  isActive: boolean // false once cancelled early or fully paid off and dismissed
  nextInstallmentIndex?: number // how many installments have EVER been auto-generated (0-based next index) — advances independently of whether those transactions still exist, the same way RecurringTransaction.nextDueDate does, so deleting a generated payment doesn't cause it to silently regenerate. Optional for the same reason accountId is on RecurringTransaction: a plan saved before this existed just reads as 0, which is what it would have been anyway.
}

export interface RecurringTransaction {
  id: string
  amount: number
  note: string
  isExpense: boolean
  frequency: RecurrenceFrequency
  nextDueDate: string
  categoryId: string | null
  isActive: boolean
  accountId?: string | null // optional rather than a full migration like Transaction's — records saved before this existed just read as "no account", same real-world effect
  anchorDay?: number // the day-of-month (1-31) this item is meant to land on every cycle, independent of nextDueDate's current value — see recurring.ts's addMonthsToAnchor for why this can't just be re-derived from nextDueDate.getDate() every time. Optional for the same reason as accountId: a record saved before this existed bootstraps from its own current nextDueDate the first time it's processed, which is exactly what it would have been anyway.
}

export interface ShoppingListItem {
  id: string
  name: string
  estimatedPrice: number
  quantity: number
  isChecked: boolean
  sortOrder: number
}

export interface ShoppingList {
  id: string
  name: string
  categoryId: string | null
  sortOrder: number
  items: ShoppingListItem[]
}

export interface AppSettings {
  budgetCycleMode: 'fixedDay' | 'lastBusinessDay'
  budgetCycleStartDay: number // 1-28, meaningful only when budgetCycleMode is 'fixedDay'; 1 = calendar month
  dismissedRecurringSuggestions: string[]
  lastOpenedAt: string | null
}

export const DEFAULT_CATEGORIES: Omit<Category, 'id'>[] = [
  { name: 'Groceries', icon: '🛒', color: '#34C759', monthlyBudget: 0, sortOrder: 0, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'need', goalRecurring: false },
  { name: 'Rent', icon: '🏠', color: '#4A90D9', monthlyBudget: 0, sortOrder: 1, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'need', goalRecurring: false },
  { name: 'Dining Out', icon: '🍽️', color: '#F5A623', monthlyBudget: 0, sortOrder: 2, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'want', goalRecurring: false },
  { name: 'Transport', icon: '🚗', color: '#9B7EDE', monthlyBudget: 0, sortOrder: 3, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'need', goalRecurring: false },
  { name: 'Utilities', icon: '💡', color: '#5AC8C8', monthlyBudget: 0, sortOrder: 4, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'need', goalRecurring: false },
  { name: 'Entertainment', icon: '🎬', color: '#FF6B9D', monthlyBudget: 0, sortOrder: 5, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'want', goalRecurring: false },
  { name: 'Shopping', icon: '🛍️', color: '#64D2FF', monthlyBudget: 0, sortOrder: 6, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'want', goalRecurring: false },
  { name: 'Health', icon: '💊', color: '#4ECDC4', monthlyBudget: 0, sortOrder: 7, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'need', goalRecurring: false },
  { name: 'Savings', icon: '🐷', color: '#0A84FF', monthlyBudget: 0, sortOrder: 8, parentId: null, isSavingsCategory: true, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: null, goalRecurring: false },
  { name: 'Other', icon: '📦', color: '#9AA0A6', monthlyBudget: 0, sortOrder: 9, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: 'want', goalRecurring: false }
]
