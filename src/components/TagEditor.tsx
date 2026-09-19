import { useState } from 'react'
import { dedupeTags, normalizeTag } from '../tags'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
  existingTags: string[]
  placeholder?: string
  autoFocus?: boolean
}

/** A chip-list tag editor: type + Enter/comma to add, Backspace on an
 * empty input to remove the last chip, and a live-filtered list of
 * existing tags to reuse with one tap — a visible, tappable list
 * rather than a native <datalist>, confirmed unreliable on mobile (iOS
 * Safari in particular often doesn't surface it usefully). Shared by
 * TransactionEditor and the statement-import review screen, rather
 * than kept as two separately-maintained copies of the same ~50 lines. */
export default function TagEditor({ tags, onChange, existingTags, placeholder = 'Add a tag, e.g. work trip', autoFocus = false }: Props) {
  const [tagInput, setTagInput] = useState('')

  function addTag(raw: string) {
    const norm = normalizeTag(raw)
    if (!norm) return
    onChange(dedupeTags([...tags, norm]))
    setTagInput('')
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag))
  }

  const query = normalizeTag(tagInput)
  const suggestions = existingTags
    .filter((t) => !tags.includes(t))
    .filter((t) => !query || t.includes(query))
    .slice(0, 8)

  return (
    <div>
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {tags.map((t) => (
            <span
              key={t}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, padding: '5px 10px', borderRadius: 14, background: 'var(--surface-2)', color: 'var(--purple)' }}
            >
              {t}
              <button onClick={() => removeTag(t)} aria-label={`Remove tag ${t}`} style={{ fontSize: 14, lineHeight: 1, color: 'var(--text-dim)' }}>×</button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        placeholder={placeholder}
        value={tagInput}
        autoFocus={autoFocus}
        onChange={(e) => setTagInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            addTag(tagInput)
          } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
            removeTag(tags[tags.length - 1])
          }
        }}
      />
      {suggestions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
          {suggestions.map((t) => (
            <button
              key={t}
              onClick={() => addTag(t)}
              style={{ fontSize: 13, padding: '5px 10px', borderRadius: 14, background: 'var(--surface-2)', color: 'var(--text-dim)' }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      {tagInput.trim() && query && !existingTags.includes(query) && (
        <button className="text-button" style={{ fontSize: 12, color: 'var(--blue)', marginTop: 8 }} onClick={() => addTag(tagInput)}>
          Add "{query}"
        </button>
      )}
    </div>
  )
}
