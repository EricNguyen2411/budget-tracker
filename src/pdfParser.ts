import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { suggestCategoryId } from './merchantRules'
import type { ParsedTransaction } from './receiptParser'

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

export async function parsePdfStatement(file: File): Promise<{ transactions: ParsedTransaction[]; skipped: string[] }> {
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

    for (const row of rows) {
      const rowText = row.map((r) => r.text).join(' ')
      const date = parseRowDate(rowText)
      if (!date) continue // not every row is a transaction — headers, page numbers, etc.

      const amountMatches = [...rowText.matchAll(new RegExp(AMOUNT_PATTERN, 'gi'))]
      if (amountMatches.length === 0) {
        skipped.push(rowText)
        continue
      }
      // Take the last amount on the row — statements commonly show a
      // running balance after the transaction amount, and the actual
      // transaction figure comes first, but description text sometimes
      // contains reference numbers that coincidentally look like
      // amounts earlier in the row, so last-genuine-amount-match is more
      // reliable than first.
      const lastMatch = amountMatches[amountMatches.length - 1]
      const amount = parseFloat(lastMatch[2].replace(/,/g, ''))
      const isExpense = lastMatch[1] === '-' || lastMatch[3]?.toUpperCase() !== 'CR'

      let note = rowText
        .replace(DATE_PATTERN, ' ')
        .replace(new RegExp(AMOUNT_PATTERN, 'gi'), ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (!note) note = 'Transaction'

      transactions.push({
        id: uuid(),
        amount,
        note,
        date: date.toISOString(),
        isExpense,
        suggestedCategoryId: suggestCategoryId(note)
      })
    }
  }

  return { transactions, skipped }
}
