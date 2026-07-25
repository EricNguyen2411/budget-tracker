import type { TextItem } from './ocr'
import { suggestCategoryId } from './merchantRules'

export interface ParsedTransaction {
  id: string
  amount: number
  note: string
  date: string // ISO
  isExpense: boolean
  suggestedCategoryId: string | null
}

function uuid() {
  return crypto.randomUUID()
}

// ---------- Shared date-header helpers ----------

const WEEKDAY_DATE_PATTERN = /^(Mon(day)?|Tue(s(day)?)?|Wed(nesday)?|Thu(rs(day)?)?|Fri(day)?|Sat(urday)?|Sun(day)?)\s+\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}/i

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
  return /card ending \d+/i.test(text) || /bal\s*\$\d{1,3}(,\d{3})*\.\d{2}/i.test(text)
}

// ---------- Format detection ----------

export type DetectedFormat = 'appScreenshot' | 'notificationScreenshot' | 'unknown'

export function detectFormat(items: TextItem[]): DetectedFormat {
  const hasDateHeader = items.some((i) => isAnyDateHeader(i.text))
  const hasRowAnchor = items.some((i) => isRowAnchorMarker(i.text))
  if (hasDateHeader && hasRowAnchor) return 'appScreenshot'

  const hasPaymentSuccessful = items.some((i) => /payment (successful|received|sent)/i.test(i.text))
  if (hasPaymentSuccessful) return 'notificationScreenshot'

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

  // Anything above the topmost date header is account-level info (the
  // current balance shown once before any transaction section begins) —
  // never a transaction's own amount. Left unexcluded, amount extraction
  // (which takes the first dollar figure it finds in a block) could pick
  // this up over the actual transaction amount for whichever row sorts
  // nearest to it.
  const topmostHeaderY = dateHeaders.length > 0 ? Math.min(...dateHeaders.map((h) => h.y)) : null
  if (topmostHeaderY !== null) {
    merged.forEach((item, index) => {
      const text = item.text.trim()
      if (isAnyDateHeader(text) || isRowAnchorMarker(text)) return
      const isPlainAmount = /^\$?\d{1,3}(,\d{3})*\.\d{2}$/.test(text.replace(/^[+-]/, ''))
      if (isPlainAmount && item.box.y0 < topmostHeaderY) excludedIndices.add(index)
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

  for (const anchor of rowAnchors) {
    const blockTexts = textByAnchor.get(anchor.index) ?? []
    const combinedText = blockTexts.join(' ')

    const applicableHeader = dateHeaders.filter((h) => h.y <= anchor.y).sort((a, b) => b.y - a.y)[0]
    const date = applicableHeader?.date

    const parsedAmount = parseSignedAmount(combinedText)

    if (!date || !parsedAmount) {
      skipped.push(blockTexts.join(' | ') || merged[anchor.index].text)
      continue
    }

    let note = combinedText
      .replace(/[+-]?\s?\$\s?\d{1,3}(?:,\d{3})*\.\d{2}/g, ' ')
      .replace(/bal\s*\$\d{1,3}(,\d{3})*\.\d{2}/gi, ' ')
      .replace(/card ending \d+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!note) note = 'Transaction'

    transactions.push({
      id: uuid(),
      amount: parsedAmount.amount,
      note,
      date: date.toISOString(),
      isExpense: parsedAmount.isExpense,
      suggestedCategoryId: suggestCategoryId(note)
    })
  }

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
  const anchors = items.filter((i) => /payment (successful|received|sent)/i.test(i.text))

  anchors.forEach((anchor, i) => {
    const nextAnchorY = anchors[i + 1]?.box.y0 ?? Infinity
    const block = items.filter((it) => it.box.y0 >= anchor.box.y0 - 0.05 && it.box.y0 < nextAnchorY)
    const combinedText = block.map((b) => b.text).join(' ')

    const amountMatch = combinedText.match(/made of\s?\$(\d{1,3}(?:,\d{3})*\.\d{2})/i) ?? combinedText.match(/\$(\d{1,3}(?:,\d{3})*\.\d{2})/)
    const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null

    const beforeAnchorText = items.filter((it) => it.box.y0 < anchor.box.y0 && it.box.y0 >= anchor.box.y0 - 0.08).map((it) => it.text).join(' ')
    const date = parseNotificationTime(beforeAnchorText) ?? parseNotificationTime(combinedText)

    const descMatch = combinedText.match(/description:\s*([^$]+)/i)
    let note = descMatch ? descMatch[1].trim() : combinedText.replace(/payment (successful|received|sent)/i, '').replace(/made of\s?\$[\d,.]+/i, '').replace(/\$[\d,.]+/g, '').trim()
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

export async function parseScreenshot(items: TextItem[]): Promise<{ transactions: ParsedTransaction[]; skipped: string[]; format: DetectedFormat }> {
  const format = detectFormat(items)
  if (format === 'appScreenshot') {
    return { ...parseAppTransactionList(items), format }
  }
  if (format === 'notificationScreenshot') {
    return { ...parseNotificationScreenshots(items), format }
  }
  return { transactions: [], skipped: items.map((i) => i.text), format }
}
