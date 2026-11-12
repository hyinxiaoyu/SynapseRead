// `pnpm e2e`: builds nothing itself; `pnpm build:web` must have produced `dist`.

import { fileURLToPath } from 'node:url';

import { epubFlow } from './epub.mjs';
import { epubProgressFlow } from './epubProgress.mjs';
import { goToFlow } from './goTo.mjs';
import { launchPage, serveDist, warmUp } from './harness.mjs';
import { keyboardFlow } from './keyboard.mjs';
import { pdfFlow, pdfLayoutFlow, pdfZoomFlow } from './pdf.mjs';
import { txtFlow } from './txt.mjs';
import { txtChaptersFlow } from './txtChapters.mjs';

// The one CSP report that does not fail a flow, and only on a browser shown to send it
// for an inert document. The EPUB flow separately asserts that the handler never ran.
const PARSE_TIME_REPORT = 'script-src-attr inline ';

const FLOWS = {
  txt: txtFlow,
  pdf: pdfFlow,
  'pdf-layout': pdfLayoutFlow,
  'pdf-zoom': pdfZoomFlow,
  epub: epubFlow,
  'epub-progress': epubProgressFlow,
  keyboard: keyboardFlow,
  'txt-chapters': txtChaptersFlow,
  'go-to': goToFlow,
};

// Screenshots of failed flows; CI uploads the folder.
const FAILURES_DIR = fileURLToPath(new URL('../e2e-failures/', import.meta.url));

const only = process.argv.slice(2);
const server = await serveDist();
let failed = false;

console.log(`     warm-up: Chromium and the app ready in ${await warmUp(server.url)} ms`);

for (const [name, flow] of Object.entries(FLOWS)) {
  if (only.length > 0 && !only.includes(name)) continue;
  // A fresh browser per flow: one engine's state must not hide another's bugs.
  let launched;
  try {
    launched = await launchPage(server.url);
  } catch (error) {
    // Reported against the flow, and the rest still run.
    failed = true;
    console.error(`FAIL ${name}: ${error.message}`);
    continue;
  }
  const { page, close } = launched;
  try {
    const { product } = await page.cdp.send('Browser.getVersion');
    const parseReports = await page.parserReportsHandlers();
    console.log(`     ${name}: ${product}, parser reports inline handlers: ${parseReports}`);
    await flow(page);
    const violations = (await page.cspViolations()).filter(
      (violation) => !(parseReports && violation.startsWith(PARSE_TIME_REPORT)),
    );
    if (violations.length > 0) throw new Error(`CSP violations: ${violations.join(', ')}`);
    if (page.errors.length > 0) throw new Error(`page errors: ${page.errors.join('\n')}`);
    console.log(`ok   ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}: ${error.message}`);
    if (page.errors.length > 0) console.error(`page errors: ${page.errors.join('\n')}`);
    await page.diagnose(FAILURES_DIR, name);
  } finally {
    await close();
  }
}

server.close();
process.exit(failed ? 1 : 0);
