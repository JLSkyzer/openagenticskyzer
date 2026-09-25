import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PdfJsModule } from './pdf-text.ts';

// The browser side of PDF reading: pdf.js, loaded only when a PDF is attached (it is large), with its worker file
// served by Vite. Kept apart from pdf-text.ts because `?url` only exists under Vite — the unit tests run in Node.
export async function loadPdfjs(): Promise<PdfJsModule> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjs as unknown as PdfJsModule;
}
