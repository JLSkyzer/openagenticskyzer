import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText } from '../renderer-src/src/state/pdf-text.ts';
import { processUpload } from '../renderer-src/src/state/upload.ts';

// A real, minimal PDF built in memory (one Helvetica line per page, a correct xref table): pdf.js reads it exactly as
// it would a file from disk. The Node build of pdf.js stands in for the browser one, which only adds a worker.
function buildPdf(pages: string[]): Uint8Array {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  pages.forEach((text, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    const stream = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const loadNodePdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs') as never;
const readPdf = (bytes: Uint8Array) => extractPdfText(bytes, loadNodePdfjs);

test('the text of each page is extracted and pages are joined by a blank line (like pypdf\'s "\\n\\n".join)', async () => {
  assert.equal(await readPdf(buildPdf(['Bonjour PDF', 'Deuxieme page (test)'])), 'Bonjour PDF\n\nDeuxieme page (test)');
  assert.equal(await readPdf(buildPdf(['Une seule'])), 'Une seule');
});

test('extractPdfText does not consume the caller\'s bytes (pdf.js detaches the buffer it is given)', async () => {
  const bytes = buildPdf(['Toujours la']);
  await readPdf(bytes);
  assert.ok(bytes.length > 0, 'the array is still usable');
  assert.equal(await readPdf(bytes), 'Toujours la', 'and reads again');
});

test('a PDF upload becomes a "pdf" attachment with the extracted text', async () => {
  const bytes = buildPdf(['Bonjour PDF']);
  const attachment = await processUpload('rapport.pdf', bytes, { readPdf });
  assert.deepEqual(attachment, { name: 'rapport.pdf', content_type: 'pdf', content: 'Bonjour PDF', size_kb: 1 });
  assert.equal((await processUpload('RAPPORT.PDF', bytes, { readPdf }))?.content_type, 'pdf', 'the extension is case-insensitive');
});

test('an unreadable PDF is a TEXT attachment carrying the error, exactly the original\'s "[Erreur lecture PDF: …]" (the upload is not lost)', async () => {
  const attachment = await processUpload('cassé.pdf', new TextEncoder().encode('ceci n\'est pas un pdf'), { readPdf });
  assert.equal(attachment?.content_type, 'text');
  assert.match(attachment!.content, /^\[Erreur lecture PDF: .+\]$/);
  assert.equal(attachment?.name, 'cassé.pdf');
});

test('PDF text is cut at 50 000 characters like every other text', async () => {
  const attachment = await processUpload('long.pdf', new Uint8Array(10), { readPdf: async () => 'x'.repeat(60000) });
  assert.equal(attachment?.content.length, 50000);
  assert.equal(attachment?.content_type, 'pdf');
});
