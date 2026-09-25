import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { suggestCategoryId } from './merchantRules'
import type { ParsedTransaction } from './receiptParser'
import type { Category } from './types'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

function uuid() {
  return crypto.randomUUID()
}

interface PositionedText {
  text: string
  x: number
  y: number
}

/** Groups text items into rows by Y-proximity — pdf.js reports each
 * word/fragment separately with its own position, same underlying
 * challenge as OCR line reconstruction. */
function groupIntoRows(items: PositionedText[]): PositionedText[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x) // PDF y increases upward, so sort descending
  const rows: PositionedText[][] = []
  let currentRow: PositionedText[] = []
  let currentY: number | null = null

  for (const item of sorted) {
    if (currentY === null || Math.abs(item.y - currentY) < 3) {
      currentRow.push(item)
      currentY = currentY === null ? item.y : currentY
    } else {
      if (currentRow.length > 0) rows.push(currentRow)
      currentRow = [item]
      currentY = item.y
    }
  }
  if (currentRow.length > 0) rows.push(currentRow)
  return rows.map((row) => row.sort((a, b) => a.x - b.x))
}

const DATE_PATTERN = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})|(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{2,4})/i
const AMOUNT_PATTERN = /([+-]?)\$?\s?(\d{1,3}(?:,\d{3})*\.\d{2})\s*(CR|DR)?/i

function parseRowDate(text: string): Date | null {
  const match = text.match(DATE_PATTERN)
  if (!match) return null
  if (match[1]) {
    // D/M/YYYY or D-M-YYYY
    const day = parseInt(match[1])
    const month = parseInt(match[2])
    let year = parseInt(match[3])
    if (year < 100) year += 2000
    const d = new Date(year, month - 1, day)
    return isNaN(d.getTime()) ? null : d
  }
  if (match[4]) {
    const d = new Date(`${match[4]} ${match[5]} ${match[6]}`)
    return isNaN(d.getTime()) ? null : d
  }
  return null
}

export async function parsePdfStatement(file: File, categories: Category[] = []): Promise<{ transactions: ParsedTransaction[]; skipped: string[] }> {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise

  const transactions: ParsedTransaction[] = []
  const skipped: string[] = []

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()

    const items: PositionedText[] = content.items
      .filter((it): it is typeof it & { str: string; transform: number[] } => 'str' in it && 'transform' in it && it.str.trim().length > 0)
      .map((it) => ({ text: it.str.trim(), x: it.transform[4], y: it.transform[5] }))

    const rows = groupIntoRows(items)
    const rowTexts = rows.map((row) => row.map((r) => r.text).join(' '))

    // Confirmed via testing against a real Westpac statement: each
    // transaction wraps across multiple physical lines — the date and
    // description start it, but the amount and running balance land on
    // a continuation line below with no date of its own. Treating each
    // physical line as an independent row (the original approach) meant
    // no single row ever had both a date AND an amount together, so
    // every transaction failed to parse. Instead, a row starting with a
    // date opens a new transaction block, and every following row
    // WITHOUT its own date gets folded into it, until the next
    // date-starting row begins the next one.
    let currentBlock: string[] | null = null
    const blocks: string[] = []

    for (const rowText of rowTexts) {
      const startsWithDate = new RegExp(`^\\s*(${DATE_PATTERN.source})`, 'i').test(rowText)
      if (startsWithDate) {
        if (currentBlock) blocks.push(currentBlock.join(' '))
        currentBlock = [rowText]
      } else if (currentBlock) {
        currentBlock.push(rowText)
      }
      // rows before any date-starting row (report header, account info)
      // are simply never captured into a block — correctly ignored.
    }
    if (currentBlock) blocks.push(currentBlock.join(' '))

    interface Draft { amount: number; note: string; date: Date; textIsExpense: boolean; balance: number | null; balanceIsDr: boolean }
    const drafts: Draft[] = []

    for (const blockText of blocks) {
      const date = parseRowDate(blockText)
      if (!date) continue

      const amountMatches = [...blockText.matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))]
      if (amountMatches.length === 0) {
        skipped.push(blockText)
        continue
      }
      // With two or more matches, the last is almost always a running
      // balance and the second-to-last the actual transaction amount —
      // with only one match, that single figure IS the transaction
      // amount (no balance column present).
      const amountMatch = amountMatches.length >= 2 ? amountMatches[amountMatches.length - 2] : amountMatches[0]
      const balanceMatch = amountMatches.length >= 2 ? amountMatches[amountMatches.length - 1] : null
      const amount = parseFloat(amountMatch[2].replace(/,/g, ''))
      const balance = balanceMatch ? parseFloat(balanceMatch[2].replace(/,/g, '')) : null
      // Confirmed on a real NAB statement: the DR/CR marker sits on the
      // BALANCE, not the transaction amount itself — checking only the
      // amount's own suffix (as the Westpac-only version of this did)
      // misses it entirely there.
      const balanceIsDr = balanceMatch?.[3]?.toUpperCase() === 'DR'
      // Text-based sign as a fallback only — many statements (confirmed
      // on a real one) show deposits as a bare positive number with no
      // "+" and no "CR"/"DR" marker on the amount at all, which would
      // otherwise default to being read as an expense.
      const textIsExpense = amountMatch[1] === '-' || amountMatch[3]?.toUpperCase() === 'DR'

      let note = blockText
        .replace(new RegExp(DATE_PATTERN.source, 'gi'), ' ')
        .replace(new RegExp(AMOUNT_PATTERN, 'gi'), ' ')
        .replace(/\\/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!note) note = 'Transaction'

      drafts.push({ amount, note, date, textIsExpense, balance, balanceIsDr })
    }

    // Confirmed different banks order their statements differently —
    // Westpac newest-first, NAB oldest-first. Detect which by comparing
    // the first and last parsed dates, rather than assuming one
    // direction and silently getting every sign backwards on the other.
    const oldestFirst = drafts.length >= 2 && drafts[0].date.getTime() <= drafts[drafts.length - 1].date.getTime()

    // Confirmed different account types use opposite balance
    // conventions: a regular bank account's balance goes DOWN when you
    // spend, but a DR-denominated account (a credit card, where DR means
    // "amount owed") goes UP when you spend — the same delta sign means
    // opposite things depending on which this is.
    const isDrAccount = drafts.some((d) => d.balanceIsDr)

    for (let i = 0; i < drafts.length; i++) {
      const draft = drafts[i]
      const priorIndex = oldestFirst ? i - 1 : i + 1
      const balanceBefore = drafts[priorIndex]?.balance ?? null
      let isExpense = draft.textIsExpense
      if (draft.balance !== null && balanceBefore !== null) {
        const delta = draft.balance - balanceBefore
        if (Math.abs(Math.abs(delta) - draft.amount) < 0.01) {
          isExpense = isDrAccount ? delta > 0 : delta < 0
        }
      } else if (isDrAccount) {
        // No neighbor to compare against (the very first or last row in
        // the list) — a DR-denominated account is overwhelmingly
        // expenses (a credit card statement), so that's a far safer
        // default here than the unreliable text-based sign, which
        // regularly finds no marker at all on either side.
        isExpense = true
      }
      transactions.push({
        id: uuid(),
        amount: draft.amount,
        note: draft.note,
        date: draft.date.toISOString(),
        isExpense,
        suggestedCategoryId: suggestCategoryId(draft.note, categories)
      })
    }
  }

  return { transactions, skipped }
}
