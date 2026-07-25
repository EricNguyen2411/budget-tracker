import { createWorker } from 'tesseract.js'

export interface TextItem {
  text: string
  box: { x0: number; y0: number; x1: number; y1: number } // normalized 0-1, y increases DOWNWARD (standard image convention)
}

let workerPromise: ReturnType<typeof createWorker> | null = null

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng')
  }
  return workerPromise
}

/**
 * Runs OCR on an image and returns line-level text items with normalized
 * bounding boxes — the same granularity the native app's Vision-based
 * parser worked with (one item per line of text, not per word), so the
 * parsing logic ported from it can work the same way.
 *
 * Important coordinate note: Tesseract's Y axis increases DOWNWARD
 * (standard image convention, top-left origin) — the OPPOSITE of Apple's
 * Vision framework, which the native app was built against (Y increases
 * upward, bottom-left origin). Anywhere the native code sorted by
 * decreasing Y to get top-to-bottom order, this needs increasing Y
 * instead. Y-proximity threshold comparisons (e.g. "is this text on the
 * same line as that anchor") are unaffected by the flip.
 */
export async function recognizeTextItems(image: File | Blob): Promise<TextItem[]> {
  const worker = await getWorker()
  const { data } = await worker.recognize(image)

  const bitmap = await createImageBitmap(image)
  const width = bitmap.width
  const height = bitmap.height

  const items: TextItem[] = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const text = line.text.trim()
        if (!text) continue
        items.push({
          text,
          box: {
            x0: line.bbox.x0 / width,
            y0: line.bbox.y0 / height,
            x1: line.bbox.x1 / width,
            y1: line.bbox.y1 / height
          }
        })
      }
    }
  }

  // Top-to-bottom, then left-to-right within a similar vertical band —
  // matches the order the native parser's row-reconstruction expects.
  return items.sort((a, b) => a.box.y0 - b.box.y0)
}

export async function terminateOCR() {
  if (workerPromise) {
    const worker = await workerPromise
    await worker.terminate()
    workerPromise = null
  }
}
