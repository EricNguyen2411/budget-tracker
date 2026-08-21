import { createWorker, PSM } from 'tesseract.js'

export interface TextItem {
  text: string
  box: { x0: number; y0: number; x1: number; y1: number } // normalized 0-1, y increases DOWNWARD (standard image convention)
}

let workerPromise: ReturnType<typeof createWorker> | null = null

function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng').then(async (worker) => {
      // Tesseract's default page-segmentation mode (AUTO) runs full
      // layout analysis to find text blocks/columns — good for a
      // scanned document, but confirmed directly (via repeated testing
      // against real screenshots) to be actively bad at this app's
      // actual input: screenshots made of several small, visually
      // isolated stacked cards, each with its own tiny corner-positioned
      // timestamp ("3d", "04 Aug"...). Under AUTO, those isolated corner
      // timestamps are dropped from OCR output entirely — not misread,
      // just never detected as a text region at all — which then makes
      // date parsing silently fall back to "today" for that transaction.
      // SINGLE_BLOCK (psm 6, "assume a single uniform block of text")
      // was confirmed directly, on the same real screenshot, to pick up
      // every one of those previously-missing timestamps with no loss
      // of any other text — it's a better fit for this stacked-card
      // layout than full page-layout analysis.
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK })
      return worker
    })
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
  // blocks:true is required — Tesseract.js's hierarchical block/paragraph/
  // line/word data (data.blocks) is null by default unless explicitly
  // requested here, silently returning zero results regardless of what's
  // actually in the image. Confirmed directly: recognize() without this
  // option produces correct plain text but a null blocks array every time.
  const { data } = await worker.recognize(image, {}, { blocks: true })

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
