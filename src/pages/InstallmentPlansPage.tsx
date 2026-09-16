import { useState } from 'react'
import type { Category, InstallmentPlan, InstallmentFrequency, Transaction, Account } from '../types'
import { installmentProgress, installmentAmounts, installmentDueDates } from '../installments'
import { formatCurrency, localDateInputValue } from '../calculations'
import { createInstallmentPlan, saveInstallmentPlan, deleteInstallmentPlan } from '../db'
import SwipeableRow from '../components/SwipeableRow'
import { useModalClose } from '../useModalClose'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  transactions: Transaction[]
  installmentPlans: InstallmentPlan[]
  onChanged: () => void
  onBack: () => void
  accounts?: Account[]
}

const FREQUENCY_LABELS: Record<InstallmentFrequency, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly'
}

const COMMON_PROVIDERS = ['Afterpay', 'Zip', 'PayPal Pay in 4', 'Klarna']

export default function InstallmentPlansPage({ categories, transactions, installmentPlans, onChanged, onBack, accounts = [] }: Props) {
  useSwipeBack(onBack)
  const [editingPlan, setEditingPlan] = useState<InstallmentPlan | null>(null)
  const [creatingNew, setCreatingNew] = useState(false)
  const catById = new Map(categories.map((c) => [c.id, c]))

  async function remove(id: string) {
    await deleteInstallmentPlan(id)
    onChanged()
  }

  async function toggleActive(plan: InstallmentPlan) {
    await saveInstallmentPlan({ ...plan, isActive: !plan.isActive })
    onChanged()
  }

  // Active (still being paid off) first, so the ones actually needing
  // attention aren't buried below plans that are already done.
  const sorted = [...installmentPlans].sort((a, b) => {
    const aPaid = installmentProgress(a, transactions).isPaidOff
    const bPaid = installmentProgress(b, transactions).isPaidOff
    if (aPaid !== bPaid) return aPaid ? 1 : -1
    return new Date(a.firstDueDate).getTime() - new Date(b.firstDueDate).getTime()
  })

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Installment Plans</h1>
        <button onClick={() => setCreatingNew(true)} className="text-button text-button-primary" style={{ fontSize: 24, lineHeight: 1 }}>+</button>
      </div>

      {installmentPlans.length === 0 && (
        <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>
          None yet — add an Afterpay, Zip, or Pay-in-4 purchase to track what's left to pay and when each installment is due, without re-entering every payment by hand.
        </p>
      )}

      {sorted.map((plan) => {
        const progress = installmentProgress(plan, transactions)
        const cat = plan.categoryId ? catById.get(plan.categoryId) : undefined
        return (
          <SwipeableRow key={plan.id} onDelete={() => remove(plan.id)} borderRadius={16}>
            <div className="card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div className="tx-icon" style={{ background: (cat?.color ?? '#5C6167') + '33', opacity: plan.isActive ? 1 : 0.5 }}>{cat?.icon ?? '🛍️'}</div>
                <button style={{ flex: 1, textAlign: 'left' }} onClick={() => setEditingPlan(plan)}>
                  <div style={{ fontSize: 14, fontWeight: 600, opacity: plan.isActive ? 1 : 0.6 }}>{plan.note}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{plan.provider} · {progress.paidCount} of {progress.totalCount} paid</div>
                </button>
                <span className="amount" style={{ fontSize: 14 }}>{formatCurrency(plan.totalAmount)}</span>
                {!progress.isPaidOff && (
                  <input type="checkbox" switch checked={plan.isActive} onChange={() => toggleActive(plan)} style={{ width: 18, height: 18 }} />
                )}
              </div>
              <button style={{ display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setEditingPlan(plan)}>
                <div style={{ marginTop: 8, height: 6, borderRadius: 3, background: 'var(--surface-2)', overflow: 'hidden' }}>
                  <div style={{ width: `${(progress.paidCount / progress.totalCount) * 100}%`, height: '100%', background: progress.isPaidOff ? 'var(--green)' : 'var(--blue)' }} />
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: progress.isPaidOff ? 'var(--green)' : !plan.isActive ? 'var(--amber)' : 'var(--text-dim)' }}>
                  {progress.isPaidOff
                    ? '✓ Fully paid off'
                    : !plan.isActive
                      ? `Paused — ${formatCurrency(progress.remainingAmount)} left, won't auto-generate further payments`
                      : `${formatCurrency(progress.remainingAmount)} left · next ${formatCurrency(progress.nextDueAmount ?? 0)} due ${progress.nextDueDate?.toLocaleDateString('en-AU')}`}
                </div>
              </button>
            </div>
          </SwipeableRow>
        )
      })}

      {(editingPlan || creatingNew) && (
        <InstallmentPlanEditor
          plan={editingPlan}
          categories={categories}
          accounts={accounts}
          hasPayments={editingPlan ? transactions.some((t) => t.installmentPlanId === editingPlan.id) : false}
          onSave={async (data) => {
            if (editingPlan) {
              await saveInstallmentPlan({ ...editingPlan, ...data })
            } else {
              await createInstallmentPlan({
                note: data.note ?? '',
                provider: data.provider ?? 'Afterpay',
                totalAmount: data.totalAmount ?? 0,
                numberOfInstallments: data.numberOfInstallments ?? 4,
                frequency: data.frequency ?? 'fortnightly',
                firstDueDate: data.firstDueDate ?? new Date().toISOString(),
                categoryId: data.categoryId ?? null,
                accountId: data.accountId ?? null,
                isActive: true,
                nextInstallmentIndex: 0
              })
            }
            onChanged()
          }}
          onClose={() => { setEditingPlan(null); setCreatingNew(false) }}
        />
      )}
    </div>
  )
}

function InstallmentPlanEditor({ plan, categories, accounts, hasPayments, onSave, onClose }: {
  plan: InstallmentPlan | null
  categories: Category[]
  accounts: Account[]
  hasPayments: boolean
  onSave: (data: Partial<InstallmentPlan>) => void
  onClose: () => void
}) {
  const { closing, requestClose } = useModalClose(onClose)
  const [note, setNote] = useState(plan?.note ?? '')
  const [provider, setProvider] = useState(plan?.provider ?? 'Afterpay')
  const [totalAmount, setTotalAmount] = useState(plan ? String(plan.totalAmount) : '')
  const [numberOfInstallments, setNumberOfInstallments] = useState(plan ? String(plan.numberOfInstallments) : '4')
  const [frequency, setFrequency] = useState<InstallmentFrequency>(plan?.frequency ?? 'fortnightly')
  const [firstDueDate, setFirstDueDate] = useState(localDateInputValue(plan ? new Date(plan.firstDueDate) : new Date()))
  const [categoryId, setCategoryId] = useState<string | null>(plan?.categoryId ?? null)
  const [accountId, setAccountId] = useState<string | null>(plan?.accountId ?? null)
  const [showCategoryPicker, setShowCategoryPicker] = useState(false)
  const [showAccountPicker, setShowAccountPicker] = useState(false)
  const categoryPickerClose = useModalClose(() => setShowCategoryPicker(false))
  const accountPickerClose = useModalClose(() => setShowAccountPicker(false))

  const category = categories.find((c) => c.id === categoryId)
  const account = accounts.find((a) => a.id === accountId)

  const parsedTotal = parseFloat(totalAmount)
  const parsedCount = parseInt(numberOfInstallments, 10)
  const canSave = note.trim() && provider.trim() && !isNaN(parsedTotal) && parsedTotal > 0 && !isNaN(parsedCount) && parsedCount >= 2

  // Live preview of the actual schedule as the person fills the form in
  // — the same rounding-aware split used everywhere else, so what's
  // shown here always matches what will actually get charged.
  const previewAmounts = canSave
    ? installmentAmounts({ totalAmount: parsedTotal, numberOfInstallments: parsedCount } as InstallmentPlan)
    : []
  const previewDates = canSave
    ? installmentDueDates({ firstDueDate: new Date(firstDueDate).toISOString(), frequency, numberOfInstallments: parsedCount } as InstallmentPlan)
    : []

  function handleSave() {
    if (!canSave) return
    const [y, m, d] = firstDueDate.split('-').map(Number)
    onSave({
      note: note.trim(),
      provider: provider.trim(),
      totalAmount: parsedTotal,
      numberOfInstallments: parsedCount,
      frequency,
      firstDueDate: new Date(y, m - 1, d).toISOString(),
      categoryId,
      accountId
    })
    requestClose()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">{plan ? 'Edit Plan' : 'New Installment Plan'}</span>
          <button onClick={handleSave} className="text-button text-button-primary" disabled={!canSave} style={!canSave ? { color: 'var(--text-faint)' } : undefined}>Save</button>
        </div>
        <div className="modal-body">
          <label className="field-label">What did you buy?</label>
          <input type="text" placeholder="e.g. New Laptop" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />

          <label className="field-label" style={{ marginTop: 16 }}>Provider</label>
          <input type="text" placeholder="e.g. Afterpay" value={provider} onChange={(e) => setProvider(e.target.value)} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {COMMON_PROVIDERS.map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                style={{ fontSize: 12, padding: '5px 10px', borderRadius: 12, background: provider === p ? 'var(--blue)' : 'var(--surface-2)', color: provider === p ? '#FFFFFF' : 'var(--text-dim)' }}
              >
                {p}
              </button>
            ))}
          </div>

          <label className="field-label" style={{ marginTop: 16 }}>Total Amount</label>
          <input type="number" inputMode="decimal" placeholder="0.00" value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} className="amount-input" />

          <label className="field-label" style={{ marginTop: 16 }}>Number of Installments</label>
          <input type="number" inputMode="numeric" value={numberOfInstallments} onChange={(e) => setNumberOfInstallments(e.target.value)} disabled={hasPayments} />
          {hasPayments && <p className="hint" style={{ marginTop: 6 }}>Can't change the count once payments exist — delete and recreate the plan instead if this needs to change.</p>}

          <label className="field-label" style={{ marginTop: 16 }}>Frequency</label>
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as InstallmentFrequency)} disabled={hasPayments}>
            {(Object.keys(FREQUENCY_LABELS) as InstallmentFrequency[]).map((f) => (
              <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
            ))}
          </select>

          <label className="field-label" style={{ marginTop: 16 }}>First Payment Date</label>
          <input type="date" value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)} disabled={hasPayments} />

          <label className="field-label" style={{ marginTop: 16 }}>Category</label>
          <button className="picker-row" onClick={() => setShowCategoryPicker(true)}>
            <span>{category ? `${category.icon} ${category.name}` : 'None'}</span>
            <span className="chevron">›</span>
          </button>

          {accounts.length > 0 && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>Account</label>
              <button className="picker-row" onClick={() => setShowAccountPicker(true)}>
                <span>{account ? `${account.icon} ${account.name}` : 'None (optional)'}</span>
                <span className="chevron">›</span>
              </button>
            </>
          )}

          {canSave && previewAmounts.length > 0 && (
            <div className="card" style={{ marginTop: 20 }}>
              <span className="section-heading" style={{ margin: '0 0 8px' }}>Schedule Preview</span>
              {previewAmounts.map((amt, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-dim)' }}>{previewDates[i]?.toLocaleDateString('en-AU')}</span>
                  <span className="amount">{formatCurrency(amt)}</span>
                </div>
              ))}
            </div>
          )}

          <p className="hint" style={{ marginTop: 16 }}>
            Each payment is created automatically as it comes due, the same way recurring bills are — nothing to enter by hand as it goes.
          </p>
        </div>

        {showCategoryPicker && (() => {
          const { closing: cc, requestClose: rcc } = categoryPickerClose
          function pick(id: string | null) { rcc(() => { setCategoryId(id); setShowCategoryPicker(false) }) }
          return (
            <div className={`modal-backdrop${cc ? ' modal-closing' : ''}`} onClick={() => rcc(() => setShowCategoryPicker(false))}>
              <div className={`modal-sheet${cc ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">Category</span>
                  <button onClick={() => rcc(() => setShowCategoryPicker(false))} className="text-button text-button-primary">Done</button>
                </div>
                <div className="modal-body">
                  <button className="picker-row" onClick={() => pick(null)}>
                    <span>None</span>
                    {!categoryId && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                  {categories.filter((c) => !c.parentId && !c.isSavingsCategory).map((c) => (
                    <button key={c.id} className="picker-row" onClick={() => pick(c.id)}>
                      <span>{c.icon} {c.name}</span>
                      {categoryId === c.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )
        })()}

        {showAccountPicker && (() => {
          const { closing: ac, requestClose: rac } = accountPickerClose
          function pick(id: string | null) { rac(() => { setAccountId(id); setShowAccountPicker(false) }) }
          return (
            <div className={`modal-backdrop${ac ? ' modal-closing' : ''}`} onClick={() => rac(() => setShowAccountPicker(false))}>
              <div className={`modal-sheet${ac ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">Account</span>
                  <button onClick={() => rac(() => setShowAccountPicker(false))} className="text-button text-button-primary">Done</button>
                </div>
                <div className="modal-body">
                  <button className="picker-row" onClick={() => pick(null)}>
                    <span>None (optional)</span>
                    {!accountId && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                  {accounts.map((a) => (
                    <button key={a.id} className="picker-row" onClick={() => pick(a.id)}>
                      <span>{a.icon} {a.name}</span>
                      {accountId === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}
