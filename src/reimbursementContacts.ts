/**
 * Remembers recent reimbursement notes ("Sarah paid me back", "John
 * partial payback") so the next one doesn't need retyping from scratch
 * — not a real contacts feature, no names extracted or validated, just
 * whatever raw text was actually typed last time, offered back as a
 * tappable shortcut. Deliberately this simple: extracting a clean
 * "name" out of arbitrary free text reliably enough to be worth
 * trusting isn't a small problem, and the raw-note approach sidesteps
 * it entirely while still solving the actual annoyance — typing the
 * same person's name for the fifth time this month.
 */

const REIMBURSEMENT_CONTACTS_KEY = 'budget-tracker-reimbursement-contacts'
const MAX_REMEMBERED = 10

function readContacts(): string[] {
  try {
    const raw = localStorage.getItem(REIMBURSEMENT_CONTACTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeContacts(contacts: string[]) {
  try {
    localStorage.setItem(REIMBURSEMENT_CONTACTS_KEY, JSON.stringify(contacts))
  } catch {
    // Storage unavailable or full — not worth failing the save over.
  }
}

/** Call after saving a reimbursement with a real note — moves it to
 * the front if already remembered, adds it if not, caps the list so
 * it stays a short, genuinely-recent set rather than growing forever. */
export function recordReimbursementContact(note: string) {
  const trimmed = note.trim()
  if (!trimmed) return
  const existing = readContacts().filter((c) => c.toLowerCase() !== trimmed.toLowerCase())
  writeContacts([trimmed, ...existing].slice(0, MAX_REMEMBERED))
}

export function getRecentReimbursementContacts(): string[] {
  return readContacts()
}
