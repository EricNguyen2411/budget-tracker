export interface Category {
  id: string
  name: string
  icon: string // emoji, since we don't have SF Symbols on web
  color: string // hex
  monthlyBudget: number
  sortOrder: number
  parentId: string | null
  needWantType: 'need' | 'want' | null // explicit override for Month in Review's 50/30/20 split — null falls back to a name-based guess
  // A savings category is a budgeting envelope — money set aside, not a
  // real bank account. Its balance is purely what's been put into it
  // (expense-direction transactions in this category) minus what's been
  // taken back out (income-direction transactions carrying
  // fundedFromCategoryId), plus savingsOpeningBalance for money that was
  // already in it before the app tracked anything. Never reconciled
  // against a bank — see goalProgress in calculations.ts. All optional so
  // a plain spending category (and any record saved before these
  // existed) just reads as "not a savings category".
  isSavingsCategory?: boolean
  goalTargetAmount?: number // 0/absent = open-ended pool with no target
  goalTargetDate?: string | null // ISO date
  goalStartDate?: string | null // progress counts only from here forward, not the category's entire history — lets a goal restart cleanly
  goalRecurring?: boolean // annual expenses (insurance, registration) — once reached, offers a one-tap renewal into next year's cycle
  savingsOpeningBalance?: number // balance carried in from before this category's own transactions began (e.g. converted from a savings account); only counted when no goalStartDate is set
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
  installmentPlanId?: string | null // links a generated payment back to its InstallmentPlan — optional rather than a full migration, since it's only read in a few grouping/progress-display spots
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
  // Set on an income-direction transaction that is money coming OUT of a
  // savings category — points at which category. Two shapes use it: the
  // "offset" half of funding an expense from savings (also carries
  // reimbursesExpenseId/multiAllocations, so it covers that expense), and
  // a plain "take money out of savings" withdrawal (no link at all).
  // Either way it is the signal that tells a self-funded draw-down apart
  // from a genuine outside reimbursement (a friend paying their share),
  // and it is what a savings category's balance subtracts. Always
  // created with categoryId set to the same savings category, so the
  // withdrawal also shows up in that category's own history.
  fundedFromCategoryId?: string | null
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
  isActive: boolean // false once cancelled early or fully paid off and dismissed
  nextInstallmentIndex?: number // how many installments have EVER been auto-generated (0-based next index) — advances independently of whether those transactions still exist, the same way RecurringTransaction.nextDueDate does, so deleting a generated payment doesn't cause it to silently regenerate. Optional: a plan saved before this existed just reads as 0, which is what it would have been anyway.
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
  anchorDay?: number // the day-of-month (1-31) this item is meant to land on every cycle, independent of nextDueDate's current value — see recurring.ts's addMonthsToAnchor for why this can't just be re-derived from nextDueDate.getDate() every time. Optional: a record saved before this existed bootstraps from its own current nextDueDate the first time it's processed, which is exactly what it would have been anyway.
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
  { name: 'Groceries', icon: '🛒', color: '#34C759', monthlyBudget: 0, sortOrder: 0, parentId: null, needWantType: 'need' },
  { name: 'Rent', icon: '🏠', color: '#4A90D9', monthlyBudget: 0, sortOrder: 1, parentId: null, needWantType: 'need' },
  { name: 'Dining Out', icon: '🍽️', color: '#F5A623', monthlyBudget: 0, sortOrder: 2, parentId: null, needWantType: 'want' },
  { name: 'Transport', icon: '🚗', color: '#9B7EDE', monthlyBudget: 0, sortOrder: 3, parentId: null, needWantType: 'need' },
  { name: 'Utilities', icon: '💡', color: '#5AC8C8', monthlyBudget: 0, sortOrder: 4, parentId: null, needWantType: 'need' },
  { name: 'Entertainment', icon: '🎬', color: '#FF6B9D', monthlyBudget: 0, sortOrder: 5, parentId: null, needWantType: 'want' },
  { name: 'Shopping', icon: '🛍️', color: '#64D2FF', monthlyBudget: 0, sortOrder: 6, parentId: null, needWantType: 'want' },
  { name: 'Health', icon: '💊', color: '#4ECDC4', monthlyBudget: 0, sortOrder: 7, parentId: null, needWantType: 'need' },
  { name: 'Other', icon: '📦', color: '#9AA0A6', monthlyBudget: 0, sortOrder: 8, parentId: null, needWantType: 'want' }
]
