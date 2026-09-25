import { useEffect, useState } from 'react'
import type { Category, RecurringTransaction, Transaction, Account } from '../types'
import { formatCurrency, localDateInputValue, goalProgress, totalReimbursed, matchingRecurringItem, accountBalance, findTransferPair, findFundedExpense, findFundingPair, isSavingsAccount } from '../calculations'
import { learnMerchant, suggestCategoryId } from '../merchantRules'
import { recordReimbursementContact, getRecentReimbursementContacts } from '../reimbursementContacts'
import { allTagsFrom, dedupeTags } from '../tags'
import { deleteTransaction, updateTransfer, deleteTransfer, fundExpensesFromAccount } from '../db'
import { frequencyLabel } from '../recurring'
import { useModalClose } from '../useModalClose'
import TagEditor from './TagEditor'

interface Props {
  transaction: Transaction | null
  categories: Category[]
  allTransactions: Transaction[]
  onSave: (data: Omit<Transaction, 'id'>) => void
  onDelete?: () => void
  onClose: () => void
  onChanged?: () => void
  recurring?: RecurringTransaction[]
  accounts?: Account[]
}

export default function TransactionEditor(props: Props) {
  const { transaction, allTransactions, accounts = [], onClose, onChanged } = props
  // A transfer is edited as one thing, not two separately-editable
  // transactions — checked first, before any of the normal expense/
  // income state below even initializes, so editing either half of a
  // transfer always lands on the same combined From/To/Amount form
  // regardless of which side was tapped.
  const transferPair = transaction ? findTransferPair(transaction, allTransactions) : null
  if (transaction && transferPair) {
    return <TransferEditForm transaction={transaction} pair={transferPair} accounts={accounts} onClose={onClose} onChanged={onChanged} />
  }
  // A Fund From Savings withdrawal is a thin link record, not a
  // transaction with independent meaning of its own — the expense it
  // funds keeps its full normal editor (category, tags, date all still
  // matter there), but tapping this side specifically shows a compact
  // view instead of a mostly-irrelevant category picker and Reimburses
  // field.
  const fundedExpense = transaction ? findFundedExpense(transaction, allTransactions) : null
  if (transaction && fundedExpense) {
    return <FundingLinkView transaction={transaction} fundedExpense={fundedExpense} accounts={accounts} allTransactions={allTransactions} onClose={onClose} onChanged={onChanged} />
  }
  return <RegularTransactionEditor {...props} />
}

function FundingLinkView({ transaction, fundedExpense, accounts, allTransactions, onClose, onChanged }: { transaction: Transaction; fundedExpense: Transaction; accounts: Account[]; allTransactions: Transaction[]; onClose: () => void; onChanged?: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  const fundingAccount = transaction.fundedFromAccountId ? accounts.find((a) => a.id === transaction.fundedFromAccountId) : null

  async function handleRemove() {
    // The withdrawal and this offset were created as a pair (see
    // fundExpensesFromAccount) but aren't linked by an explicit id the
    // way a Transfer's two sides are — found via findFundingPair,
    // shared with every other place this same pair needs finding
    // (App.tsx's own swipe-to-delete handler included, after
    // confirming that path had exactly this gap too). Removing only
    // this side would leave the real withdrawal sitting there forever,
    // still correctly reducing the account's balance for money that,
    // as far as the rest of the app is concerned, no longer funds
    // anything.
    const pairedWithdrawal = findFundingPair(transaction, allTransactions)
    if (pairedWithdrawal) await deleteTransaction(pairedWithdrawal.id)
    await deleteTransaction(transaction.id)
    onChanged?.()
    onClose()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Savings Funding</span>
          <span style={{ width: 60 }} />
        </div>
        <div className="modal-body">
          <div className="card" style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 15, lineHeight: 1.6 }}>
              This covers <span className="amount" style={{ fontWeight: 700 }}>{formatCurrency(transaction.amount)}</span> of "{fundedExpense.note || 'that expense'}" from {fundingAccount ? `${fundingAccount.icon} ${fundingAccount.name}` : 'savings'}.
            </p>
          </div>
          <p className="hint" style={{ marginBottom: 20 }}>
            To change the amount, category, or date of "{fundedExpense.note || 'the expense'}" itself, open it directly from the transactions list — this record is just the funding link between the two. Removing it also removes the matching withdrawal from {fundingAccount ? fundingAccount.name : 'the funding account'}.
          </p>
          <button className="danger-button" onClick={handleRemove}>Remove Funding</button>
        </div>
      </div>
    </div>
  )
}

function TransferEditForm({ transaction, pair, accounts, onClose, onChanged }: { transaction: Transaction; pair: Transaction; accounts: Account[]; onClose: () => void; onChanged?: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  const expenseTx = transaction.isExpense ? transaction : pair
  const incomeTx = transaction.isExpense ? pair : transaction
  const [fromId, setFromId] = useState(expenseTx.accountId ?? '')
  const [toId, setToId] = useState(incomeTx.accountId ?? '')
  const [amount, setAmount] = useState(String(expenseTx.amount))
  const [date, setDate] = useState(localDateInputValue(new Date(expenseTx.date)))
  // Both sides share the exact same custom note when one was typed at
  // creation time (see createTransfer) — if they currently differ,
  // that's the auto-generated "Transfer to X" / "Transfer from Y" pair,
  // not something the person deliberately wrote, so the field starts
  // empty and regenerates fresh defaults (picking up any account rename)
  // on save rather than persisting stale auto-text as if it were custom.
  const [note, setNote] = useState(expenseTx.note === incomeTx.note ? expenseTx.note : '')
  const [showFromPicker, setShowFromPicker] = useState(false)
  const [showToPicker, setShowToPicker] = useState(false)

  const fromAccount = accounts.find((a) => a.id === fromId)
  const toAccount = accounts.find((a) => a.id === toId)
  const parsed = parseFloat(amount)
  const canSubmit = fromId && toId && fromId !== toId && !isNaN(parsed) && parsed > 0

  async function handleSave() {
    if (!canSubmit) return
    const [y, m, d] = date.split('-').map(Number)
    await updateTransfer(expenseTx.id, incomeTx.id, {
      fromAccountId: fromId,
      toAccountId: toId,
      amount: parsed,
      date: new Date(y, m - 1, d).toISOString(),
      note
    })
    onChanged?.()
    onClose()
  }

  async function handleDelete() {
    await deleteTransfer(expenseTx.id, incomeTx.id)
    onChanged?.()
    onClose()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Edit Transfer</span>
          <button onClick={() => requestClose(handleSave)} className="text-button text-button-primary" disabled={!canSubmit} style={!canSubmit ? { color: 'var(--text-faint)' } : undefined}>Save</button>
        </div>
        <div className="modal-body">
          <p className="hint" style={{ marginBottom: 16 }}>Editing either side of a transfer updates both — the amount always matches on both accounts.</p>

          <label className="field-label">Amount</label>
          <input type="number" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} className="amount-input" autoFocus />

          <label className="field-label" style={{ marginTop: 16 }}>From</label>
          <button className="picker-row" onClick={() => setShowFromPicker(true)}>
            <span>{fromAccount ? `${fromAccount.icon} ${fromAccount.name}` : 'Select account'}</span>
            <span className="chevron">›</span>
          </button>

          <label className="field-label" style={{ marginTop: 16 }}>To</label>
          <button className="picker-row" onClick={() => setShowToPicker(true)}>
            <span>{toAccount ? `${toAccount.icon} ${toAccount.name}` : 'Select account'}</span>
            <span className="chevron">›</span>
          </button>
          {fromId && toId && fromId === toId && (
            <p className="hint hint-warning" style={{ marginTop: 6 }}>From and To need to be different accounts.</p>
          )}

          <label className="field-label" style={{ marginTop: 16 }}>Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <label className="field-label" style={{ marginTop: 16 }}>Note (optional)</label>
          <input type="text" placeholder={toAccount ? `e.g. Paying off ${toAccount.name}` : 'e.g. Paying off credit card'} value={note} onChange={(e) => setNote(e.target.value)} />

          <button className="danger-button" onClick={() => requestClose(handleDelete)} style={{ marginTop: 24 }}>
            Delete Transfer
          </button>
        </div>

        {showFromPicker && (
          <div className="modal-backdrop" onClick={() => setShowFromPicker(false)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">From Account</span>
                <button onClick={() => setShowFromPicker(false)} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                {accounts.map((a) => (
                  <button key={a.id} className="picker-row" onClick={() => { setFromId(a.id); setShowFromPicker(false) }}>
                    <span>{a.icon} {a.name}</span>
                    {fromId === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {showToPicker && (
          <div className="modal-backdrop" onClick={() => setShowToPicker(false)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">To Account</span>
                <button onClick={() => setShowToPicker(false)} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                {accounts.map((a) => (
                  <button key={a.id} className="picker-row" onClick={() => { setToId(a.id); setShowToPicker(false) }}>
                    <span>{a.icon} {a.name}</span>
                    {toId === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RegularTransactionEditor({ transaction, categories, allTransactions, onSave, onDelete, onClose, onChanged, recurring = [], accounts = [] }: Props) {
  const { closing, requestClose } = useModalClose(onClose)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [showExpensePicker, setShowExpensePicker] = useState(false)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const categoryPickerClose = useModalClose(() => setShowCategoryPicker(false))
  const expensePickerClose = useModalClose(() => setShowExpensePicker(false))
  const accountPickerClose = useModalClose(() => setShowAccountPicker(false))
  const [amount, setAmount] = useState(transaction ? String(transaction.amount) : '')
  const [note, setNote] = useState(transaction?.note ?? '')
  const [recentContacts] = useState(() => getRecentReimbursementContacts())
  const [date, setDate] = useState(transaction ? localDateInputValue(new Date(transaction.date)) : localDateInputValue(new Date()))
  const [isExpense, setIsExpense] = useState(transaction?.isExpense ?? true)
  const [categoryId, setCategoryId] = useState<string | null>(transaction?.categoryId ?? null)
  const [accountId, setAccountId] = useState<string | null>(transaction?.accountId ?? null)
  const [reimbursesId, setReimbursesId] = useState<string | null>(transaction?.reimbursesExpenseId ?? null)
  const [showSplitCalculator, setShowSplitCalculator] = useState(false)
  const [splitPeopleCount, setSplitPeopleCount] = useState('2')
  const [tags, setTags] = useState<string[]>(transaction?.tags ?? [])

  const existingTags = allTagsFrom(allTransactions)

  const selectedCategory = categories.find((c) => c.id === categoryId)
  const selectedAccount = accounts.find((a) => a.id === accountId)
  // Confirms, directly on the transaction, that this exact charge is
  // recognized as covering an active recurring item — added so that
  // isn't something only checkable by reading the Safe to Spend math.
  const matchedRecurring = isExpense && note.trim() ? matchingRecurringItem({ note, isExpense } as Transaction, recurring) : null
  const reimbursedExpense = allTransactions.find((t) => t.id === reimbursesId)

  // Funding an expense from savings is the SAME underlying mechanism as
  // a friend reimbursing you (an income transaction linked via
  // reimbursesExpenseId) — just categorized under a savings category
  // instead of "someone paid me back." Confirmed directly: this
  // correctly keeps the expense out of that period's Safe to Spend
  // (since it's money already set aside, not new spending) while
  // correctly drawing down the savings category's own running balance,
  // for both an open-ended category and one with a specific goal
  // target. Only offered once the expense itself is already saved,
  // since linking needs a real id on both sides.
  const [showFundPicker, setShowFundPicker] = useState(false)
  const fundPickerClose = useModalClose(() => setShowFundPicker(false))
  const [fundAmount, setFundAmount] = useState('')
  // Filtered to only actually savings-linked income — confirmed this
  // was a real bug: without the categoryId check, a genuine friend
  // reimbursement sitting on the same expense (someone paying you back
  // their share of a shared purchase you also part-funded from savings)
  // showed up in this list too, mislabeled as "Savings" once its own
  // (non-savings) category came back null here. totalFunded/
  // remainingToFund deliberately still sum every linked reimbursement
  // regardless of source — that part is correct as-is, since a friend's
  // payment genuinely does count toward "how much of this is already
  // covered" for the purpose of how much MORE could still be funded.
  const fundingLinks = transaction
    ? allTransactions.filter((t) => t.reimbursesExpenseId === transaction.id && !!t.fundedFromAccountId)
    : []
  const totalFunded = transaction ? totalReimbursed(transaction, allTransactions) : 0
  const remainingToFund = transaction ? Math.max(0, transaction.amount - totalFunded) : 0
  const goalAccounts = accounts.filter((a) => isSavingsAccount(a))

  // Auto-suggest a category from past learning as the note is typed —
  // only for a brand-new transaction with nothing picked yet, so it
  // never overrides a deliberate manual choice.
  useEffect(() => {
    if (transaction || categoryId) return
    const suggested = suggestCategoryId(note, categories)
    if (suggested) setCategoryId(suggested)
  }, [note])

  // A reimbursement should always carry the same category as the
  // expense it's repaying — that's what makes "how much did Groceries
  // actually cost me" come out right. This runs whenever the link
  // changes, not just once, so re-linking to a different expense keeps
  // the category in sync rather than leaving a stale one behind.
  useEffect(() => {
    if (isExpense || !reimbursedExpense) return
    if (reimbursedExpense.categoryId) setCategoryId(reimbursedExpense.categoryId)
  }, [reimbursesId])

  function handleSave() {
    const parsed = parseFloat(amount)
    if (isNaN(parsed) || parsed <= 0) return
    // Derived directly from the linked expense at save time, rather
    // than relying solely on the effect above having already flushed
    // into categoryId state by the moment Save is pressed — removes any
    // dependency on effect timing, so this can't come out stale
    // regardless of how quickly a reimbursement gets linked and saved.
    let effectiveCategoryId = categoryId
    if (!isExpense && reimbursesId && !effectiveCategoryId) {
      const linkedExpense = allTransactions.find((t) => t.id === reimbursesId)
      if (linkedExpense?.categoryId) effectiveCategoryId = linkedExpense.categoryId
    }
    learnMerchant(note.trim(), effectiveCategoryId)
    // A reimbursement specifically (linked to an expense, or general
    // income with a real typed name) — not every income transaction,
    // since a plain salary deposit isn't "a person to remember" the
    // same way a friend paying you back is.
    if (!isExpense && reimbursesId && note.trim()) recordReimbursementContact(note.trim())
    onSave({
      amount: parsed,
      note: note.trim(),
      date: (() => {
        const [y, m, d] = date.split('-').map(Number)
        return new Date(y, m - 1, d).toISOString()
      })(),
      isExpense,
      categoryId: effectiveCategoryId,
      accountId,
      reimbursesExpenseId: isExpense ? null : reimbursesId,
      tags: dedupeTags(tags),
      // This form has no fields for these — they aren't something a
      // person edits directly here, they're internal links written by
      // other flows (account reconciliation, a bulk multi-expense
      // payment, an auto-generated installment). Carried through
      // untouched from whatever this transaction already had, rather
      // than left out of the object literal: leaving them out doesn't
      // just leave them "unchanged," it actively overwrites them to
      // undefined on save, since saveTransaction does a full record
      // replace (db.put), not a merge. Confirmed directly: opening a
      // balance-adjustment transaction and hitting Save with no changes
      // silently stripped isBalanceAdjustment, making it reappear as
      // ordinary income on the Income screen.
      isBalanceAdjustment: transaction?.isBalanceAdjustment,
      multiAllocations: transaction?.multiAllocations,
      installmentPlanId: transaction?.installmentPlanId
    })
  }

  const expenseCandidates = allTransactions
    .filter((t) => t.isExpense && t.id !== transaction?.id)
    .sort((a, b) => {
      // nearest date to this transaction's date first
      const target = new Date(date).getTime()
      return Math.abs(new Date(a.date).getTime() - target) - Math.abs(new Date(b.date).getTime() - target)
    })

  async function fundFromSavings(fromAccountId: string) {
    if (!transaction) return
    const parsed = parseFloat(fundAmount)
    if (isNaN(parsed) || parsed <= 0) return
    // A real, two-sided funding event now (see fundExpensesFromAccount)
    // — a genuine withdrawal on the goal account, correctly reducing
    // its real balance, paired with the offset link that makes this
    // expense show as covered. Replaced the old single-transaction
    // version, which recorded the "funding" as income on the account
    // itself — the exact bug already fixed once for the bulk version of
    // this same action, now fixed here too rather than left as the one
    // remaining path that could still reproduce it.
    await fundExpensesFromAccount({
      fromAccountId,
      allocations: [{ expenseId: transaction.id, amount: parsed }],
      date: new Date().toISOString(),
      note: transaction.note ? `Re: ${transaction.note}` : 'Savings withdrawal'
    })
    onChanged?.()
    setShowFundPicker(false)
    setFundAmount('')
  }

  async function removeFundingLink(offset: Transaction) {
    // Same pairing concern as FundingLinkView's own removal — found the
    // same shared way via findFundingPair.
    const pairedWithdrawal = findFundingPair(offset, allTransactions)
    if (pairedWithdrawal) await deleteTransaction(pairedWithdrawal.id)
    await deleteTransaction(offset.id)
    onChanged?.()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">{transaction ? 'Edit' : 'New Transaction'}</span>
          <button onClick={() => requestClose(handleSave)} className="text-button text-button-primary">Save</button>
        </div>

        <div className="modal-body">
          <div className="segmented">
            <button className={!isExpense ? '' : 'segmented-active'} onClick={() => setIsExpense(true)}>Expense</button>
            <button className={isExpense ? '' : 'segmented-active'} onClick={() => setIsExpense(false)}>Income</button>
          </div>

          <label className="field-label">Amount</label>
          <input
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="amount-input"
          />

          <label className="field-label">Note</label>
          <input type="text" placeholder="e.g. Coles, Netflix" value={note} onChange={(e) => setNote(e.target.value)} list="note-suggestions" />
          {!isExpense && recentContacts.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {recentContacts.map((c) => (
                <button
                  key={c}
                  onClick={() => setNote(c)}
                  style={{ fontSize: 12, padding: '5px 10px', borderRadius: 14, background: 'var(--surface-2)', color: 'var(--text)' }}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
          <datalist id="note-suggestions">
            {(() => {
              const seen = new Set<string>()
              const recent: string[] = []
              for (const t of [...allTransactions].sort((a, b) => b.date.localeCompare(a.date))) {
                const n = t.note.trim()
                if (n && !seen.has(n)) { seen.add(n); recent.push(n) }
                if (recent.length >= 20) break
              }
              return recent.map((n) => <option key={n} value={n} />)
            })()}
          </datalist>
          {matchedRecurring && (
            <p className="hint" style={{ color: 'var(--green)', marginTop: -8, marginBottom: 12 }}>
              ✓ Matches your "{matchedRecurring.note}" recurring ({frequencyLabel(matchedRecurring.frequency)}) — its reserve won't double-count this charge in Safe to Spend.
            </p>
          )}

          <label className="field-label">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

          <label className="field-label">Category</label>
          <button className="picker-row" onClick={() => setShowCategoryPicker(true)}>
            <span>{selectedCategory ? `${selectedCategory.icon} ${selectedCategory.name}` : 'None'}</span>
            <span className="chevron">›</span>
          </button>

          {accounts.length > 0 && (
            <>
              <label className="field-label">Account</label>
              <button className="picker-row" onClick={() => setShowAccountPicker(true)}>
                <span>{selectedAccount ? `${selectedAccount.icon} ${selectedAccount.name}` : 'None (optional)'}</span>
                <span className="chevron">›</span>
              </button>
            </>
          )}

          <label className="field-label">Tags</label>
          <TagEditor tags={tags} onChange={setTags} existingTags={existingTags} />

          {isExpense && transaction && (
            <>
              <label className="field-label">Funded from Savings</label>
              {fundingLinks.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                  {fundingLinks.map((link) => {
                    const account = link.fundedFromAccountId ? accounts.find((a) => a.id === link.fundedFromAccountId) : null
                    return (
                      <div key={link.id} className="picker-row" style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{account ? `${account.icon} ${account.name}` : 'Savings'}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span className="amount">{formatCurrency(link.amount)}</span>
                          <button onClick={() => removeFundingLink(link)} aria-label="Remove funding link" style={{ color: 'var(--red)', fontSize: 14 }}>×</button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              {remainingToFund > 0 && goalAccounts.some((a) => goalProgress(a, allTransactions) > 0) && (
                <button className="text-button" style={{ fontSize: 13, color: 'var(--blue)' }} onClick={() => { setFundAmount(String(remainingToFund)); setShowFundPicker(true) }}>
                  + Fund {fundingLinks.length > 0 ? `remaining ${formatCurrency(remainingToFund)}` : formatCurrency(remainingToFund)} from savings
                </button>
              )}
              {remainingToFund > 0 && goalAccounts.length === 0 && (
                <p className="hint">No savings accounts set up yet — add one with type Savings in More → Accounts first.</p>
              )}
              {remainingToFund > 0 && goalAccounts.length > 0 && !goalAccounts.some((a) => goalProgress(a, allTransactions) > 0) && (
                <p className="hint">You have savings accounts, but none of them have a balance to draw from yet.</p>
              )}
              <p className="hint" style={{ marginTop: 6 }}>
                For money you already set aside — this keeps it counted in your spending history without also counting against this period's Safe to Spend, since it isn't new money leaving your pocket.
              </p>
            </>
          )}

          {!isExpense && (
            <>
              <label className="field-label">Reimburses</label>
              <button className="picker-row" onClick={() => setShowExpensePicker(true)}>
                <span>{reimbursedExpense ? (reimbursedExpense.note || 'Untitled') : 'None (optional)'}</span>
                <span className="chevron">›</span>
              </button>
              {reimbursedExpense && (
                <>
                  <button
                    className="text-button"
                    style={{ fontSize: 13, color: 'var(--blue)', marginTop: 8 }}
                    onClick={() => setShowSplitCalculator((v) => !v)}
                  >
                    {showSplitCalculator ? 'Hide' : '🧮 Split evenly'} calculator
                  </button>
                  {showSplitCalculator && (() => {
                    // Deliberately "one equal share," not "everyone
                    // else's combined share" — matches how these
                    // actually get recorded one at a time (a Beem
                    // "paid to @HNLY" notification per person, not one
                    // lump sum for the whole group), and TagDetail's
                    // own bulk-reimburse flow already covers the
                    // lump-sum case separately.
                    const n = Math.max(1, parseInt(splitPeopleCount, 10) || 1)
                    const share = reimbursedExpense.amount / n
                    return (
                      <div className="card" style={{ marginTop: 8, padding: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                          <span style={{ fontSize: 13 }}>{formatCurrency(reimbursedExpense.amount)} split between</span>
                          <input
                            type="number"
                            inputMode="numeric"
                            value={splitPeopleCount}
                            onChange={(e) => setSplitPeopleCount(e.target.value)}
                            style={{ width: 56, textAlign: 'center' }}
                          />
                          <span style={{ fontSize: 13 }}>people</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Each share</span>
                          <span className="amount" style={{ fontSize: 17, fontWeight: 700 }}>{formatCurrency(share)}</span>
                        </div>
                        <button
                          className="text-button text-button-primary"
                          style={{ width: '100%', marginTop: 10, textAlign: 'center', padding: 8 }}
                          onClick={() => { setAmount(share.toFixed(2)); setShowSplitCalculator(false) }}
                        >
                          Use {formatCurrency(share)}
                        </button>
                      </div>
                    )
                  })()}
                </>
              )}
              {selectedAccount && isSavingsAccount(selectedAccount) && !reimbursesId && (
                <p className="hint hint-warning">
                  Income tied to a savings account won't count toward Saved, and will incorrectly show its balance going UP instead of down. To fund a purchase FROM this account instead, add it on that expense's own edit screen — it'll set this up correctly as a real withdrawal.
                </p>
              )}
              {selectedAccount && isSavingsAccount(selectedAccount) && reimbursesId && (
                <p className="hint hint-warning">
                  This will incorrectly increase {selectedAccount.name}'s balance instead of decreasing it — use "Funded from Savings" on the expense's own edit screen instead of picking this account here directly.
                </p>
              )}
            </>
          )}

          {onDelete && (
            <button className="danger-button" onClick={onDelete}>Delete Transaction</button>
          )}
        </div>
      </div>

      {showCategoryPicker && (() => {
        const { closing: catClosing, requestClose: requestCatClose } = categoryPickerClose
        function selectCategory(id: string | null) {
          requestCatClose(() => { setCategoryId(id); setShowCategoryPicker(false) })
        }
        return (
          <div className={`modal-backdrop${catClosing ? ' modal-closing' : ''}`} onClick={() => requestCatClose(() => setShowCategoryPicker(false))}>
            <div className={`modal-sheet${catClosing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Category</span>
                <button onClick={() => requestCatClose(() => setShowCategoryPicker(false))} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                {(() => {
                  const recentIds: string[] = []
                  for (const t of [...allTransactions].sort((a, b) => b.date.localeCompare(a.date))) {
                    if (t.categoryId && !recentIds.includes(t.categoryId) && t.categoryId !== categoryId) recentIds.push(t.categoryId)
                    if (recentIds.length >= 6) break
                  }
                  const recentCategories = recentIds.map((id) => categories.find((c) => c.id === id)).filter((c): c is Category => !!c)
                  if (recentCategories.length === 0) return null
                  return (
                    <div style={{ display: 'flex', gap: 8, overflowX: 'auto', marginBottom: 16, paddingBottom: 2 }}>
                      {recentCategories.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => selectCategory(c.id)}
                          style={{ whiteSpace: 'nowrap', fontSize: 13, padding: '6px 14px', borderRadius: 16, background: 'var(--surface-2)', display: 'flex', alignItems: 'center', gap: 5 }}
                        >
                          <span>{c.icon}</span><span>{c.name}</span>
                        </button>
                      ))}
                    </div>
                  )
                })()}
                <button className="picker-row" onClick={() => selectCategory(null)}>
                  <span>None</span>
                </button>
                {categories.filter((c) => !c.parentId).map((c) => (
                  <div key={c.id}>
                    <button className="picker-row" onClick={() => selectCategory(c.id)}>
                      <span>{c.icon} {c.name}</span>
                      {categoryId === c.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                    </button>
                    {categories.filter((s) => s.parentId === c.id).map((s) => (
                      <button key={s.id} className="picker-row picker-row-sub" onClick={() => selectCategory(s.id)}>
                        <span>{s.icon} {s.name}</span>
                        {categoryId === s.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {showAccountPicker && (() => {
        const { closing: acctClosing, requestClose: requestAcctClose } = accountPickerClose
        function selectAccount(id: string | null) {
          requestAcctClose(() => { setAccountId(id); setShowAccountPicker(false) })
        }
        return (
          <div className={`modal-backdrop${acctClosing ? ' modal-closing' : ''}`} onClick={() => requestAcctClose(() => setShowAccountPicker(false))}>
            <div className={`modal-sheet${acctClosing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Account</span>
                <button onClick={() => requestAcctClose(() => setShowAccountPicker(false))} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                <button className="picker-row" onClick={() => selectAccount(null)}>
                  <span>None (optional)</span>
                </button>
                {accounts.map((a) => (
                  <button key={a.id} className="picker-row" onClick={() => selectAccount(a.id)}>
                    <span>{a.icon} {a.name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="amount" style={{ fontSize: 13, color: 'var(--text-dim)' }}>{formatCurrency(accountBalance(a, allTransactions))}</span>
                      {accountId === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })()}

      {showExpensePicker && (() => {
        const { closing: expClosing, requestClose: requestExpClose } = expensePickerClose
        function selectExpense(id: string | null) {
          requestExpClose(() => { setReimbursesId(id); setShowExpensePicker(false) })
        }
        return (
          <div className={`modal-backdrop${expClosing ? ' modal-closing' : ''}`} onClick={() => requestExpClose(() => setShowExpensePicker(false))}>
            <div className={`modal-sheet${expClosing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Reimburses Which Expense?</span>
                <button onClick={() => requestExpClose(() => setShowExpensePicker(false))} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                <button className="picker-row" onClick={() => selectExpense(null)}>
                  <span>None</span>
                </button>
                {expenseCandidates.slice(0, 40).map((e) => (
                  <button key={e.id} className="picker-row" onClick={() => selectExpense(e.id)}>
                    <span>{e.note || 'Untitled'} · {new Date(e.date).toLocaleDateString()}</span>
                    <span className="amount">{formatCurrency(e.amount)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )
      })()}
      {showFundPicker && (() => {
        const { closing: fundClosing, requestClose: requestFundClose } = fundPickerClose
        return (
          <div className={`modal-backdrop${fundClosing ? ' modal-closing' : ''}`} onClick={() => requestFundClose(() => setShowFundPicker(false))}>
            <div className={`modal-sheet${fundClosing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <button onClick={() => requestFundClose(() => setShowFundPicker(false))} className="text-button">Cancel</button>
                <span className="modal-title">Fund From Savings</span>
                <span style={{ width: 60 }} />
              </div>
              <div className="modal-body">
                <label className="field-label">Amount to draw</label>
                <input
                  type="number" inputMode="decimal" placeholder="0.00"
                  value={fundAmount}
                  onChange={(e) => setFundAmount(e.target.value)}
                  className="amount-input"
                  style={{ marginBottom: 16 }}
                />
                <p className="hint" style={{ marginTop: -10, marginBottom: 12 }}>Tap a goal below to draw this amount from its balance.</p>
                {(() => {
                  // Sorted highest-balance-first (the ones actually
                  // useful to draw from belong at the top), and a
                  // zero-balance goal is hidden entirely rather than
                  // just shown, since tapping it to "fund" something
                  // makes no real sense.
                  const withBalance = goalAccounts
                    .map((a) => ({ account: a, balance: goalProgress(a, allTransactions) }))
                    .filter((s) => s.balance > 0)
                    .sort((a, b) => b.balance - a.balance)
                  if (withBalance.length === 0) {
                    return <p className="hint">None of your savings accounts have a balance to draw from yet.</p>
                  }
                  return withBalance.map(({ account: a, balance }) => (
                    <button key={a.id} className="picker-row" onClick={() => fundFromSavings(a.id)}>
                      <span>{a.icon} {a.name}</span>
                      <span className="amount" style={{ fontSize: 13, color: 'var(--text-dim)' }}>{formatCurrency(balance)} available</span>
                    </button>
                  ))
                })()}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
