import { useState } from 'react'
import { SortIcon } from '../icons'

export interface SortOption<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  options: SortOption<T>[]
  value: T
  onChange: (value: T) => void
}

export default function SortMenuButton<T extends string>({ options, value, onChange }: Props<T>) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button className="sort-menu-trigger" aria-label="Sort" onClick={() => setOpen(true)}>
        <SortIcon />
      </button>

      {open && (
        <div className="modal-backdrop action-sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="action-sheet-group">
              {options.map((opt, i) => (
                <button
                  key={opt.value}
                  className="action-sheet-row"
                  style={{ borderBottom: i < options.length - 1 ? '0.5px solid var(--border)' : 'none' }}
                  onClick={() => { onChange(opt.value); setOpen(false) }}
                >
                  <span style={{ fontWeight: value === opt.value ? 600 : 400 }}>{opt.label}</span>
                  {value === opt.value && <span style={{ color: 'var(--blue)' }}>✓</span>}
                </button>
              ))}
            </div>
            <button className="action-sheet-cancel" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  )
}
