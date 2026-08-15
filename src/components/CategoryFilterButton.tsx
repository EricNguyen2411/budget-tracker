import { useState } from 'react'
import type { Category } from '../types'
import { useModalClose } from '../useModalClose'

interface Props {
  categories: Category[]
  value: string | null
  onChange: (id: string | null) => void
  allLabel?: string
}

export default function CategoryFilterButton({ categories, value, onChange, allLabel = 'All Categories' }: Props) {
  const [open, setOpen] = useState(false)
  const { closing, requestClose } = useModalClose(() => setOpen(false))
  const selected = categories.find((c) => c.id === value)
  const topLevel = categories.filter((c) => !c.parentId)

  return (
    <>
      <button className="category-filter-trigger" onClick={() => setOpen(true)}>
        <span>{selected ? `${selected.icon} ${selected.name}` : allLabel}</span>
        <span className="category-filter-chevron">⌄</span>
      </button>

      {open && (
        <div className={`modal-backdrop${closing ? ' modal-closing' : ''}`} onClick={() => requestClose()}>
          <div className={`modal-sheet${closing ? ' modal-sheet-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Filter by Category</span>
              <button className="text-button text-button-primary" onClick={() => requestClose()}>Done</button>
            </div>
            <div className="modal-body">
              <button className="picker-row" onClick={() => requestClose(() => onChange(null))}>
                <span>{allLabel}</span>
                {value === null && <span style={{ color: 'var(--blue)' }}>✓</span>}
              </button>
              {topLevel.map((c) => (
                <div key={c.id}>
                  <button className="picker-row" onClick={() => requestClose(() => onChange(c.id))}>
                    <span>{c.icon} {c.name}</span>
                    {value === c.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                  </button>
                  {categories.filter((s) => s.parentId === c.id).map((s) => (
                    <button key={s.id} className="picker-row picker-row-sub" onClick={() => requestClose(() => onChange(s.id))}>
                      <span>{s.icon} {s.name}</span>
                      {value === s.id && <span style={{ color: 'var(--blue)' }}>✓</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
