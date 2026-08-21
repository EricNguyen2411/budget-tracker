import type { TextItem } from './ocr'
import { suggestCategoryId } from './merchantRules'

export interface ParsedTransaction {
  id: string
  amount: number
  note: string
  date: string // ISO
  isExpense: boolean
  suggestedCategoryId: string | null
  // Only set on a Beem "split between N of us" share row — the note
  // says what bill it's a share of, and this carries the split's
  // context (how many people, per-person amount) since the expense
  // itself isn't created here — link this manually to the actual
  // expense once that's been imported separately (e.g. from a bank
  // statement), since Beem settled every share the moment the split was
  // created rather than leaving them pending.
  splitInfo?: { totalPeople: number; perPersonAmount: number } | null
}

function uuid() {
  return crypto.randomUUID()
}

// ---------- Shared date-header helpers ----------

const WEEKDAY_DATE_PATTERN = /^(Mon(day)?|Tue(s(day)?)?|Wed(nesday)?|Thu(rs(day)?)?|Fri(day)?|Sat(urday)?|Sun(day)?)\s+\d{1,2}\s+[A-Za-z]{3,}\s*\d{4}/i

function startsWithWeekdayDate(text: string): boolean {
  return WEEKDAY_DATE_PATTERN.test(text.trim())
}

// Banking apps commonly group the most recent transactions under "Today"
// or "Yesterday" instead of a full date. Missing this (as an earlier
// version of this parser did) meant every transaction under "Yesterday"
// had no date header to attach to and got silently dropped.
function isRelativeDateHeader(text: string): boolean {
  return /^(Today|Yesterday)$/i.test(text.trim())
}

function isAnyDateHeader(text: string): boolean {
  return startsWithWeekdayDate(text) || isRelativeDateHeader(text)
}

function resolvedDateForHeader(text: string): Date | null {
  const trimmed = text.trim()
  if (/^today$/i.test(trimmed)) {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }
  if (/^yesterday$/i.test(trimmed)) {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    d.setHours(0, 0, 0, 0)
    return d
  }
  const match = text.match(WEEKDAY_DATE_PATTERN)
  if (match) {
    const parsed = new Date(match[0].replace(/^\w+\s+/, '')) // strip weekday, parse "D Mon YYYY"
    if (!isNaN(parsed.getTime())) return parsed
  }
  return null
}

function isRowAnchorMarker(text: string): boolean {
  if (/card ending \d+/i.test(text)) return true
  if (/bal\s*\$\d{1,3}(,\d{3})*\.\d{2}/i.test(text)) return true
  // Some rows (confirmed via testing — a cardless ATM withdrawal) show a
  // transaction-type label instead of a running balance, with no "bal
  // $X" line at all. Without recognizing these too, that row has no
  // anchor to attach to and silently disappears, same failure mode as
  // the "Yesterday" header bug found earlier.
  if (/^(ATM\/EFTPOS|Online) Withdrawal$/i.test(text.trim())) return true
  if (/^Transfers?$/i.test(text.trim())) return true
  return false
}

// ---------- Format detection ----------

export type DetectedFormat = 'appScreenshot' | 'notificationScreenshot' | 'beemScreenshot' | 'unknown'

const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
}

function parsePeopleCount(text: string): number | null {
  const match = text.match(/(\d+|[a-z]+)\s+of us/i)
  if (!match) return null
  const raw = match[1].toLowerCase()
  if (/^\d+$/.test(raw)) return parseInt(raw, 10)
  return WORD_NUMBERS[raw] ?? null
}

// Beem's Activity feed cards each read as one of "$X paid to @user for Y",
// "$X received from @user for Y", or "$X split between N of us for Y" —
// distinct enough from both the banking-app row format and the
// payment-notification format to detect on its own.
const BEEM_ACTION_PATTERN = /(paid to|received from|split between\s+.+\s+of us)/i

// A split card is recognized either by the full "split between ... of us"
// phrase, OR by the "N of us" people-count phrase alone. The second path
// matters: confirmed via direct testing against this exact screenshot that
// OCR can drop the leading "s" of "split" (garbling it to "plit between"),
// which silently defeats the full-phrase match — the card then never
// becomes its own anchor and its content gets swept into whichever
// neighboring card's block happens to include it by position, corrupting
// that card's note and losing this one's transaction entirely with no
// warning. "N of us" is a much more distinctive, harder-to-lose phrase
// (it survived in every OCR pass tested, even when "split" and the dollar
// amount didn't), so anchoring on it directly is far more robust.
function isBeemActionLine(text: string): boolean {
  if (BEEM_ACTION_PATTERN.test(text)) return true
  const people = parsePeopleCount(text)
  return people !== null && people > 1
}

export function detectFormat(items: TextItem[]): DetectedFormat {
  const hasDateHeader = items.some((i) => isAnyDateHeader(i.text))
  const hasRowAnchor = items.some((i) => isRowAnchorMarker(i.text))
  if (hasDateHeader && hasRowAnchor) return 'appScreenshot'

  const hasPaymentSuccessful = items.some((i) => /payment\s+(success|received|sent)/i.test(i.text))
  if (hasPaymentSuccessful) return 'notificationScreenshot'

  const hasBeemAction = items.some((i) => isBeemActionLine(i.text))
  if (hasBeemAction) return 'beemScreenshot'

  return 'unknown'
}

// ---------- App transaction list parser (banking app screenshots) ----------

function parseSignedAmount(text: string): { amount: number; isExpense: boolean } | null {
  const match = text.match(/([+-]?)\s?\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/)
  if (!match) return null
  const amount = parseFloat(match[2].replace(/,/g, ''))
  const isExpense = match[1] !== '+'
  return { amount, isExpense }
}

function parseBalance(anchorText: string): number | null {
  const match = anchorText.match(/bal\s*\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/i)
  return match ? parseFloat(match[1].replace(/,/g, '')) : null
}

export function parseAppTransactionList(items: TextItem[]): { transactions: ParsedTransaction[]; skipped: string[] } {
  // Some screenshots split the "bal $X,XXX.XX" row-anchor marker into two
  // separate OCR observations — "bal" and the dollar figure on their
  // own — most often when a similar-looking balance figure sits nearby
  // (like an account's overall balance shown just above the first
  // transaction). Recombine adjacent "bal" + dollar-figure pairs first,
  // the same fix found necessary in the native app's parser.
  const merged: TextItem[] = []
  let skipNext = false
  for (let i = 0; i < items.length; i++) {
    if (skipNext) { skipNext = false; continue }
    const text = items[i].text.trim()
    if (/^bal$/i.test(text) && i + 1 < items.length) {
      const next = items[i + 1]
      const isDollarOnly = /^\$\d{1,3}(,\d{3})*\.\d{2}$/.test(next.text.trim())
      const closeEnough = Math.abs(next.box.y0 - items[i].box.y0) < 0.02
      if (isDollarOnly && closeEnough) {
        merged.push({ text: `bal ${next.text.trim()}`, box: items[i].box })
        skipNext = true
        continue
      }
    }
    merged.push(items[i])
  }

  const dateHeaders: { y: number; date: Date | null }[] = []
  const rowAnchors: { index: number; y: number }[] = []
  merged.forEach((item, index) => {
    const text = item.text.trim()
    if (isAnyDateHeader(text)) dateHeaders.push({ y: item.box.y0, date: resolvedDateForHeader(text) })
    if (isRowAnchorMarker(text)) rowAnchors.push({ index, y: item.box.y0 })
  })

  if (rowAnchors.length === 0) return { transactions: [], skipped: [] }

  const excludedIndices = new Set<number>()

  // Anything above the topmost date header is app chrome — status bar,
  // page title, search/refresh icons, account balance — never a
  // transaction's own data. Found via direct testing: excluding only
  // stray dollar amounts up there (the original approach) missed plain
  // text like a card title, which got glued onto the first transaction's
  // note since nothing else claimed it.
  const topmostHeaderY = dateHeaders.length > 0 ? Math.min(...dateHeaders.map((h) => h.y)) : null
  if (topmostHeaderY !== null) {
    merged.forEach((item, index) => {
      const text = item.text.trim()
      if (isAnyDateHeader(text) || isRowAnchorMarker(text)) return
      if (item.box.y0 < topmostHeaderY) excludedIndices.add(index)
    })
  }

  // Exclude each header's own trailing running-total, found as the
  // plain-amount block whose Y is closest to that specific header.
  for (const header of dateHeaders) {
    let closestIndex: number | null = null
    let closestDist = Infinity
    merged.forEach((item, index) => {
      const text = item.text.trim()
      if (isAnyDateHeader(text) || isRowAnchorMarker(text)) return
      const isPlainAmount = /^\$?\d{1,3}(,\d{3})*\.\d{2}$/.test(text)
      if (!isPlainAmount) return
      const dist = Math.abs(item.box.y0 - header.y)
      if (dist < 0.03 && dist < closestDist) { closestDist = dist; closestIndex = index }
    })
    if (closestIndex !== null) excludedIndices.add(closestIndex)
  }

  // Assign every remaining text block to its nearest row anchor (the
  // closest anchor at or below it).
  const textByAnchor = new Map<number, string[]>()
  merged.forEach((item, index) => {
    const text = item.text.trim()
    if (!text || isAnyDateHeader(text) || excludedIndices.has(index)) return
    const isThisAnAnchor = rowAnchors.some((a) => a.index === index)

    let bestAnchor: number | null = null
    let bestDist = Infinity
    for (const anchor of rowAnchors) {
      if (anchor.y < item.box.y0 - 0.005) continue // anchor must be at or below this text
      const dist = anchor.y - item.box.y0
      if (dist < bestDist) { bestDist = dist; bestAnchor = anchor.index }
    }
    if (bestAnchor === null) return
    if (!textByAnchor.has(bestAnchor)) textByAnchor.set(bestAnchor, [])
    if (!isThisAnAnchor) textByAnchor.get(bestAnchor)!.push(text)
  })

  const transactions: ParsedTransaction[] = []
  const skipped: string[] = []

  // First pass: build each transaction with its naive text-based sign,
  // plus the running balance if this row's anchor showed one.
  interface Draft { amount: number; note: string; date: Date; textIsExpense: boolean; balanceAfter: number | null }
  const drafts: Draft[] = []
  const skippedTexts: string[] = []

  for (const anchor of rowAnchors) {
    const blockTexts = textByAnchor.get(anchor.index) ?? []
    const combinedText = blockTexts.join(' ')
    const anchorText = merged[anchor.index].text

    const applicableHeader = dateHeaders.filter((h) => h.y <= anchor.y).sort((a, b) => b.y - a.y)[0]
    const date = applicableHeader?.date

    const parsedAmount = parseSignedAmount(combinedText)

    if (!date || !parsedAmount) {
      skippedTexts.push(blockTexts.join(' | ') || anchorText)
      continue
    }

    let note = combinedText
      .replace(/[+-]?\s?\$\s?\d{1,3}(?:,\d{3})*\.\d{2}/g, ' ')
      .replace(/bal\s*\$\d{1,3}(,\d{3})*\.\d{2}/gi, ' ')
      .replace(/card ending \d+/gi, ' ')
      .replace(/[>›]/g, ' ') // trailing disclosure chevron, present on every row in some formats
      .replace(/\s+/g, ' ')
      .trim()
    if (!note) note = 'Transaction'

    drafts.push({ amount: parsedAmount.amount, note, date, textIsExpense: parsedAmount.isExpense, balanceAfter: parseBalance(anchorText) })
  }

  // Second pass: rows sort newest-first (matching how the screen reads
  // top to bottom), so each row's "before" balance is the NEXT row's
  // balanceAfter — comparing them gives a direction that doesn't depend
  // on a sign character being present in the text at all, fixing the
  // common case where income shows in green with no "+", which OCR has
  // no way to read as a sign since it's color, not text.
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i]
    const balanceBefore = drafts[i + 1]?.balanceAfter ?? null
    let isExpense = draft.textIsExpense
    if (draft.balanceAfter !== null && balanceBefore !== null) {
      const delta = draft.balanceAfter - balanceBefore
      // Only trust the delta if it's actually consistent with the parsed
      // amount (within a cent) — otherwise something else changed the
      // balance between these two rows (a skipped/unparsed transaction
      // in between) and the naive text-based sign is safer to keep.
      if (Math.abs(Math.abs(delta) - draft.amount) < 0.01) {
        isExpense = delta < 0
      }
    }
    transactions.push({
      id: uuid(),
      amount: draft.amount,
      note: draft.note,
      date: draft.date.toISOString(),
      isExpense,
      suggestedCategoryId: suggestCategoryId(draft.note)
    })
  }
  skipped.push(...skippedTexts)

  return { transactions, skipped }
}

// ---------- Notification screenshot parser ----------

function parseNotificationTime(beforeText: string, calendar = new Date()): Date | null {
  const text = beforeText.toLowerCase()

  const bareTimeMatch = text.match(/(\d{1,2}):(\d{2})\s?(am|pm)/i)
  if (text.includes('yesterday') && bareTimeMatch) {
    const d = new Date(calendar)
    d.setDate(d.getDate() - 1)
    return applyTime(d, bareTimeMatch)
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const shortWeekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  for (let i = 0; i < weekdays.length; i++) {
    if (text.includes(weekdays[i]) || text.includes(shortWeekdays[i])) {
      const todayWeekday = calendar.getDay()
      let daysAgo = todayWeekday - i
      if (daysAgo <= 0) daysAgo += 7
      const d = new Date(calendar)
      d.setDate(d.getDate() - daysAgo)
      return bareTimeMatch ? applyTime(d, bareTimeMatch) : d
    }
  }

  if (bareTimeMatch) return applyTime(new Date(calendar), bareTimeMatch)
  return null
}

function applyTime(date: Date, match: RegExpMatchArray): Date {
  let hour = parseInt(match[1])
  const minute = parseInt(match[2])
  const isPM = match[3].toLowerCase() === 'pm'
  if (isPM && hour !== 12) hour += 12
  if (!isPM && hour === 12) hour = 0
  date.setHours(hour, minute, 0, 0)
  return date
}

export function parseNotificationScreenshots(items: TextItem[]): { transactions: ParsedTransaction[]; skipped: string[] } {
  const transactions: ParsedTransaction[] = []
  const skipped: string[] = []

  // Group into blocks anchored on each "Payment successful/received/sent" line.
  const anchors = items.filter((i) => /payment\s+(success|received|sent)/i.test(i.text))

  anchors.forEach((anchor, i) => {
    const nextAnchorY = anchors[i + 1]?.box.y0 ?? Infinity
    const block = items.filter((it) => it.box.y0 >= anchor.box.y0 - 0.05 && it.box.y0 < nextAnchorY)
    const combinedText = block.map((b) => b.text).join(' ')

    const amountMatch = combinedText.match(/made of\s?\$(\d{1,3}(?:,\d{3})*\.\d{2})/i) ?? combinedText.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null

    const beforeAnchorText = items.filter((it) => it.box.y0 < anchor.box.y0 && it.box.y0 >= anchor.box.y0 - 0.08).map((it) => it.text).join(' ')
    const date = parseNotificationTime(beforeAnchorText) ?? parseNotificationTime(combinedText)

    const descMatch = combinedText.match(/description:\s*([^$]+)/i)
    let note = descMatch ? descMatch[1].trim() : combinedText.replace(/payment\s+(success\w*|received|sent)/i, '').replace(/made of\s?\$[\d,.]+/i, '').replace(/\$[\d,.]+/g, '').trim()
    note = note.slice(0, 60) || 'Payment'

    const isExpense = !/received/i.test(combinedText)

    if (!amount || !date) {
      skipped.push(combinedText)
      return
    }

    transactions.push({
      id: uuid(),
      amount,
      note,
      date: date.toISOString(),
      isExpense,
      suggestedCategoryId: suggestCategoryId(note)
    })
  })

  return { transactions, skipped }
}

// ---------- Beem activity screenshot parser ----------

// Real month names/abbreviations only — NOT "any 3+ letter word". Confirmed
// via direct testing against real OCR output that the old, looser
// `\d{1,2}\s+[A-Za-z]{3,}` pattern silently misfires on completely ordinary
// anchor lines: "$65.00 paid to" contains "00 paid" (the ".00" cents plus
// the next word), and "$6.85 paid to" contains "85 paid" (the cents digits
// plus the next word) — both look exactly like a "DD Mon" date to that
// pattern. Normally this is harmless because the real footer date (further
// down the card, larger y0) sorts after it and wins — but whenever the
// real footer fails to OCR at all (confirmed to happen in practice), this
// false match becomes the ONLY candidate and gets used as the "date
// token", which then wrongly truncates note extraction right after the
// anchor's own first line, discarding the actual "for X" text entirely.
const MONTH_PATTERN = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const DATED_TOKEN_PATTERN = new RegExp(`\\b(\\d{1,2})\\s+${MONTH_PATTERN}\\s*(\\d{4})?\\b`, 'i')

// Extracts a Beem-style date/time token from anywhere within a line,
// rather than requiring the whole line to be nothing but the date —
// real OCR output on these gradient-background cards often attaches
// garbled noise from a misread icon right next to the date ("© 1d"),
// so an exact full-line match misses it entirely.
function extractBeemDateToken(text: string): string | null {
  const trimmed = text.trim()
  const relative = trimmed.match(/\b(\d{1,2})\s*([smhdw])\b/i)
  if (relative) return relative[0]
  const named = trimmed.match(/\b(now|today|yesterday)\b/i)
  if (named) return named[0]
  const dated = trimmed.match(DATED_TOKEN_PATTERN)
  if (dated) return dated[0]
  return null
}

function isBeemDateToken(text: string): boolean {
  return extractBeemDateToken(text) !== null
}

function parseBeemDate(text: string, ref = new Date()): Date | null {
  const trimmed = text.trim()
  if (/^now$/i.test(trimmed)) return new Date(ref)
  if (/^today$/i.test(trimmed)) {
    const d = new Date(ref); d.setHours(0, 0, 0, 0); return d
  }
  if (/^yesterday$/i.test(trimmed)) {
    const d = new Date(ref); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d
  }
  const relative = trimmed.match(/^(\d{1,2})\s*([smhdw])$/i)
  if (relative) {
    const amount = parseInt(relative[1], 10)
    const unit = relative[2].toLowerCase()
    const msPerUnit: Record<string, number> = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000, w: 7 * 24 * 60 * 60 * 1000 }
    return new Date(ref.getTime() - amount * msPerUnit[unit])
  }
  const match = trimmed.match(new RegExp(`^(\\d{1,2})\\s+${MONTH_PATTERN}\\s*(\\d{4})?$`, 'i'))
  if (match) {
    const day = match[1]
    const month = trimmed.match(new RegExp(MONTH_PATTERN, 'i'))![0]
    const year = match[2] ? parseInt(match[2], 10) : ref.getFullYear()
    const candidate = new Date(`${month} ${day}, ${year}`)
    if (isNaN(candidate.getTime())) return null
    // No year printed on the card means it's from within roughly the
    // last 12 months — if taking the current year lands in the future
    // (e.g. it's January and the card says "02 Dec"), it was last year.
    if (!match[2] && candidate.getTime() > ref.getTime() + 24 * 60 * 60 * 1000) {
      candidate.setFullYear(candidate.getFullYear() - 1)
    }
    return candidate
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function parseBeemScreenshot(items: TextItem[]): { transactions: ParsedTransaction[]; skipped: string[] } {
  const transactions: ParsedTransaction[] = []
  const skipped: string[] = []

  // Each card is anchored on its "paid to" / "received from" / "split
  // between ... of us" line. Everything from just above that anchor
  // (to catch the dollar amount when it's on its own line right above,
  // as happens when the wording wraps) up to the next card's anchor
  // belongs to this card.
  const anchors = items.filter((i) => isBeemActionLine(i.text))

  anchors.forEach((anchor, i) => {
    const nextAnchorY = anchors[i + 1]?.box.y0 ?? Infinity
    // The -0.03 lookback exists to catch this card's own amount when it
    // wraps onto its own line just above the anchor. But without a lower
    // clamp, that same lookback can reach back UP INTO the previous
    // card's own anchor line whenever two cards sit close together
    // (confirmed directly: with real OCR'd cards ~4% of image height
    // apart, this swept the previous card's "$65.00 paid to" line into
    // the current card's block too, handing it a second, wrong dollar
    // amount). Never look back further than the previous anchor's own
    // bottom edge — that line already belongs to that card.
    const prevAnchorY1 = anchors[i - 1]?.box.y1 ?? -Infinity
    const lowerBound = Math.max(anchor.box.y0 - 0.03, prevAnchorY1)
    const block = items.filter((it) => it.box.y0 >= lowerBound && it.box.y0 < nextAnchorY)

    // The footer timestamp ("Now", "02 Aug"...) is its own line, usually
    // the last one before the next card starts.
    const dateTokens = block.filter((b) => isBeemDateToken(b.text)).sort((a, b) => b.box.y0 - a.box.y0)
    const date = dateTokens.length > 0 ? parseBeemDate(extractBeemDateToken(dateTokens[0].text) ?? dateTokens[0].text) : null

    // The block's upper window (reaching above the anchor to catch this
    // card's own amount line) also ends up sweeping in the START of the
    // NEXT card — its amount line sits above ITS OWN anchor too, which
    // still falls inside this card's [start, nextAnchorY) range. Cutting
    // the note-extraction text off right after this card's own date
    // token keeps the next card's leaked content out of the "for ..."
    // capture, regardless of whatever else the block window swept in.
    const dateTokenIndex = dateTokens.length > 0 ? block.indexOf(dateTokens[0]) : -1
    const noteSourceBlock = dateTokenIndex >= 0 ? block.slice(0, dateTokenIndex + 1) : block
    const combined = noteSourceBlock.map((b) => b.text).join(' ')

    const amountMatch = combined.match(/\$\s?(\d{1,3}(?:,\d{3})*\.\d{2})/)
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null

    // Identify which kind of card this is, AND the exact position of the
    // matched keyword within `combined`. A split card is recognized via
    // "N of us" (not the full "split between" phrase — see
    // isBeemActionLine for why that's more OCR-robust), the same way it
    // was detected as an anchor in the first place.
    const peopleCount = parsePeopleCount(combined)
    let isExpense: boolean
    let keywordMatch: RegExpMatchArray | null = null
    let splitInfo: { totalPeople: number; perPersonAmount: number } | null = null

    if (peopleCount !== null && peopleCount > 1) {
      isExpense = true
      keywordMatch = combined.match(/(\d+|[a-z]+)\s+of us/i)
      if (amount !== null) {
        splitInfo = { totalPeople: peopleCount, perPersonAmount: amount / peopleCount }
      }
    } else if (/received from/i.test(combined)) {
      isExpense = false
      keywordMatch = combined.match(/received from/i)
    } else if (/paid to/i.test(combined)) {
      isExpense = true
      keywordMatch = combined.match(/paid to/i)
    } else {
      skipped.push(combined)
      return
    }

    // Only search for the "for X" note text AFTER the identified keyword,
    // not from the start of `combined`. This is what actually stops a
    // PRECEDING card's leftover text from being captured as part of THIS
    // card's note — confirmed directly: when OCR merges the tail of one
    // card onto the same line as the next card's own keyword (e.g.
    // "...for food [next card's text] of us for gami"), searching from
    // the very start grabs the wrong "for food" instead of this card's
    // own "for gami".
    const searchFrom = keywordMatch && keywordMatch.index !== undefined ? keywordMatch.index + keywordMatch[0].length : 0
    const forMatch = combined.slice(searchFrom).match(/\bfor\s+(.+)$/i)
    let note = forMatch ? forMatch[1] : ''

    // The captured "for ..." text runs to the end of the block, which
    // includes the trailing footer date/time — strip it back off now
    // that we know exactly which token it was.
    if (dateTokens.length > 0) {
      note = note.replace(new RegExp(`\\s*${escapeRegExp(dateTokens[0].text.trim())}\\s*$`, 'i'), '')
    }
    // When there's no date token to truncate at (this card's own footer
    // text was dropped by OCR entirely), fall back to cutting the note
    // off at the first sign of a leaked amount from the next card that
    // the block window swept in — better an incomplete note than one
    // contaminated with someone else's transaction.
    const leakedAmount = note.match(/\$\s?\d/)
    if (leakedAmount && leakedAmount.index !== undefined) {
      note = note.slice(0, leakedAmount.index)
    }
    note = note.replace(/[>›]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!note) note = isExpense ? 'Beem payment' : 'Beem transfer'

    if (amount === null) {
      // A split card whose dollar amount genuinely can't be read (OCR
      // dropped it entirely — confirmed directly, not a parsing bug) is
      // still worth flagging distinctly: the person needs to know a
      // split for N people was found and its shares need adding
      // manually, rather than seeing an indistinguishable raw-text row
      // in the general "couldn't be read" list.
      if (peopleCount !== null && peopleCount > 1) {
        skipped.push(`Beem split "${note}" between ${peopleCount} people — couldn't read the $ amount, add the ${peopleCount - 1} reimbursement share(s) manually`)
      } else {
        skipped.push(combined)
      }
      return
    }
    // A missing date is recoverable (default to today, correctable in
    // review) — losing the whole transaction over it is worse than an
    // approximate date, unlike a missing amount which can't be guessed.
    const resolvedDate = date ?? new Date()

    // The expense itself isn't created here — it'll come in separately
    // from a bank statement/screenshot import (that's the actual
    // payment leaving the account), and creating it from this Beem
    // screenshot too would duplicate it. Only the reimbursement shares
    // get created; link each one to the real expense manually once
    // it's been imported.
    if (splitInfo) {
      for (let i = 0; i < splitInfo.totalPeople - 1; i++) {
        transactions.push({
          id: uuid(),
          amount: splitInfo.perPersonAmount,
          note: `Share of ${note}`,
          date: resolvedDate.toISOString(),
          isExpense: false,
          suggestedCategoryId: null,
          splitInfo
        })
      }
      return
    }

    transactions.push({
      id: uuid(),
      amount,
      note,
      date: resolvedDate.toISOString(),
      isExpense,
      suggestedCategoryId: suggestCategoryId(note),
      splitInfo: null
    })
  })

  return { transactions, skipped }
}

export async function parseScreenshot(items: TextItem[]): Promise<{ transactions: ParsedTransaction[]; skipped: string[]; format: DetectedFormat }> {
  const format = detectFormat(items)
  if (format === 'appScreenshot') {
    return { ...parseAppTransactionList(items), format }
  }
  if (format === 'notificationScreenshot') {
    return { ...parseNotificationScreenshots(items), format }
  }
  if (format === 'beemScreenshot') {
    return { ...parseBeemScreenshot(items), format }
  }
  return { transactions: [], skipped: items.map((i) => i.text), format }
}
