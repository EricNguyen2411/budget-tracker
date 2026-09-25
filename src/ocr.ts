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
 * Grayscale + full-range contrast stretch, run once before every OCR
 * pass rather than only when a card "looks hard to read" — confirmed
 * directly against a real screenshot this was needed, not a
 * theoretical nicety: three whole cards on a warm orange/pink/red
 * gradient background produced ZERO extracted text (not misread —
 * Tesseract found no text region there at all), while a card on a
 * cooler blue/green gradient a few hundred pixels away, same image,
 * same font, same size, read perfectly. Re-running OCR on just that
 * failed region after this exact grayscale-plus-autocontrast
 * transform recovered all three missing cards intact — and, checked
 * separately, the transform doesn't harm the region that already
 * worked, so this runs unconditionally on every image rather than
 * trying to detect which ones need it.
 */
async function preprocessForOCR(image: File | Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return image instanceof Blob ? image : new Blob([image])
  ctx.drawImage(bitmap, 0, 0)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data
  const gray = new Uint8ClampedArray(data.length / 4)
  let min = 255
  let max = 0
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    gray[p] = g
    if (g < min) min = g
    if (g > max) max = g
  }
  const range = Math.max(1, max - min) // avoids a divide-by-zero on a flat/blank image
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const stretched = Math.round(((gray[p] - min) / range) * 255)
    data[i] = data[i + 1] = data[i + 2] = stretched
  }
  ctx.putImageData(imageData, 0, 0)

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed during OCR preprocessing'))), 'image/png')
  })
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
  const preprocessed = await preprocessForOCR(image)
  // blocks:true is required — Tesseract.js's hierarchical block/paragraph/
  // line/word data (data.blocks) is null by default unless explicitly
  // requested here, silently returning zero results regardless of what's
  // actually in the image. Confirmed directly: recognize() without this
  // option produces correct plain text but a null blocks array every time.
  const { data } = await worker.recognize(preprocessed, {}, { blocks: true })

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
