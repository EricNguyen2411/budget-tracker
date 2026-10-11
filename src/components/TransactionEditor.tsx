import { useEffect, useState } from 'react'
import type { Category, RecurringTransaction, Transaction } from '../types'
import { formatCurrency, localDateInputValue, savingsBalance, totalReimbursed, matchingRecurringItem, findFundedExpense } from '../calculations'
import { learnMerchant, suggestCategoryId } from '../merchantRules'
import { recordReimbursementContact, getRecentReimbursementContacts } from '../reimbursementContacts'
import { allTagsFrom, dedupeTags } from '../tags'
import { deleteTransaction, fundExpensesFromSavings } from '../db'
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
}

export default function TransactionEditor(props: Props) {
  const { transaction, categories, allTransactions, onClose, onChanged } = props
  // A Fund From Savings record is a thin link, not a transaction with
  // independent meaning of its own — the expense it funds keeps its full
  // normal editor (category, tags, date all still matter there), but
  // tapping this side specifically shows a compact view instead of a
  // mostly-irrelevant category picker and Reimburses field.
  const fundedExpense = transaction ? findFundedExpense(transaction, allTransactions) : null
  if (transaction && fundedExpense) {
    return <FundingLinkView transaction={transaction} fundedExpense={fundedExpense} categories={categories} onClose={onClose} onChanged={onChanged} />
  }
  return <RegularTransactionEditor {...props} />
}

function FundingLinkView({ transaction, fundedExpense, categories, onClose, onChanged }: { transaction: Transaction; fundedExpense: Transaction; categories: Category[]; onClose: () => void; onChanged?: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  const fundingCategory = transaction.fundedFromCategoryId ? categories.find((c) => c.id === transaction.fundedFromCategoryId) : null

  async function handleRemove() {
    // One record, not a pair: deleting it gives the money straight back
    // to the savings category and un-covers the expense.
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
              This covers <span className="amount" style={{ fontWeight: 700 }}>{formatCurrency(transaction.amount)}</span> of "{fundedExpense.note || 'that expense'}" from {fundingCategory ? `${fundingCategory.icon} ${fundingCategory.name}` : 'savings'}.
            </p>
          </div>
          <p className="hint" style={{ marginBottom: 20 }}>
            To change the amount, category, or date of "{fundedExpense.note || 'the expense'}" itself, open it directly from the transactions list — this record is just the funding link between the two. Removing it puts the money back into {fundingCategory ? fundingCategory.name : 'the savings category'}.
          </p>
          <button className="danger-button" onClick={handleRemove}>Remove Funding</button>
        </div>
      </div>
    </div>
  )
}

function RegularTransactionEditor({ transaction, categories, allTransactions, onSave, onDelete, onClose, onChanged, recurring = [] }: Props) {
  const { closing, requestClose } = useModalClose(onClose)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [showExpensePicker, setShowExpensePicker] = useState(false)
  const categoryPickerClose = useModalClose(() => setShowCategoryPicker(false))
  const expensePickerClose = useModalClose(() => setShowExpensePicker(false))
  const [amount, setAmount] = useState(transaction ? String(transaction.amount) : '')
  const [note, setNote] = useState(transaction?.note ?? '')
  const [recentContacts] = useState(() => getRecentReimbursementContacts())
  const [date, setDate] = useState(transaction ? localDateInputValue(new Date(transaction.date)) : localDateInputValue(new Date()))
  const [isExpense, setIsExpense] = useState(transaction?.isExpense ?? true)
  const [categoryId, setCategoryId] = useState<string | null>(transaction?.categoryId ?? null)
  const [reimbursesId, setReimbursesId] = useState<string | null>(transaction?.reimbursesExpenseId ?? null)
  const [showSplitCalculator, setShowSplitCalculator] = useState(false)
  const [splitPeopleCount, setSplitPeopleCount] = useState('2')
  const [tags, setTags] = useState<string[]>(transaction?.tags ?? [])

  const existingTags = allTagsFrom(allTransactions)

  const selectedCategory = categories.find((c) => c.id === categoryId)
  // Confirms, directly on the transaction, that this exact charge is
  // recognized as covering an active recurring item — added so that
  // isn't something only checkable by reading the Safe to Spend math.
  const matchedRecurring = isExpense && note.trim() ? matchingRecurringItem({ note, isExpense, amount: parseFloat(amount) } as Transaction, recurring) : null
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
    ? allTransactions.filter((t) => t.reimbursesExpenseId === transaction.id && !!t.fundedFromCategoryId)
    : []
  const totalFunded = transaction ? totalReimbursed(transaction, allTransactions) : 0
  const remainingToFund = transaction ? Math.max(0, transaction.amount - totalFunded) : 0
  const savingsCategories = categories.filter((c) => c.isSavingsCategory)

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
      reimbursesExpenseId: isExpense ? null : reimbursesId,
      tags: dedupeTags(tags),
      // The marker that makes income-direction money in a savings category
      // a withdrawal rather than real income: set whenever this is income
      // in a savings category (a plain "taken out of savings", or one
      // that covers expenses), kept as-is on a multi-expense funding
      // payment, and cleared for anything else — so changing the
      // category or direction can't leave a stale marker behind.
      fundedFromCategoryId: isExpense
        ? undefined
        : transaction?.multiAllocations && transaction.multiAllocations.length > 0
          ? transaction.fundedFromCategoryId ?? undefined
          : categories.find((c) => c.id === effectiveCategoryId)?.isSavingsCategory
            ? effectiveCategoryId ?? undefined
            : undefined,
      // This form has no fields for these — they aren't something a
      // person edits directly here, they're internal links written by
      // other flows (a bulk multi-expense payment, an auto-generated
      // installment). Carried through untouched from whatever this
      // transaction already had, rather than left out of the object
      // literal: leaving them out doesn't just leave them "unchanged,"
      // it actively overwrites them to undefined on save, since
      // saveTransaction does a full record replace (db.put), not a merge.
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

  async function fundFromSavings(fromCategoryId: string) {
    if (!transaction) return
    const parsed = parseFloat(fundAmount)
    if (isNaN(parsed) || parsed <= 0) return
    // One income-direction record in the savings category, linked to this
    // expense and carrying the savings marker: it covers the expense,
    // reduces the category's balance, and never counts as income.
    await fundExpensesFromSavings({
      categoryId: fromCategoryId,
      allocations: [{ expenseId: transaction.id, amount: parsed }],
      date: new Date().toISOString(),
      note: transaction.note ? `Re: ${transaction.note}` : undefined
    })
    onChanged?.()
    setShowFundPicker(false)
    setFundAmount('')
  }

  async function removeFundingLink(offset: Transaction) {
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

          {selectedCategory?.isSavingsCategory && (
            <p className="hint" style={{ marginTop: 6 }}>
              {isExpense
                ? `Counts as money added to ${selectedCategory.name} — not as spending.`
                : reimbursesId
                  ? `Counts as money taken out of ${selectedCategory.name} to cover that expense — not as income.`
                  : `Counts as money taken out of ${selectedCategory.name} — not as income.`}
            </p>
          )}

          <label className="field-label">Tags</label>
          <TagEditor tags={tags} onChange={setTags} existingTags={existingTags} />

          {isExpense && transaction && !selectedCategory?.isSavingsCategory && (
            <>
              <label className="field-label">Funded from Savings</label>
              {fundingLinks.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                  {fundingLinks.map((link) => {
                    const account = link.fundedFromCategoryId ? categories.find((c) => c.id === link.fundedFromCategoryId) : null
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
              {remainingToFund > 0 && savingsCategories.some((c) => savingsBalance(c, allTransactions) > 0) && (
                <button className="text-button" style={{ fontSize: 13, color: 'var(--blue)' }} onClick={() => { setFundAmount(String(remainingToFund)); setShowFundPicker(true) }}>
                  + Fund {fundingLinks.length > 0 ? `remaining ${formatCurrency(remainingToFund)}` : formatCurrency(remainingToFund)} from savings
                </button>
              )}
              {remainingToFund > 0 && savingsCategories.length === 0 && (
                <p className="hint">No savings categories set up yet — turn one on in More → Categories first.</p>
              )}
              {remainingToFund > 0 && savingsCategories.length > 0 && !savingsCategories.some((c) => savingsBalance(c, allTransactions) > 0) && (
                <p className="hint">You have savings categories, but none of them have a balance to draw from yet.</p>
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
                <p className="hint" style={{ marginTop: -10, marginBottom: 12 }}>Tap a savings category below to draw this amount from its balance.</p>
                {(() => {
                  // Sorted highest-balance-first (the ones actually
                  // useful to draw from belong at the top), and a
                  // zero-balance goal is hidden entirely rather than
                  // just shown, since tapping it to "fund" something
                  // makes no real sense.
                  const withBalance = savingsCategories
                    .map((a) => ({ account: a, balance: savingsBalance(a, allTransactions) }))
                    .filter((s) => s.balance > 0)
                    .sort((a, b) => b.balance - a.balance)
                  if (withBalance.length === 0) {
                    return <p className="hint">None of your savings categories have a balance to draw from yet.</p>
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
