/** Tags are matched case-insensitively but displayed as typed the first
 * time. Normalizing here (trim, lowercase, collapse whitespace) is what
 * makes "Japan 2026", "japan 2026", and "  Japan  2026" all count as the
 * same tag for totals/filtering — without this, near-identical tags
 * silently fragment a person's own totals apart. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^#/, '')
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const t of tags) {
    const norm = normalizeTag(t)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    result.push(norm)
  }
  return result
}

/** Every tag ever used across a set of transactions, most-recently-used
 * first — the natural order for an autocomplete/suggestion list. */
export function allTagsFrom(transactions: { tags: string[]; date: string }[]): string[] {
  const seen = new Map<string, string>() // normalized -> most recent date seen
  for (const t of [...transactions].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const tag of t.tags) {
      const norm = normalizeTag(tag)
      if (!norm || seen.has(norm)) continue
      seen.set(norm, t.date)
    }
  }
  return Array.from(seen.keys())
}
