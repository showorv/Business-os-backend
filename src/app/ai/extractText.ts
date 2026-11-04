import { createHash } from "node:crypto";
import { createCanvas } from "@napi-rs/canvas";
import { readImageText } from "../../lib/ocr.js";

// A page with less text than this is treated as a scan.
const MIN_TEXT_CHARS = 20;
const MAX_PDF_PAGES = 200;
// OCR takes seconds per page, so a very long scan is only partly read. The result says so.
const MAX_OCR_PAGES = 50;
const RENDER_SCALE = 2;

export interface PageText {
  page: number;
  text: string;
}

export interface ExtractedText {
  pages: PageText[];
  pagesSkipped: number;
}

export const sha256OfBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

// Text stored in a PDF with Bangla in it is usually out of order or broken, because of how its letters
// are shaped. Reading the page as an image gives far better results.
const hasBangla = (text: string) => /[ঀ-৿]/.test(text);

const readPdf = async (bytes: Buffer): Promise<ExtractedText> => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  // A damaged or password-protected file won't improve by retrying.
  const document = await loading.promise.catch(() => null);
  if (!document) return { pages: [], pagesSkipped: 0 };

  const pages: PageText[] = [];
  let ocrPages = 0;
  let pagesSkipped = Math.max(0, document.numPages - MAX_PDF_PAGES);

  for (let number = 1; number <= Math.min(document.numPages, MAX_PDF_PAGES); number += 1) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const text = content.items.map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "")).join("");

    if (text.trim().length >= MIN_TEXT_CHARS && !hasBangla(text)) {
      pages.push({ page: number, text });
    } else if (ocrPages >= MAX_OCR_PAGES) {
      pagesSkipped += 1;
    } else {
      ocrPages += 1;
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport }).promise;
      pages.push({ page: number, text: await readImageText(canvas.toBuffer("image/png")) });
    }
    page.cleanup();
  }
  await loading.destroy();
  return { pages, pagesSkipped };
};

export const extractText = async (bytes: Buffer, mime: string): Promise<ExtractedText> =>
  mime === "application/pdf" ? readPdf(bytes) : { pages: [{ page: 1, text: await readImageText(bytes) }], pagesSkipped: 0 };
