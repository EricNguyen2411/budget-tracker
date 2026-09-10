import { useState } from 'react'
import type { Account, AccountType, Transaction } from '../types'
import { createAccount, saveAccount, archiveAccount, createTransfer } from '../db'
import { accountBalance, formatCurrency, localDateInputValue } from '../calculations'
import { useSwipeBack } from '../useSwipeBack'
import { useModalClose } from '../useModalClose'
import { getImportAccountMapping, saveImportAccountMapping, IMPORT_SOURCE_LABELS, type ImportSource } from '../importSettings'
import { getSettings, updateSettings } from '../budgetPeriod'

interface Props {
  accounts: Account[]
  transactions: Transaction[]
  onBack: () => void
  onChanged: () => void
  onOpenAccount: (account: Account) => void
}

const TYPE_LABELS: Record<AccountType, string> = {
  bank: 'Bank Account',
  credit_card: 'Credit Card',
  savings: 'Savings Account',
  cash: 'Cash',
  other: 'Other'
}

const TYPE_ICONS: Record<AccountType, string> = {
  bank: '🏦',
  credit_card: '💳',
  savings: '💰',
  cash: '💵',
  other: '📦'
}

export default function AccountsScreen({ accounts, transactions, onBack, onChanged, onOpenAccount }: Props) {
  useSwipeBack(onBack)
  const [editing, setEditing] = useState<Account | 'new' | null>(null)
  const [showTransfer, setShowTransfer] = useState(false)
  const [showImportDefaults, setShowImportDefaults] = useState(false)
  const [showDefaultAccount, setShowDefaultAccount] = useState(false)
  const [defaultAccountId, setDefaultAccountId] = useState(getSettings().defaultAccountId)
  const defaultAccount = accounts.find((a) => a.id === defaultAccountId)

  const totalNetWorth = accounts
    .filter((a) => a.type !== 'credit_card')
    .reduce((sum, a) => sum + accountBalance(a, transactions), 0)
    - accounts.filter((a) => a.type === 'credit_card').reduce((sum, a) => sum + accountBalance(a, transactions), 0)

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ More</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Accounts</h1>
        <button onClick={() => setEditing('new')} className="text-button text-button-primary" style={{ fontSize: 22 }}>+</button>
      </div>

      {accounts.length > 0 && (
        <div className="card hero-card" style={{ marginBottom: 16 }}>
          <span className="hero-label">Net Worth</span>
          <span className="hero-amount amount" style={{ fontSize: 30 }}>{formatCurrency(totalNetWorth)}</span>
          <span style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>Everything you have minus what's on credit cards</span>
        </div>
      )}

      {accounts.length >= 2 && (
        <button
          onClick={() => setShowTransfer(true)}
          className="card"
          style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left' }}
        >
          <span style={{ fontSize: 20 }}>↔️</span>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Transfer Between Accounts</span>
        </button>
      )}

      {accounts.length === 0 ? (
        <div className="card">
          <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 10 }}>
            No accounts set up yet. Add your bank account, credit card, or savings account to see real balances here — separate from the category budgets you're already tracking.
          </p>
          <p className="hint">
            Balances update automatically from transactions you tag with an account, and there's a one-tap way to correct them whenever they drift from what your bank actually shows.
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {accounts.map((a, i) => {
            const balance = accountBalance(a, transactions)
            const isDebt = a.type === 'credit_card'
            return (
              <button
                key={a.id}
                className="transaction-row"
                style={{ borderBottom: i < accounts.length - 1 ? '1px solid var(--border)' : 'none' }}
                onClick={() => onOpenAccount(a)}
              >
                <div className="tx-icon" style={{ background: (a.color ?? '#5C6167') + '33' }}>{a.icon}</div>
                <div className="tx-info">
                  <span className="tx-note">{a.name}</span>
                  <span className="tx-category">{TYPE_LABELS[a.type]}</span>
                </div>
                <span className="amount tx-amount" style={{ color: isDebt && balance > 0 ? 'var(--red)' : 'var(--text)' }}>
                  {isDebt && balance > 0 ? `Owing ${formatCurrency(balance)}` : formatCurrency(balance)}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {accounts.length > 0 && (
        <button className="card" style={{ marginTop: 16, display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setShowImportDefaults(true)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>📥 Import Defaults</span>
            <span className="chevron">›</span>
          </div>
          <p className="hint" style={{ marginTop: 4 }}>Which account NAB, Westpac, and Beem imports go to automatically.</p>
        </button>
      )}

      {accounts.length > 0 && (
        <button className="card" style={{ marginTop: 16, display: 'block', width: '100%', textAlign: 'left' }} onClick={() => setShowDefaultAccount(true)}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>⚡ Default Account</span>
            <span className="chevron">›</span>
          </div>
          <p className="hint" style={{ marginTop: 4 }}>
            {defaultAccount ? `${defaultAccount.icon} ${defaultAccount.name}` : 'None'} — used for Quick Add and completed shopping trips.
          </p>
        </button>
      )}

      {editing && (
        <AccountEditorModal
          account={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onChanged() }}
        />
      )}

      {showTransfer && (
        <TransferModal
          accounts={accounts}
          transactions={transactions}
          onClose={() => setShowTransfer(false)}
          onDone={() => { setShowTransfer(false); onChanged() }}
        />
      )}

      {showImportDefaults && (
        <ImportDefaultsModal accounts={accounts} onClose={() => setShowImportDefaults(false)} />
      )}

      {showDefaultAccount && (
        <DefaultAccountModal
          accounts={accounts}
          current={defaultAccountId}
          onClose={() => setShowDefaultAccount(false)}
          onSaved={(id) => { setDefaultAccountId(id); setShowDefaultAccount(false) }}
        />
      )}
    </div>
  )
}

function DefaultAccountModal({ accounts, current, onClose, onSaved }: { accounts: Account[]; current: string | null; onClose: () => void; onSaved: (id: string | null) => void }) {
  const { closing, requestClose } = useModalClose(onClose)

  function pick(id: string | null) {
    updateSettings({ defaultAccountId: id })
    onSaved(id)
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ width: 60 }} />
          <span className="modal-title">Default Account</span>
          <button onClick={() => requestClose()} className="text-button text-button-primary">Done</button>
        </div>
        <div className="modal-body">
          <p className="hint" style={{ marginBottom: 16 }}>
            Quick Add and completed shopping trips don't show an account picker in the moment — this is what they'll use instead. You can always change it afterward on the transaction itself.
          </p>
          <button className="picker-row" onClick={() => requestClose(() => pick(null))}>
            <span>None</span>
            {!current && <span style={{ color: 'var(--blue)' }}>✓</span>}
          </button>
          {accounts.map((a) => (
            <button key={a.id} className="picker-row" onClick={() => requestClose(() => pick(a.id))}>
              <span>{a.icon} {a.name}</span>
              {current === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function ImportDefaultsModal({ accounts, onClose }: { accounts: Account[]; onClose: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  const [mapping, setMapping] = useState(getImportAccountMapping())
  const [pickerFor, setPickerFor] = useState<ImportSource | null>(null)

  function setSource(source: ImportSource, accountId: string | null) {
    const next = { ...mapping, [source]: accountId }
    setMapping(next)
    saveImportAccountMapping(next)
    setPickerFor(null)
  }

  const sources: ImportSource[] = ['nab', 'westpac', 'beem']

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span style={{ width: 60 }} />
          <span className="modal-title">Import Defaults</span>
          <button onClick={() => requestClose()} className="text-button text-button-primary">Done</button>
        </div>
        <div className="modal-body">
          <p className="hint" style={{ marginBottom: 16 }}>
            When you import a screenshot, transactions from each source are automatically assigned to the account you pick here — you can still change it per import.
          </p>
          {sources.map((source) => {
            const account = accounts.find((a) => a.id === mapping[source])
            return (
              <div key={source} style={{ marginBottom: 16 }}>
                <label className="field-label">{IMPORT_SOURCE_LABELS[source]}</label>
                <button className="picker-row" onClick={() => setPickerFor(source)}>
                  <span>{account ? `${account.icon} ${account.name}` : 'None'}</span>
                  <span className="chevron">›</span>
                </button>
              </div>
            )
          })}
        </div>

        {pickerFor && (
          <div className="modal-backdrop" onClick={() => setPickerFor(null)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">{IMPORT_SOURCE_LABELS[pickerFor]} Imports Go To</span>
                <button onClick={() => setPickerFor(null)} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                <button className="picker-row" onClick={() => setSource(pickerFor, null)}>
                  <span>None</span>
                  {!mapping[pickerFor] && <span style={{ color: 'var(--blue)' }}>✓</span>}
                </button>
                {accounts.map((a) => (
                  <button key={a.id} className="picker-row" onClick={() => setSource(pickerFor, a.id)}>
                    <span>{a.icon} {a.name}</span>
                    {mapping[pickerFor] === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
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

function TransferModal({ accounts, transactions, onClose, onDone }: { accounts: Account[]; transactions: Transaction[]; onClose: () => void; onDone: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  const [fromId, setFromId] = useState(accounts[0]?.id ?? '')
  const [toId, setToId] = useState(accounts[1]?.id ?? accounts[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(localDateInputValue(new Date()))
  const [showFromPicker, setShowFromPicker] = useState(false)
  const [showToPicker, setShowToPicker] = useState(false)

  const fromAccount = accounts.find((a) => a.id === fromId)
  const toAccount = accounts.find((a) => a.id === toId)
  const parsed = parseFloat(amount)
  const canSubmit = fromId && toId && fromId !== toId && !isNaN(parsed) && parsed > 0

  async function handleSubmit() {
    if (!canSubmit) return
    const [y, m, d] = date.split('-').map(Number)
    await createTransfer({
      fromAccountId: fromId,
      toAccountId: toId,
      amount: parsed,
      date: new Date(y, m - 1, d).toISOString(),
      note
    })
    onDone()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">Transfer</span>
          <button onClick={() => requestClose(handleSubmit)} className="text-button text-button-primary" disabled={!canSubmit} style={!canSubmit ? { color: 'var(--text-faint)' } : undefined}>Save</button>
        </div>
        <div className="modal-body">
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
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className="amount" style={{ fontSize: 13, color: 'var(--text-dim)' }}>{formatCurrency(accountBalance(a, transactions))}</span>
                      {fromId === a.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                    </span>
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

function AccountEditorModal({ account, onClose, onSaved }: { account: Account | null; onClose: () => void; onSaved: () => void }) {
  const { closing, requestClose } = useModalClose(onClose)
  const [name, setName] = useState(account?.name ?? '')
  const [type, setType] = useState<AccountType>(account?.type ?? 'bank')
  const [openingBalance, setOpeningBalance] = useState(account ? String(account.openingBalance) : '')
  const [interestRate, setInterestRate] = useState(account?.interestRate ? String(account.interestRate) : '')
  const [showTypePicker, setShowTypePicker] = useState(false)

  async function handleSave() {
    const parsed = parseFloat(openingBalance) || 0
    const parsedRate = parseFloat(interestRate)
    const rate = interestRate.trim() && !isNaN(parsedRate) ? parsedRate : null
    if (!name.trim()) return
    if (account) {
      await saveAccount({ ...account, name: name.trim(), type, interestRate: rate })
    } else {
      await createAccount({
        name: name.trim(),
        icon: TYPE_ICONS[type],
        color: type === 'credit_card' ? '#FF6B6B' : '#0A84FF',
        type,
        openingBalance: parsed,
        openingDate: new Date().toISOString(),
        sortOrder: 999,
        isArchived: false,
        interestRate: rate
      })
    }
    onSaved()
  }

  async function handleArchive() {
    if (!account) return
    await archiveAccount(account.id)
    onSaved()
  }

  return (
    <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
      <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={() => requestClose()} className="text-button">Cancel</button>
          <span className="modal-title">{account ? 'Edit Account' : 'New Account'}</span>
          <button onClick={() => requestClose(handleSave)} className="text-button text-button-primary">Save</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Name</label>
          <input type="text" placeholder="e.g. Everyday Account" value={name} onChange={(e) => setName(e.target.value)} autoFocus />

          <label className="field-label" style={{ marginTop: 16 }}>Type</label>
          <button className="picker-row" onClick={() => setShowTypePicker(true)}>
            <span>{TYPE_ICONS[type]} {TYPE_LABELS[type]}</span>
            <span className="chevron">›</span>
          </button>

          {!account && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>
                {type === 'credit_card' ? 'Current amount owing' : 'Current balance'}
              </label>
              <input type="number" inputMode="decimal" placeholder="0.00" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} className="amount-input" />
              <p className="hint" style={{ marginTop: 6 }}>
                What your bank app shows right now — everything is calculated forward from this starting point.
              </p>
            </>
          )}

          {type !== 'credit_card' && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>Interest Rate (% p.a., optional)</label>
              <input type="number" inputMode="decimal" placeholder="e.g. 4.50" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} />
              <p className="hint" style={{ marginTop: 6 }}>
                If this account earns interest, set the annual rate here — you'll get a button to calculate and add each month's interest based on your actual daily balance.
              </p>
            </>
          )}

          {account && (
            <button onClick={handleArchive} style={{ color: 'var(--red)', fontSize: 14, marginTop: 24 }}>
              Archive this account
            </button>
          )}
        </div>

        {showTypePicker && (
          <div className="modal-backdrop" onClick={() => setShowTypePicker(false)}>
            <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <span className="modal-title">Account Type</span>
                <button onClick={() => setShowTypePicker(false)} className="text-button text-button-primary">Done</button>
              </div>
              <div className="modal-body">
                {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
                  <button key={t} className="picker-row" onClick={() => { setType(t); setShowTypePicker(false) }}>
                    <span>{TYPE_ICONS[t]} {TYPE_LABELS[t]}</span>
                    {type === t && <span style={{ color: 'var(--blue)' }}>✓</span>}
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
