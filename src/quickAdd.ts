import type { Category } from './types'
import { suggestCategoryId } from './merchantRules'
import { dedupeTags } from './tags'

export interface QuickAddResult {
  amount: number
  note: string
  isExpense: boolean
  categoryId: string | null
  tags: string[]
  date: string // ISO
}

const INCOME_WORDS = /\b(got|received|earned|refunded?|income|deposit(?:ed)?|sold)\b/i
const EXPENSE_WORDS = /\b(spent|paid|bought|buy|purchased)\b/i
const LEADING_FILLER = /^(on|for|from|at|to)\s+/i
const TRAILING_FILLER = /\s+(on|for|from|at|to)$/i

/** Parses a free-text quick-add line like "spent 12 on coffee
 * #worktrip" into a ready-to-save transaction. Returns null only when
 * no dollar amount could be found at all — everything else (direction,
 * note, date, category, tags) degrades to a sensible default rather
 * than failing, since guessing wrong on those is easy to fix with one
 * tap after the fact, but silently refusing to add anything isn't. */
export function parseQuickAdd(raw: string, categories: Category[]): QuickAddResult | null {
  let text = raw.trim()
  if (!text) return null

  // Tags: any #word anywhere in the line, in any order relative to the
  // rest of the text.
  const tags: string[] = []
  text = text.replace(/#(\S+)/g, (_, tag) => { tags.push(tag); return ' ' })

  // Date: a relative phrase anywhere in the line. Checked before amount
  // extraction since "3 days ago" would otherwise itself look like an
  // amount ("3") followed by unrelated text.
  let date = new Date()
  const daysAgoMatch = text.match(/\b(\d+)\s+days?\s+ago\b/i)
  if (daysAgoMatch) {
    date = new Date(date.getFullYear(), date.getMonth(), date.getDate() - parseInt(daysAgoMatch[1], 10))
    text = text.replace(daysAgoMatch[0], ' ')
  } else if (/\byesterday\b/i.test(text)) {
    date = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1)
    text = text.replace(/\byesterday\b/i, ' ')
  } else {
    text = text.replace(/\btoday\b/i, ' ')
  }

  // Direction: income keywords are checked first since they're a
  // shorter, more specific list — "spent"/"paid" is the safe default
  // for anything ambiguous, matching how most quick entries are
  // everyday purchases rather than income.
  let isExpense = true
  if (INCOME_WORDS.test(text)) {
    isExpense = false
    text = text.replace(INCOME_WORDS, ' ')
  } else if (EXPENSE_WORDS.test(text)) {
    text = text.replace(EXPENSE_WORDS, ' ')
  }

  const amountMatch = text.match(/\$?\s?(\d+(?:\.\d{1,2})?)/)
  if (!amountMatch || amountMatch.index === undefined) return null
  const amount = parseFloat(amountMatch[1])
  text = text.slice(0, amountMatch.index) + ' ' + text.slice(amountMatch.index + amountMatch[0].length)

  let note = text.replace(/\s+/g, ' ').trim()
  note = note.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '').trim()

  const categoryId = note ? suggestCategoryId(note, categories) : null

  return {
    amount,
    note,
    isExpense,
    categoryId,
    tags: dedupeTags(tags),
    date: date.toISOString()
  }
}
