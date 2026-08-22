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

export interface Transaction {
  id: string
  amount: number
  note: string
  date: string // ISO date
  isExpense: boolean
  categoryId: string | null
  reimbursesExpenseId: string | null
  tags: string[] // free-form, lowercase-normalized on entry; cuts across categories (e.g. "japan 2026", "work trip")
}

export type RecurrenceFrequency = 'weekly' | 'monthly' | 'yearly'

export interface RecurringTransaction {
  id: string
  amount: number
  note: string
  isExpense: boolean
  frequency: RecurrenceFrequency
  nextDueDate: string
  categoryId: string | null
  isActive: boolean
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
  { name: 'Other', icon: '📦', color: '#9AA0A6', monthlyBudget: 0, sortOrder: 9, parentId: null, isSavingsCategory: false, goalTargetAmount: 0, goalTargetDate: null, goalStartDate: null, needWantType: null, goalRecurring: false }
]
