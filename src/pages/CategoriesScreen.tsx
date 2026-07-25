import { useState } from 'react'
import type { Category } from '../types'
import { createCategory, saveCategory, deleteCategory } from '../db'
import { localDateInputValue } from '../calculations'
import { useSwipeBack } from '../useSwipeBack'

interface Props {
  categories: Category[]
  onBack: () => void
  onChanged: () => void
}

export default function CategoriesScreen({ categories, onBack, onChanged }: Props) {
  useSwipeBack(onBack)
  const [editingCategory, setEditingCategory] = useState<Category | 'new' | null>(null)

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Settings</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Categories</h1>
        <span style={{ width: 60 }} />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {categories.filter((c) => !c.parentId).map((c) => {
          const subs = categories.filter((s) => s.parentId === c.id)
          return (
            <div key={c.id}>
              <button className="transaction-row" style={{ borderBottom: '1px solid var(--border)' }} onClick={() => setEditingCategory(c)}>
                <div className="tx-icon" style={{ background: c.color + '33' }}>{c.icon}</div>
                <div className="tx-info">
                  <span className="tx-note">{c.name}</span>
                  {c.isSavingsCategory && <span className="tx-category">Savings</span>}
                </div>
                <span className="chevron">›</span>
              </button>
              {subs.map((s) => (
                <button key={s.id} className="transaction-row" style={{ borderBottom: '1px solid var(--border)', paddingLeft: 34 }} onClick={() => setEditingCategory(s)}>
                  <div className="tx-icon" style={{ background: s.color + '33', width: 30, height: 30 }}>{s.icon}</div>
                  <div className="tx-info"><span className="tx-note" style={{ fontSize: 14 }}>{s.name}</span></div>
                  <span className="chevron">›</span>
                </button>
              ))}
            </div>
          )
        })}
        <button className="transaction-row" onClick={() => setEditingCategory('new')}>
          <div className="tx-info"><span className="tx-note" style={{ color: 'var(--blue)' }}>+ Add Category</span></div>
        </button>
      </div>

      {editingCategory && (
        <CategoryEditor
          category={editingCategory === 'new' ? null : editingCategory}
          allCategories={categories}
          onClose={() => setEditingCategory(null)}
          onChanged={onChanged}
        />
      )}
    </div>
  )
}

function CategoryEditor({ category, allCategories, onClose, onChanged }: {
  category: Category | null
  allCategories: Category[]
  onClose: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState(category?.icon ?? '📦')
  const [color, setColor] = useState(category?.color ?? '#34C759')
  const [budget, setBudget] = useState(category?.monthlyBudget ? String(category.monthlyBudget) : '')
  const [isSavings, setIsSavings] = useState(category?.isSavingsCategory ?? false)
  const [parentId, setParentId] = useState<string | null>(category?.parentId ?? null)
  const [isGoalToggle, setIsGoalToggle] = useState((category?.goalTargetAmount ?? 0) > 0)
  const [goalAmount, setGoalAmount] = useState(category?.goalTargetAmount ? String(category.goalTargetAmount) : '')
  const [hasGoalDate, setHasGoalDate] = useState(!!category?.goalTargetDate)
  const [goalDate, setGoalDate] = useState(category?.goalTargetDate ? localDateInputValue(new Date(category.goalTargetDate)) : '')

  const eligibleParents = allCategories.filter((c) =>
    !c.parentId &&
    c.id !== category?.id &&
    !allCategories.some((child) => child.parentId === c.id && child.id !== category?.id)
  )

  async function handleSave() {
    if (!name.trim()) return
    const data = {
      name: name.trim(),
      icon,
      color,
      monthlyBudget: parseFloat(budget) || 0,
      sortOrder: category?.sortOrder ?? allCategories.length,
      parentId,
      isSavingsCategory: isSavings,
      goalTargetAmount: isSavings && isGoalToggle ? (parseFloat(goalAmount) || 0) : 0,
      goalTargetDate: isSavings && isGoalToggle && hasGoalDate && goalDate ? new Date(goalDate).toISOString() : null,
      goalStartDate: isSavings && isGoalToggle ? (category?.goalStartDate ?? new Date().toISOString()) : null
    }
    if (category) {
      await saveCategory({ ...category, ...data })
    } else {
      await createCategory(data)
    }
    onChanged()
    onClose()
  }

  async function handleDelete() {
    if (!category) return
    await deleteCategory(category.id)
    onChanged()
    onClose()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <button onClick={onClose} className="text-button">Cancel</button>
          <span className="modal-title">{category ? 'Edit Category' : 'New Category'}</span>
          <button onClick={handleSave} className="text-button text-button-primary">Save</button>
        </div>
        <div className="modal-body">
          <label className="field-label">Name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />

          <label className="field-label">Icon (emoji)</label>
          <input type="text" value={icon} onChange={(e) => setIcon(e.target.value)} style={{ width: 60 }} />

          <label className="field-label">Color</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 60, padding: 2 }} />

          {eligibleParents.length > 0 && (
            <>
              <label className="field-label">Parent Category (optional)</label>
              <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
                <option value="">None — top-level category</option>
                {eligibleParents.map((p) => (
                  <option key={p.id} value={p.id}>{p.icon} {p.name}</option>
                ))}
              </select>
            </>
          )}

          <label className="field-label">{parentId ? "Monthly Budget (rolls up into parent's total)" : 'Monthly Budget'}</label>
          <input type="number" inputMode="decimal" placeholder="0.00" value={budget} onChange={(e) => setBudget(e.target.value)} />

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
            <input type="checkbox" switch checked={isSavings} onChange={(e) => setIsSavings(e.target.checked)} />
            <span>Savings or investment category</span>
          </div>

          {isSavings && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <input type="checkbox" switch checked={isGoalToggle} onChange={(e) => setIsGoalToggle(e.target.checked)} />
                <span>This is a savings goal</span>
              </div>
              {isGoalToggle && (
                <>
                  <label className="field-label">Target Amount</label>
                  <input type="number" inputMode="decimal" placeholder="0.00" value={goalAmount} onChange={(e) => setGoalAmount(e.target.value)} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <input type="checkbox" switch checked={hasGoalDate} onChange={(e) => setHasGoalDate(e.target.checked)} />
                    <span>Target date</span>
                  </div>
                  {hasGoalDate && (
                    <input type="date" value={goalDate} onChange={(e) => setGoalDate(e.target.value)} style={{ marginTop: 8 }} />
                  )}
                  <p className="hint" style={{ marginTop: 8 }}>Tracked cumulatively toward the target, not a monthly amount that resets.</p>
                </>
              )}
            </>
          )}

          {category && (
            <button className="danger-button" onClick={handleDelete}>Delete Category</button>
          )}
        </div>
      </div>
    </div>
  )
}
