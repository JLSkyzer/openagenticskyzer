// file_processor.py::_process_pdf's reading step: the text of every page, joined by a blank line (pypdf's
// "\n\n".join). The PDF library is INJECTED: the browser one needs Vite's worker URL (pdf-loader.ts) and the Node
// one, used by the tests, does not — the reading itself is the same.
interface PdfPage { getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }
interface PdfDocument { numPages: number; getPage(number: number): Promise<PdfPage> }
// In pdf.js the LOADING TASK is what is destroyed (it frees the document and its worker), not the document.
interface PdfLoadingTask { promise: Promise<PdfDocument>; destroy(): Promise<void> }
export interface PdfJsModule {
  getDocument(source: { data: Uint8Array; isEvalSupported?: boolean; verbosity?: number }): PdfLoadingTask;
}

export async function extractPdfText(bytes: Uint8Array, load: () => Promise<PdfJsModule>): Promise<string> {
  const pdfjs = await load();
  // pdf.js takes ownership of (detaches) the buffer it is given: hand it a copy so the caller's bytes stay usable.
  // isEvalSupported: false — the app's Content-Security-Policy forbids eval, which pdf.js would otherwise use for fonts.
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const content = await (await document.getPage(number)).getTextContent();
      pages.push(content.items.map(item => (item.str ?? '') + (item.hasEOL ? '\n' : '')).join('').replace(/\s+$/, ''));
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}
