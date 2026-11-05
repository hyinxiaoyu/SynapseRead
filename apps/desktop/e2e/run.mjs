// `pnpm e2e`: builds nothing itself; `pnpm build:web` must have produced `dist`.

import { epubFlow } from './epub.mjs';
import { launchPage, serveDist } from './harness.mjs';
import { pdfFlow } from './pdf.mjs';
import { txtFlow } from './txt.mjs';

const FLOWS = { txt: txtFlow, pdf: pdfFlow, epub: epubFlow };

const only = process.argv.slice(2);
const server = await serveDist();
let failed = false;

for (const [name, flow] of Object.entries(FLOWS)) {
  if (only.length > 0 && !only.includes(name)) continue;
  // A fresh browser per flow: one engine's state must not hide another's bugs.
  const { page, close } = await launchPage(server.url);
  try {
    await flow(page);
    const violations = await page.cspViolations();
    if (violations.length > 0) throw new Error(`CSP violations: ${violations.join(', ')}`);
    if (page.errors.length > 0) throw new Error(`page errors: ${page.errors.join('\n')}`);
    console.log(`ok   ${name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${name}: ${error.message}`);
    if (page.errors.length > 0) console.error(`page errors: ${page.errors.join('\n')}`);
  } finally {
    close();
  }
}

server.close();
process.exit(failed ? 1 : 0);
