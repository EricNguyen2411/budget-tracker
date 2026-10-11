import type { Category, Transaction, RecurringTransaction, InstallmentPlan } from './types'

/** One-way conversion from the account-based model (real bank/credit
 * card/savings accounts, transfers between them, net worth) back to
 * savings categories. Pure — no database, no browser APIs — so the exact
 * same function runs both when an existing local database is upgraded
 * (db.ts, schema v12) and when an old backup file that still contains
 * accounts is restored (importBackup), and so it can be tested directly
 * against a real exported backup.
 *
 * The one invariant everything here protects: **every savings balance
 * the person could see before is exactly the balance they see after.**
 * Rather than try to replay history, each savings category stores a
 * `savingsOpeningBalance` computed as (the account's old balance) minus
 * (whatever the converted transactions themselves now contribute), so
 * the final balance matches to the cent no matter what odd shapes the
 * old data held (adjustments, orphaned transfer halves, expenses paid
 * straight from a savings account). Transactions are only transformed
 * where their meaning is unambiguous. */

export interface LegacyAccount {
  id: string
  name: string
  icon?: string
  color?: string
  type: string // 'bank' | 'credit_card' | 'savings' | 'cash' | 'other'
  openingBalance: number
  openingDate: string
  isArchived?: boolean
  goalTargetAmount?: number
  goalTargetDate?: string | null
  goalStartDate?: string | null
  goalRecurring?: boolean
  monthlyContribution?: number
}

export type LegacyTransaction = Transaction & {
  accountId?: string | null
  fundedFromAccountId?: string | null
  isBalanceAdjustment?: boolean
}
export type LegacyRecurring = RecurringTransaction & { accountId?: string | null }
export type LegacyPlan = InstallmentPlan & { accountId?: string | null }

export interface LegacyData {
  accounts: LegacyAccount[]
  categories: Category[]
  transactions: LegacyTransaction[]
  recurring: LegacyRecurring[]
  installmentPlans: LegacyPlan[]
}

export interface AccountConversionReport {
  accountName: string
  accountType: string
  oldBalance: number
  newBalance: number | null // null when no category was created for it
  categoryName: string | null
  reusedExistingCategory: boolean
  skippedReason?: string
}

export interface MigrationReport {
  accounts: AccountConversionReport[]
  droppedTransferHalves: number
  convertedToContributions: number
  convertedToWithdrawals: number
  convertedFundingOffsets: number
  droppedFundingWithdrawals: number
  droppedAdjustments: number
  recurringConvertedToContributions: number
  clearedDanglingLinks: number
}

export interface MigrationResult {
  categories: Category[]
  transactions: Transaction[]
  recurring: RecurringTransaction[]
  installmentPlans: InstallmentPlan[]
  report: MigrationReport
}

function cents(n: number): number {
  return Math.round(n * 100) / 100
}

function midnight(iso: string): Date {
  const d = new Date(iso)
  d.setHours(0, 0, 0, 0)
  return d
}

/** The account's balance exactly as the account-era app computed it
 * (calculations.accountBalance): transactions dated on/after the opening
 * date only, expense subtracts and income adds, credit cards inverted. */
export function legacyAccountBalance(account: LegacyAccount, transactions: LegacyTransaction[]): number {
  const opening = midnight(account.openingDate)
  const net = transactions
    .filter((t) => t.accountId === account.id && midnight(t.date) >= opening)
    .reduce((sum, t) => sum + (t.isExpense ? -t.amount : t.amount), 0)
  return account.openingBalance + (account.type === 'credit_card' ? -net : net)
}

/** Balance of a savings category under the NEW model — also what
 * calculations.savingsBalance computes; duplicated here on purpose so
 * the migration's own self-check doesn't depend on app code it could
 * accidentally be validating against itself. */
function newModelBalance(categoryId: string, opening: number, transactions: Transaction[]): number {
  let balance = opening
  for (const t of transactions) {
    if (t.categoryId === categoryId && t.isExpense) balance += t.amount
    if (!t.isExpense && t.fundedFromCategoryId === categoryId) balance -= t.amount
  }
  return balance
}

export function convertAccountsToSavingsCategories(data: LegacyData, newId: () => string): MigrationResult {
  const report: MigrationReport = {
    accounts: [],
    droppedTransferHalves: 0,
    convertedToContributions: 0,
    convertedToWithdrawals: 0,
    convertedFundingOffsets: 0,
    droppedFundingWithdrawals: 0,
    droppedAdjustments: 0,
    recurringConvertedToContributions: 0,
    clearedDanglingLinks: 0
  }

  const accounts = data.accounts ?? []
  const txs = data.transactions ?? []
  const txById = new Map(txs.map((t) => [t.id, t]))

  // An account is "savings-like" if it is typed savings, or if any
  // transaction says it funded an expense (that money demonstrably
  // behaved like a savings pool whatever the account was labelled).
  const fundingSourceIds = new Set(txs.filter((t) => !t.isExpense && t.fundedFromAccountId).map((t) => t.fundedFromAccountId as string))
  const isSavingsLike = (a: LegacyAccount) => a.type === 'savings' || fundingSourceIds.has(a.id)

  // ---- 1. Which savings-like accounts get a category -------------------
  const oldBalances = new Map<string, number>()
  for (const a of accounts) oldBalances.set(a.id, cents(legacyAccountBalance(a, txs)))

  const accountHasActivity = (a: LegacyAccount) => txs.some((t) => t.accountId === a.id || t.fundedFromAccountId === a.id)

  const categories: Category[] = data.categories.map((c) => ({ ...c }))
  let nextSort = categories.reduce((m, c) => Math.max(m, c.sortOrder), -1) + 1
  const categoryForAccount = new Map<string, string>() // account id -> savings category id
  const reusedCategory = new Set<string>()
  const accountForCategory = new Map<string, LegacyAccount>()

  for (const a of accounts) {
    if (!isSavingsLike(a)) continue
    const balance = oldBalances.get(a.id) ?? 0
    const hasGoal = (a.goalTargetAmount ?? 0) > 0
    const hasPlan = (a.monthlyContribution ?? 0) > 0
    const needed = Math.abs(balance) > 0.004 || accountHasActivity(a) || hasGoal || hasPlan || fundingSourceIds.has(a.id)
    if (!needed) {
      report.accounts.push({ accountName: a.name, accountType: a.type, oldBalance: balance, newBalance: null, categoryName: null, reusedExistingCategory: false, skippedReason: 'empty (zero balance, no transactions, no goal)' })
      continue
    }

    const sameName = categories.find((c) => !c.parentId && c.name.trim().toLowerCase() === a.name.trim().toLowerCase() && !accountForCategory.has(c.id))
    let cat: Category
    if (sameName) {
      cat = sameName
      reusedCategory.add(cat.id)
    } else {
      cat = {
        id: newId(),
        name: a.name,
        icon: a.icon ?? '🐷',
        color: a.color ?? '#0A84FF',
        monthlyBudget: 0,
        sortOrder: nextSort++,
        parentId: null,
        needWantType: null
      }
      categories.push(cat)
    }
    cat.isSavingsCategory = true
    cat.needWantType = null
    if ((cat.monthlyBudget ?? 0) <= 0 && hasPlan) cat.monthlyBudget = a.monthlyContribution as number
    cat.goalTargetAmount = a.goalTargetAmount ?? 0
    cat.goalTargetDate = a.goalTargetDate ?? null
    cat.goalRecurring = a.goalRecurring ?? false
    // A goal start date at or before the account's own opening carried no
    // information (progress was the whole balance either way); only a
    // later one — a deliberate restart — is meaningful to keep.
    cat.goalStartDate = a.goalStartDate && midnight(a.goalStartDate) > midnight(a.openingDate) ? a.goalStartDate : null
    categoryForAccount.set(a.id, cat.id)
    accountForCategory.set(cat.id, a)
  }

  // ---- 2. Classify the special transaction shapes ----------------------
  // Transfer pair: an income half linked (reimbursesExpenseId) to an
  // expense half, both with an account, accounts differ, expense half
  // uncategorized — exactly calculations.isAccountTransferLink.
  const transferPairs: { exp: LegacyTransaction; inc: LegacyTransaction }[] = []
  const handled = new Set<string>()
  for (const inc of txs) {
    if (inc.isExpense || !inc.reimbursesExpenseId || !inc.accountId) continue
    const exp = txById.get(inc.reimbursesExpenseId)
    if (!exp || !exp.isExpense || !exp.accountId || exp.accountId === inc.accountId || exp.categoryId !== null) continue
    if (inc.fundedFromAccountId) continue
    transferPairs.push({ exp, inc })
    handled.add(exp.id)
    handled.add(inc.id)
  }

  // Funding pair: offset (income, fundedFromAccountId) + the real
  // withdrawal on that account (uncategorized expense, no link, same
  // amount and date). Each withdrawal pairs with at most one offset.
  const fundingOffsets = txs.filter((t) => !t.isExpense && t.fundedFromAccountId && !handled.has(t.id))
  const fundingWithdrawalIds = new Set<string>()
  for (const o of fundingOffsets) {
    const w = txs.find((t) =>
      t.id !== o.id && !handled.has(t.id) && !fundingWithdrawalIds.has(t.id) &&
      t.isExpense && t.categoryId === null && t.accountId === o.fundedFromAccountId &&
      !t.reimbursesExpenseId && Math.abs(t.amount - o.amount) < 0.01 && t.date === o.date
    )
    if (w) fundingWithdrawalIds.add(w.id)
  }

  // ---- 3. Build the converted transaction list --------------------------
  const out: Transaction[] = []
  const strip = (t: LegacyTransaction): Transaction => {
    const { accountId: _a, fundedFromAccountId: _f, isBalanceAdjustment: _b, ...rest } = t
    return { ...rest } as Transaction
  }

  // Deposits a recurring contribution already generated: the recurring item
  // pointed at a savings account, so each bill it created is an
  // income-direction row on that account with no category. The recurring
  // item itself becomes a planned contribution below, so its past bills
  // must become contributions too — left alone they'd count as ordinary
  // Income and the contribution would look like it never happened.
  const normNote = (n: string) => n.trim().toLowerCase().replace(/\s+/g, ' ')
  const recurringDepositKeys = new Set<string>()
  for (const r of data.recurring ?? []) {
    if (r.accountId && categoryForAccount.has(r.accountId)) recurringDepositKeys.add(`${r.accountId}|${normNote(r.note)}`)
  }

  for (const t of txs) {
    if (t.isBalanceAdjustment) { report.droppedAdjustments++; continue }
    if (fundingWithdrawalIds.has(t.id)) { report.droppedFundingWithdrawals++; continue }
    if (handled.has(t.id)) continue // transfer halves — emitted below, per pair

    if (!t.isExpense && t.fundedFromAccountId) {
      const catId = categoryForAccount.get(t.fundedFromAccountId)
      const base = strip(t)
      if (catId) {
        out.push({ ...base, categoryId: catId, fundedFromCategoryId: catId })
        report.convertedFundingOffsets++
      } else {
        // Source account no longer exists — can't know where this came
        // from, so it falls back to behaving like an ordinary linked
        // reimbursement rather than inventing a source.
        out.push(base)
      }
      continue
    }
    // A transfer half whose other half no longer exists (deleted on its
    // own at some point) still describes a real deposit into / withdrawal
    // out of this savings account. Left alone it would count as ordinary
    // income or spending, so it becomes what it always meant: money added
    // to, or taken out of, the savings category.
    const orphanCat = t.accountId ? categoryForAccount.get(t.accountId) : undefined
    if (orphanCat && t.categoryId === null && !t.reimbursesExpenseId && !(t.multiAllocations && t.multiAllocations.length) && /^transfer (from|to)\b/i.test(t.note.trim())) {
      if (t.isExpense) {
        out.push({ ...strip(t), isExpense: false, categoryId: orphanCat, fundedFromCategoryId: orphanCat })
        report.convertedToWithdrawals++
      } else {
        out.push({ ...strip(t), isExpense: true, categoryId: orphanCat })
        report.convertedToContributions++
      }
      continue
    }
    if (orphanCat && !t.isExpense && t.categoryId === null && !t.reimbursesExpenseId && !(t.multiAllocations && t.multiAllocations.length) && recurringDepositKeys.has(`${t.accountId}|${normNote(t.note)}`)) {
      out.push({ ...strip(t), isExpense: true, categoryId: orphanCat })
      report.convertedToContributions++
      continue
    }
    out.push(strip(t))
  }

  for (const { exp, inc } of transferPairs) {
    const toCat = categoryForAccount.get(inc.accountId as string)
    const fromCat = categoryForAccount.get(exp.accountId as string)
    let used = 0
    if (toCat) {
      out.push({ ...strip(exp), categoryId: toCat, reimbursesExpenseId: null })
      report.convertedToContributions++
      used++
    }
    if (fromCat) {
      out.push({ ...strip(inc), categoryId: fromCat, fundedFromCategoryId: fromCat, reimbursesExpenseId: null })
      report.convertedToWithdrawals++
      used++
    }
    if (used < 2) report.droppedTransferHalves += 2 - used
  }

  // Anything that pointed at a transaction we removed must not be left
  // dangling (same rule deleteTransaction applies for a deleted expense).
  const outIds = new Set(out.map((t) => t.id))
  for (let i = 0; i < out.length; i++) {
    const t = out[i]
    let next = t
    if (t.reimbursesExpenseId && !outIds.has(t.reimbursesExpenseId)) {
      next = { ...next, reimbursesExpenseId: null }
      report.clearedDanglingLinks++
    }
    if (t.multiAllocations && t.multiAllocations.length > 0) {
      const kept = t.multiAllocations.filter((a) => outIds.has(a.expenseId))
      if (kept.length !== t.multiAllocations.length) {
        report.clearedDanglingLinks++
        if (kept.length === 0) next = { ...next, multiAllocations: null }
        else if (kept.length === 1) next = { ...next, multiAllocations: null, reimbursesExpenseId: kept[0].expenseId, amount: kept[0].amount }
        else next = { ...next, multiAllocations: kept, amount: cents(kept.reduce((s, a) => s + a.amount, 0)) }
      }
    }
    out[i] = next
  }

  // Unlinked income sitting in a savings category (e.g. a "Funded from
  // Travel Savings" entry) is money taken back out of it. In the category
  // model that's exactly what the fundedFromCategoryId marker means —
  // without it the entry would count as real income AND fail to reduce the
  // balance. Must happen before opening balances are computed below.
  const savingsCatIds = new Set(accountForCategory.keys())
  for (const c of categories) if (c.isSavingsCategory) savingsCatIds.add(c.id)
  for (let i = 0; i < out.length; i++) {
    const t = out[i]
    if (!t.isExpense && !t.fundedFromCategoryId && !t.reimbursesExpenseId && !(t.multiAllocations && t.multiAllocations.length) && t.categoryId && savingsCatIds.has(t.categoryId)) {
      out[i] = { ...t, fundedFromCategoryId: t.categoryId }
    }
  }

  // ---- 4. Opening balances so every balance carries over exactly -------
  for (const [catId, account] of accountForCategory) {
    const cat = categories.find((c) => c.id === catId) as Category
    const oldBal = oldBalances.get(account.id) ?? 0
    const flows = cents(newModelBalance(catId, 0, out))
    cat.savingsOpeningBalance = cents(oldBal - flows)
    const finalBal = cents(newModelBalance(catId, cat.savingsOpeningBalance, out))
    report.accounts.push({
      accountName: account.name,
      accountType: account.type,
      oldBalance: oldBal,
      newBalance: finalBal,
      categoryName: cat.name,
      reusedExistingCategory: reusedCategory.has(catId)
    })
  }
  for (const a of accounts) {
    if (!isSavingsLike(a)) {
      report.accounts.push({ accountName: a.name, accountType: a.type, oldBalance: oldBalances.get(a.id) ?? 0, newBalance: null, categoryName: null, reusedExistingCategory: false, skippedReason: 'not a savings account — no longer tracked' })
    }
  }

  // ---- 5. Recurring items and installment plans ------------------------
  const recurring: RecurringTransaction[] = (data.recurring ?? []).map((r) => {
    const { accountId, ...rest } = r
    const catId = accountId ? categoryForAccount.get(accountId) : undefined
    if (catId) {
      // A recurring item pointed at a savings account was always meant as
      // a planned contribution (the recurring editor had no income/expense
      // choice until recently, so these were forced to expense-direction,
      // which as an account withdrawal contradicted the intent) — now a
      // contribution to that savings category.
      report.recurringConvertedToContributions++
      return { ...rest, isExpense: true, categoryId: catId }
    }
    return { ...rest }
  })
  const installmentPlans: InstallmentPlan[] = (data.installmentPlans ?? []).map((p) => {
    const { accountId: _acc, ...rest } = p
    return { ...rest }
  })

  return { categories, transactions: out, recurring, installmentPlans, report }
}
