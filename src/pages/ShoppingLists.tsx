import { useState } from 'react'
import type { Category, ShoppingList, ShoppingListItem, Transaction } from '../types'
import { formatCurrency, effectiveBudget, netSpentForCategory } from '../calculations'
import { createShoppingList, saveShoppingList, deleteShoppingList, createTransaction, newId } from '../db'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  lists: ShoppingList[]
  categories: Category[]
  transactions: Transaction[]
  onChanged: () => void
}

export default function ShoppingLists({ lists, categories, transactions, onChanged }: Props) {
  const [openListId, setOpenListId] = useState<string | null>(null)
  const [newListName, setNewListName] = useState('')

  const openList = lists.find((l) => l.id === openListId)

  async function addList() {
    if (!newListName.trim()) return
    const list = await createShoppingList({ name: newListName.trim(), categoryId: null, sortOrder: lists.length, items: [] })
    setNewListName('')
    onChanged()
    setOpenListId(list.id)
  }

  if (openList) {
    return (
      <ShoppingListDetail
        list={openList}
        categories={categories}
        transactions={transactions}
        onBack={() => setOpenListId(null)}
        onChanged={onChanged}
      />
    )
  }

  return (
    <div className="screen">
      <h1 className="screen-title">Shopping Lists</h1>
      {lists.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 16 }}>No lists yet — great for live-tracking a grocery run against your budget.</p>}
      {lists.map((list) => {
        const runningTotal = list.items.filter((i) => i.isChecked).reduce((s, i) => s + i.estimatedPrice * i.quantity, 0)
        return (
          <button key={list.id} className="card" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 10 }} onClick={() => setOpenListId(list.id)}>
            <div style={{ fontWeight: 600 }}>{list.name}</div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>
              {list.items.length} item{list.items.length === 1 ? '' : 's'} · {formatCurrency(runningTotal)} in cart
            </div>
          </button>
        )
      })}
      <div className="card" style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <input placeholder="New list name" value={newListName} onChange={(e) => setNewListName(e.target.value)} style={{ flex: 1 }} />
        <button style={{ color: 'var(--blue)', fontWeight: 600, padding: '0 8px' }} onClick={addList}>Add</button>
      </div>
    </div>
  )
}

function ShoppingListDetail({ list, categories, transactions, onBack, onChanged }: {
  list: ShoppingList
  categories: Category[]
  transactions: Transaction[]
  onBack: () => void
  onChanged: () => void
}) {
  useSwipeBack(onBack)
  const [itemName, setItemName] = useState('')
  const [itemPrice, setItemPrice] = useState('')
  const [editingItem, setEditingItem] = useState<ShoppingListItem | null>(null)
  const category = categories.find((c) => c.id === list.categoryId)

  const runningTotal = list.items.filter((i) => i.isChecked).reduce((s, i) => s + i.estimatedPrice * i.quantity, 0)
  const remainingAfterCart = category
    ? effectiveBudget(category, categories) - Math.max(0, netSpentForCategory(category, categories, transactions, new Date())) - runningTotal
    : null

  async function addItem() {
    if (!itemName.trim()) return
    const item: ShoppingListItem = {
      id: newId(),
      name: itemName.trim(),
      estimatedPrice: parseFloat(itemPrice) || 0,
      quantity: 1,
      isChecked: false,
      sortOrder: list.items.length
    }
    await saveShoppingList({ ...list, items: [...list.items, item] })
    setItemName('')
    setItemPrice('')
    onChanged()
  }

  async function toggleItem(id: string) {
    await saveShoppingList({ ...list, items: list.items.map((i) => i.id === id ? { ...i, isChecked: !i.isChecked } : i) })
    onChanged()
  }

  async function updateItem(id: string, name: string, price: number) {
    await saveShoppingList({ ...list, items: list.items.map((i) => i.id === id ? { ...i, name, estimatedPrice: price } : i) })
    onChanged()
  }

  async function removeItem(id: string) {
    await saveShoppingList({ ...list, items: list.items.filter((i) => i.id !== id) })
    onChanged()
  }

  async function completeTrip() {
    if (runningTotal <= 0) { onBack(); return }
    await createTransaction({
      amount: runningTotal,
      note: list.name,
      date: new Date().toISOString(),
      isExpense: true,
      categoryId: list.categoryId,
      reimbursesExpenseId: null
    })
    await saveShoppingList({ ...list, items: list.items.map((i) => ({ ...i, isChecked: false })) })
    onChanged()
    onBack()
  }

  async function removeList() {
    await deleteShoppingList(list.id)
    onChanged()
    onBack()
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Back</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>{list.name}</h1>
        <button onClick={removeList} style={{ color: 'var(--red)', fontSize: 13 }}>Delete</button>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
          <span>In cart</span>
          <span className="amount" style={{ fontWeight: 600 }}>{formatCurrency(runningTotal)}</span>
        </div>
        {remainingAfterCart !== null && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: remainingAfterCart < 0 ? 'var(--red)' : 'var(--text-dim)', marginTop: 4 }}>
            <span>Left in {category?.name} after this</span>
            <span className="amount">{formatCurrency(remainingAfterCart)}</span>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
        {list.items.length === 0 && <p style={{ padding: 16, fontSize: 13, color: 'var(--text-dim)' }}>No items yet.</p>}
        {list.items.map((item, i) => (
          <div key={item.id} className="transaction-row" style={{ borderBottom: i < list.items.length - 1 ? '1px solid var(--border)' : 'none' }}>
            <input type="checkbox" checked={item.isChecked} onChange={() => toggleItem(item.id)} style={{ width: 18, height: 18 }} />
            <button className="tx-info" style={{ textAlign: 'left' }} onClick={() => setEditingItem(item)}>
              <span className="tx-note" style={{ textDecoration: item.isChecked ? 'line-through' : 'none', opacity: item.isChecked ? 0.5 : 1 }}>{item.name}</span>
            </button>
            <span className="amount">{formatCurrency(item.estimatedPrice)}</span>
            <button onClick={() => removeItem(item.id)} style={{ color: 'var(--text-faint)', marginLeft: 8 }}>✕</button>
          </div>
        ))}
      </div>

      <div className="card" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input placeholder="Item" value={itemName} onChange={(e) => setItemName(e.target.value)} style={{ flex: 2 }} />
        <input placeholder="Price" type="number" inputMode="decimal" value={itemPrice} onChange={(e) => setItemPrice(e.target.value)} style={{ flex: 1 }} />
        <button style={{ color: 'var(--blue)', fontWeight: 600, padding: '0 8px' }} onClick={addItem}>Add</button>
      </div>

      <button className="list-button" style={{ width: '100%', textAlign: 'center', background: 'var(--blue)', color: '#FFFFFF', borderRadius: 10, padding: 12, fontWeight: 600 }} onClick={completeTrip}>
        Complete Trip → Log {formatCurrency(runningTotal)}
      </button>

      {editingItem && (
        <ItemEditor item={editingItem} onSave={updateItem} onClose={() => setEditingItem(null)} />
      )}
    </div>
  )
}

function ItemEditor({ item, onSave, onClose }: { item: ShoppingListItem; onSave: (id: string, name: string, price: number) => void; onClose: () => void }) {
  const [name, setName] = useState(item.name)
  const [price, setPrice] = useState(String(item.estimatedPrice))

  function handleSave() {
    if (!name.trim()) return
    onSave(item.id, name.trim(), parseFloat(price) || 0)
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={onClose} className="text-button">Cancel</button>
          <span className="modal-title">Edit Item</span>
          <button onClick={handleSave} className="text-button text-button-primary">Save</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="field-label">Price</label>
          <input type="number" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
      </div>
    </div>
  )
}
