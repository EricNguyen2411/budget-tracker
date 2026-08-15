import { useState } from 'react'
import type { Category } from '../types'
import { createCategory, saveCategory, deleteCategory, mergeCategoryInto } from '../db'
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

  const topLevel = categories.filter((c) => !c.parentId).sort((a, b) => a.sortOrder - b.sortOrder)

  async function move(category: Category, direction: 'up' | 'down') {
    const index = topLevel.findIndex((c) => c.id === category.id)
    const swapWith = direction === 'up' ? index - 1 : index + 1
    if (swapWith < 0 || swapWith >= topLevel.length) return
    const other = topLevel[swapWith]
    await saveCategory({ ...category, sortOrder: other.sortOrder })
    await saveCategory({ ...other, sortOrder: category.sortOrder })
    onChanged()
  }

  return (
    <div className="screen">
      <div className="screen-header-row">
        <button onClick={onBack} className="text-button">‹ Settings</button>
        <h1 className="screen-title" style={{ fontSize: 20 }}>Categories</h1>
        <span style={{ width: 60 }} />
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {topLevel.map((c, i) => {
          const subs = categories.filter((s) => s.parentId === c.id)
          return (
            <div key={c.id}>
              <div className="transaction-row" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="reorder-stepper">
                  <button onClick={() => move(c, 'up')} disabled={i === 0}>▲</button>
                  <button onClick={() => move(c, 'down')} disabled={i === topLevel.length - 1}>▼</button>
                </div>
                <button className="transaction-row" style={{ padding: 0, flex: 1 }} onClick={() => setEditingCategory(c)}>
                  <div className="tx-icon" style={{ background: c.color + '33' }}>{c.icon}</div>
                  <div className="tx-info">
                    <span className="tx-note">{c.name}</span>
                    {c.isSavingsCategory && <span className="tx-category">Savings</span>}
                  </div>
                  <span className="chevron">›</span>
                </button>
              </div>
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
  const [needWantType, setNeedWantType] = useState<'need' | 'want' | null>(category?.needWantType ?? null)
  const [showDeleteOptions, setShowDeleteOptions] = useState(false)

  // A same-name category elsewhere is very likely the exact duplicate
  // situation this is for — surfaced as the suggested merge target,
  // though any category can be picked instead.
  const likelyDuplicate = category
    ? allCategories.find((c) => c.id !== category.id && c.parentId === category.parentId && c.name.trim().toLowerCase() === category.name.trim().toLowerCase())
    : null
  const mergeCandidates = category ? allCategories.filter((c) => c.id !== category.id && c.parentId === category.parentId) : []

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
      goalStartDate: isSavings && isGoalToggle ? (category?.goalStartDate ?? new Date().toISOString()) : null,
      needWantType: isSavings ? null : needWantType
    }
    if (category) {
      await saveCategory({ ...category, ...data })
    } else {
      await createCategory(data)
    }
    onChanged()
    onClose()
  }

  function handleDelete() {
    if (!category) return
    const subCount = allCategories.filter((c) => c.parentId === category.id).length
    if (subCount > 0) {
      alert(`"${category.name}" still has ${subCount} subcategor${subCount === 1 ? 'y' : 'ies'} under it. Delete or move those first — deleting the parent while they still point to it would leave them orphaned.`)
      return
    }
    setShowDeleteOptions(true)
  }

  async function handleMergeInto(targetId: string) {
    if (!category) return
    const target = allCategories.find((c) => c.id === targetId)
    if (!target) return
    if (!confirm(`Move everything from "${category.name}" into "${target.name}", then delete "${category.name}"?`)) return
    const { movedCount } = await mergeCategoryInto(category.id, targetId)
    alert(`Moved ${movedCount} transaction${movedCount === 1 ? '' : 's'} into "${target.name}".`)
    onChanged()
    onClose()
  }

  async function handlePlainDelete() {
    if (!category) return
    if (!confirm(`Delete "${category.name}"? Any transactions using it will become uncategorized rather than being reassigned.`)) return
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

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label className="field-label">Icon (emoji)</label>
              <input type="text" value={icon} onChange={(e) => setIcon(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label className="field-label">Color</label>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: '100%', padding: 2 }} />
            </div>
          </div>

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
          <p className="hint" style={{ marginTop: -8, marginBottom: 12 }}>For setting budgets across all categories at once against your income, use More → Total Budget Planner instead.</p>

          {!isSavings && (
            <>
              <label className="field-label">Need or Want</label>
              <div className="segmented" style={{ marginBottom: 12 }}>
                <button className={needWantType === 'need' ? 'segmented-active' : ''} onClick={() => setNeedWantType(needWantType === 'need' ? null : 'need')}>Need</button>
                <button className={needWantType === 'want' ? 'segmented-active' : ''} onClick={() => setNeedWantType(needWantType === 'want' ? null : 'want')}>Want</button>
              </div>
              <p className="hint" style={{ marginTop: -8, marginBottom: 12 }}>Used by Month in Review to check spending against the 50/30/20 guideline. Leave unset to let it guess from the category name instead.</p>
            </>
          )}

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
            <button onClick={handleDelete} style={{ color: 'var(--red)', fontSize: 15, textAlign: 'center', width: '100%', padding: '14px 0', marginTop: 20, borderTop: '1px solid var(--border)' }}>
              Delete Category
            </button>
          )}

        </div>
      </div>

      {showDeleteOptions && category && (
        <div className="modal-backdrop" onClick={() => setShowDeleteOptions(false)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Delete "{category.name}"</span>
              <button className="text-button" onClick={() => setShowDeleteOptions(false)}>Cancel</button>
            </div>
            <div className="modal-body">
              {likelyDuplicate && (
                <>
                  <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>
                    Found another category with the same name — likely what you're actually trying to clean up:
                  </p>
                  <button className="picker-row" style={{ background: 'var(--surface-2)', borderRadius: 10, marginBottom: 16 }} onClick={() => handleMergeInto(likelyDuplicate.id)}>
                    <span>Merge into {likelyDuplicate.icon} {likelyDuplicate.name}</span>
                    <span className="chevron">›</span>
                  </button>
                </>
              )}

              {mergeCandidates.length > 0 && (
                <>
                  <p style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 10 }}>Or merge into any other category — moves every transaction across before deleting:</p>
                  {mergeCandidates.filter((c) => c.id !== likelyDuplicate?.id).map((c) => (
                    <button key={c.id} className="picker-row" onClick={() => handleMergeInto(c.id)}>
                      <span>{c.icon} {c.name}</span>
                      <span className="chevron">›</span>
                    </button>
                  ))}
                </>
              )}

              <button className="danger-button" style={{ marginTop: 16 }} onClick={handlePlainDelete}>
                Delete Without Reassigning
              </button>
              <p className="hint" style={{ marginTop: 8 }}>Any transactions using "{category.name}" will become uncategorized instead of moving anywhere.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
