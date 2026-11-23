import { assert } from './harness.mjs';

const visible = (testId) =>
  `[...document.querySelectorAll('[data-testid="${testId}"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;

const visibleTxtScroll = visible('txt-scroll');

async function clickTestId(page, testId) {
  const point = await page.waitFor(
    `(() => {
      const el = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
      if (!el || !el.checkVisibility({ visibilityProperty: true })) return null;
      if ('disabled' in el && el.disabled) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
    `clickable element [data-testid="${testId}"]`,
  );
  await page.click(point);
}

/**
 * End-to-end Wave 4 LAN Book Sync flow (#149 / LS-19):
 * - Opens File -> Share Books on This Network via preview menu controller, checks
 *   contrast, modal Tab/Shift+Tab trapping, modified-shortcut isolation (`R3-04`),
 *   focus restoration, Focus Mode floating indicator (`R3-05`), and blocked-peer alert.
 * - Opens File -> Import from Another Device, tests pairing error + Retry, catalog
 *   search, ineligible changed-book guard with 0 relink buttons, §2.3 preview controls,
 *   bookmark deselection, contrast, Batch 1 (new book + bookmark-only 0-byte transfer
 *   + live Bookmark refresh), Back to catalog (`R3-09`), Batch 2 (open-book flush +
 *   real CAS conflict + 1-click override), and Batch 3 (mid-transfer Escape/backdrop
 *   guard + Cancel + Retry failed items + Continue reading).
 */
export async function lanSyncFlow(page) {
  const isMac = await page.evaluate('/mac/i.test(navigator.platform)');
  const PRIMARY = isMac ? 4 : 2;
  const SHIFT = 8;

  // 1. Open both a TXT and a PDF book so local documents exist for sharing,
  // open-book close-and-flush, and localFileChanged testing.
  await page.openUntil(`${visible('txt-viewer')}`, 'the TXT reader');
  await page.openUntil(`${visible('pdf-viewer')}`, 'the PDF reader');

  // Return to the TXT tab and confirm the reader scroll surface holds keyboard focus.
  const txtTabPoint = await page.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('[aria-label="Open documents"] [role="tab"]')];
    const txtTab = tabs.find((tab) => tab.textContent.trim().startsWith('sample') && tab.getAttribute('aria-selected') === 'false');
    if (!txtTab) return null;
    const r = txtTab.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert(txtTabPoint !== null, 'expected sample TXT tab to be open alongside PDF');
  await page.click(txtTabPoint);
  await page.waitFor(`${visibleTxtScroll}`, 'sample TXT viewer to activate');
  await page.evaluate(`${visibleTxtScroll}.focus({ preventScroll: true })`);

  const localDocs = await page.evaluate('window.__synapsePreview.lan.listLocalDocuments()');
  const sampleTxtDoc = localDocs.find((d) => d.format === 'txt');
  const samplePdfDoc = localDocs.find((d) => d.format === 'pdf');
  assert(
    sampleTxtDoc && samplePdfDoc,
    `expected TXT and PDF local docs, got ${JSON.stringify(localDocs)}`,
  );

  // Seed a local cursor on sample.txt so §2.3 defaults position import to "Keep yours" (unchecked).
  await page.evaluate(
    `window.__synapsePreview.lan.mutateLocalCursor(${JSON.stringify(sampleTxtDoc.id)}, { format: 'txt', startByteOffset: 0, endByteOffset: 5, lineIndex: 0 }, 0.2)`,
  );

  // 2. File -> Share Books on This Network…
  await page.evaluate("window.__synapsePreview.chooseMenuCommand('file.shareOnNetwork')");
  await page.waitFor(
    `document.querySelector('[data-testid="lan-share-dialog"]')?.checkVisibility({ visibilityProperty: true })`,
    'LAN Share dialog to open from File menu',
  );

  await clickTestId(page, 'lan-share-start');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-share-address"]')?.textContent?.includes(':49319')
      && /^\\d{6}$/.test(document.querySelector('[data-testid="lan-share-code"]')?.textContent?.trim() ?? '')`,
    'active LAN share address and 6-digit pairing code',
  );
  await page.assertContrast('[data-testid="lan-share-dialog"]', 'LAN share dialog');

  // Verify Tab and Shift+Tab trap focus inside the Share dialog, and background modified
  // shortcuts (W, O, D, Shift+F) are ignored while the modal is open (`R3-04`, `T-56`).
  for (let i = 0; i < 6; i += 1) {
    await page.press('Tab', 'Tab', 0);
    const trapped = await page.evaluate(
      `document.querySelector('[data-testid="lan-share-dialog"]')?.contains(document.activeElement) ?? false`,
    );
    assert(trapped, `Tab step ${i + 1} escaped LAN share dialog`);
  }
  await page.press('Tab', 'Tab', SHIFT);
  assert(
    await page.evaluate(
      `document.querySelector('[data-testid="lan-share-dialog"]')?.contains(document.activeElement) ?? false`,
    ),
    'Shift+Tab escaped LAN share dialog',
  );

  const tabCountBefore = await page.evaluate(`document.querySelectorAll('[role="tab"]').length`);
  await page.press('w', 'KeyW', PRIMARY);
  await page.press('o', 'KeyO', PRIMARY);
  await page.press('d', 'KeyD', PRIMARY);
  await page.press('f', 'KeyF', PRIMARY | SHIFT);
  const tabCountAfter = await page.evaluate(`document.querySelectorAll('[role="tab"]').length`);
  assert(
    tabCountBefore === tabCountAfter,
    `background shortcut mutated open tabs (${tabCountBefore} -> ${tabCountAfter})`,
  );
  assert(!(await page.inFocusMode()), 'Focus Mode toggled while modal dialog was open');

  await clickTestId(page, 'lan-share-close');
  await page.waitFor(
    `!document.querySelector('[data-testid="lan-share-dialog"]')`,
    'LAN Share dialog to close on Hide',
  );
  assert(
    await page.evaluate(`document.activeElement === (${visibleTxtScroll})`),
    'closing LAN Share dialog did not restore focus to the TXT reader scroll surface',
  );

  // 3. Focus Mode keeps floating sharing indicator accessible (`R3-05`, `OD-11`)
  // and live peer-blocked alerts appear inside the dialog (`R3-10`).
  await page.enterFocusMode(visibleTxtScroll);
  await page.waitFor(
    `document.querySelector('[data-testid="lan-share-floating-indicator"]')?.checkVisibility({ visibilityProperty: true })`,
    'floating LAN share indicator while Focus Mode toolbar is hidden',
  );
  await clickTestId(page, 'lan-share-floating-indicator');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-share-dialog"]')?.checkVisibility({ visibilityProperty: true })`,
    'floating sharing indicator to reopen LAN Share dialog',
  );

  await page.evaluate(`window.__synapsePreview.lan.simulateSharePeerBlocked('10.9.9.9')`);
  await page.waitFor(
    `document.querySelector('[data-testid="lan-share-blocked-peer-notice"]')?.textContent?.includes('10.9.9.9')`,
    'blocked-peer notice with source IP inside LAN Share dialog',
  );

  await clickTestId(page, 'lan-share-stop');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-share-start"]')?.checkVisibility({ visibilityProperty: true })`,
    'LAN sharing listener to stop',
  );
  await page.press('Escape', 'Escape', 0);
  await page.waitFor(
    `!document.querySelector('[data-testid="lan-share-dialog"]')`,
    'Share dialog closed after stopping',
  );
  // Leave Focus Mode with Escape now that no dialog/popover is open.
  await page.press('Escape', 'Escape', 0);
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"]')?.dataset.immersive !== 'true'`,
    'leaving Focus Mode after Share flow',
  );

  // 4. Configure deterministic fake peer catalog & inject 1-shot connect error.
  // Omit `bookId` on new/alternate TXT books so `memoryLanPeer` computes their
  // authentic `hashBytes(bytes)` digest (matching `verifyDocumentSource` on reopen).
  const changedPdfBookId = samplePdfDoc.fileHash;
  const offlineBookId = 'book-e2e-offline';

  await page.evaluate(`(() => {
    const enc = (s) => new TextEncoder().encode(s);
    const travelogueBytes = enc('Chapter 1\\n\\nRemote travelogue text for LAN import.\\nSecond paragraph.\\n');
    const chronicleBytes = enc('Chapter 1\\n\\nOpening line of Retryable Chronicle.\\nSecond line of text.\\n');
    const altSampleBytes = enc('Alternate edition of sample for E2E version matching.\\n');

    window.__synapsePreview.lan.setBooks([
      {
        title: 'LAN Travelogue',
        format: 'txt',
        extension: 'txt',
        bytes: travelogueBytes,
        fileAvailable: true,
        position: {
          anchor: { format: 'txt', startByteOffset: 11, endByteOffset: 24, lineIndex: 2 },
          progress: 0.4,
        },
        bookmarks: [
          {
            anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 9, lineIndex: 0 },
            label: 'Travel Start',
            createdAt: '2026-11-22T10:00:00.000Z',
          },
          {
            anchor: { format: 'txt', startByteOffset: 11, endByteOffset: 24, lineIndex: 2 },
            label: 'Midway Note',
            createdAt: '2026-11-22T11:00:00.000Z',
          },
          {
            anchor: null,
            label: 'Legacy Unsupported Anchor',
            skipReason: { kind: 'unsupportedAnchor', reason: 'legacy format' },
          },
        ],
      },
      {
        bookId: ${JSON.stringify(sampleTxtDoc.fileHash)},
        title: 'sample',
        format: 'txt',
        extension: 'txt',
        bytes: enc('sample'),
        fileAvailable: true,
        position: {
          anchor: { format: 'txt', startByteOffset: 20, endByteOffset: 25, lineIndex: 1 },
          progress: 0.9,
        },
        bookmarks: [
          {
            anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 5, lineIndex: 0 },
            label: 'Remote Mark 1',
          },
          {
            anchor: { format: 'txt', startByteOffset: 6, endByteOffset: 10, lineIndex: 0 },
            label: 'Remote Mark 2',
          },
        ],
      },
      {
        title: 'sample',
        format: 'txt',
        extension: 'txt',
        bytes: altSampleBytes,
        fileAvailable: true,
        position: {
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 9, lineIndex: 0 },
          progress: 0.5,
        },
        bookmarks: [],
      },
      {
        title: 'Retryable Chronicle',
        format: 'txt',
        extension: 'txt',
        bytes: chronicleBytes,
        fileAvailable: true,
        position: {
          anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 9, lineIndex: 0 },
          progress: 0.3,
        },
        bookmarks: [
          {
            anchor: { format: 'txt', startByteOffset: 11, endByteOffset: 23, lineIndex: 2 },
            label: 'Chronicle Mark',
          },
        ],
      },
      {
        bookId: ${JSON.stringify(changedPdfBookId)},
        title: ${JSON.stringify(samplePdfDoc.title)},
        format: 'pdf',
        extension: 'pdf',
        bytes: enc('dummy-pdf-peer-bytes'),
        fileAvailable: true,
        position: null,
        bookmarks: [],
      },
      {
        bookId: ${JSON.stringify(offlineBookId)},
        title: 'Offline Archive',
        format: 'txt',
        extension: 'txt',
        fileAvailable: false,
      },
    ]);

    window.__synapsePreview.lan.mutateLocalFile(${JSON.stringify(samplePdfDoc.id)}, enc('locally-modified-pdf'));
    window.__synapsePreview.lan.setNextError('lanImportConnect', {
      code: 'lan_auth_invalid',
      message: 'pairing code mismatch',
    });
  })()`);

  // File -> Import from Another Device…
  await page.evaluate("window.__synapsePreview.chooseMenuCommand('file.importFromDevice')");
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-address-input"]')?.checkVisibility({ visibilityProperty: true })`,
    'LAN Import Connect step',
  );

  await page.setInputValue('[data-testid="lan-import-address-input"]', '192.168.1.42');
  await page.setInputValue('[data-testid="lan-import-code-input"]', '123456');
  await clickTestId(page, 'lan-import-connect-submit');

  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-connect-error"]')?.dataset.errorCode === 'lan_auth_invalid'`,
    'Connect error alert with lan_auth_invalid',
  );
  await clickTestId(page, 'lan-import-connect-retry');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-catalog-list"]')?.checkVisibility({ visibilityProperty: true })`,
    'LAN Import Catalog list after Retry',
  );

  const resolvedIds = await page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid^="lan-import-catalog-row-"]')];
    const idOf = (title, state) => {
      const row = rows.find((el) => el.dataset.syncState === state && el.textContent.includes(title));
      return row?.getAttribute('data-testid')?.replace('lan-import-catalog-row-', '') ?? null;
    };
    return {
      travelogue: idOf('LAN Travelogue', 'new'),
      chronicle: idOf('Retryable Chronicle', 'new'),
      altSample: idOf('sample', 'sameTitleDifferentVersion'),
    };
  })()`);
  assert(
    resolvedIds.travelogue && resolvedIds.chronicle && resolvedIds.altSample,
    `failed to resolve catalog bookIds: ${JSON.stringify(resolvedIds)}`,
  );
  const travelogueBookId = resolvedIds.travelogue;
  const chronicleBookId = resolvedIds.chronicle;
  const altSampleBookId = resolvedIds.altSample;

  // 5. Catalog search, ineligible row guard, and Preview §2.3 inspection.
  await page.setInputValue('[data-testid="lan-import-catalog-search"]', 'Travelogue');
  await page.waitFor(
    `document.querySelectorAll('[data-testid="lan-import-catalog-list"] label').length === 1`,
    'catalog search filtering to LAN Travelogue',
  );
  await page.setInputValue('[data-testid="lan-import-catalog-search"]', '');
  await page.waitFor(
    `document.querySelectorAll('[data-testid="lan-import-catalog-list"] label').length === 6`,
    'clearing catalog search restores all 6 items',
  );

  const offlineDisabled = await page.evaluate(
    `document.querySelector('[data-testid="lan-import-catalog-checkbox-${offlineBookId}"]')?.disabled === true`,
  );
  assert(offlineDisabled, 'expected Offline Archive checkbox to be disabled');
  assert(
    (await page.evaluate(
      `[...document.querySelectorAll('[data-testid="lan-import-dialog"] button')].filter((b) => /relink/i.test(b.textContent)).length`,
    )) === 0,
    'expected zero relink buttons in catalog',
  );

  // Select Batch 1 items + localFileChanged PDF + sameTitleDifferentVersion sample -> Review import
  await clickTestId(page, `lan-import-catalog-checkbox-${travelogueBookId}`);
  await clickTestId(page, `lan-import-catalog-checkbox-${sampleTxtDoc.fileHash}`);
  await clickTestId(page, `lan-import-catalog-checkbox-${altSampleBookId}`);
  await clickTestId(page, `lan-import-catalog-checkbox-${changedPdfBookId}`);
  await clickTestId(page, 'lan-import-review');

  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-start-execute"]')?.checkVisibility({ visibilityProperty: true })`,
    'LAN Import Preview step',
  );

  // Verify localFileChanged copy and 0 relink buttons in Preview.
  const changedRowState = await page.evaluate(`({
    syncState: document.querySelector('[data-testid="lan-import-preview-row"][data-book-id="${changedPdfBookId}"]')?.dataset.syncState,
    ineligibleText: document.querySelector('[data-testid="lan-import-preview-ineligible-${changedPdfBookId}"]')?.textContent?.trim(),
    relinkCount: [...document.querySelectorAll('[data-testid="lan-import-dialog"] button')].filter((b) => /relink/i.test(b.textContent)).length,
    altChecked: document.querySelector('[data-testid="lan-import-file-checkbox-${altSampleBookId}"]')?.checked,
  })`);
  assert(
    changedRowState.syncState === 'localFileChanged',
    `expected changed PDF state=localFileChanged, got ${changedRowState.syncState}`,
  );
  assert(
    changedRowState.ineligibleText?.includes(
      'Local file changed. Open this book to resolve the change first.',
    ),
    `unexpected localFileChanged message: ${changedRowState.ineligibleText}`,
  );
  assert(changedRowState.relinkCount === 0, 'expected 0 relink buttons in Preview');
  assert(
    changedRowState.altChecked === false,
    'expected sameTitleDifferentVersion to start unchecked',
  );

  // Expand bookmarks on LAN Travelogue and uncheck the second bookmark (`index=1`).
  await clickTestId(page, `lan-import-bookmarks-toggle-${travelogueBookId}`);
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-bookmarks-list-${travelogueBookId}"]')`,
    'expanded bookmark list on LAN Travelogue',
  );
  await clickTestId(page, `lan-import-bookmark-checkbox-${travelogueBookId}-1`);
  await page.assertContrast('[data-testid="lan-import-dialog"]', 'LAN import preview dialog');

  // Ensure existing open sample.txt starts with position unchecked (bookmark-only 0-byte transfer).
  assert(
    await page.evaluate(
      `document.querySelector('[data-testid="lan-import-position-checkbox-${sampleTxtDoc.fileHash}"]')?.checked === false`,
    ),
    'expected existing book with local cursor to default to Keep yours (unchecked)',
  );

  // 6. Execute Batch 1: new book (1 bookmark) + bookmark-only update on sample.txt (2 bookmarks).
  await clickTestId(page, 'lan-import-start-execute');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-results"]')?.checkVisibility({ visibilityProperty: true })`,
    'Batch 1 import results',
  );
  const batch1Text = await page.evaluate(
    `({
      banner: document.querySelector('[data-testid="lan-import-results-banner"]')?.dataset.reportStatus,
      travelogue: document.querySelector('[data-testid="lan-import-result-row"][data-book-id="${travelogueBookId}"]')?.textContent,
      sample: document.querySelector('[data-testid="lan-import-result-row"][data-book-id="${sampleTxtDoc.fileHash}"]')?.textContent,
    })`,
  );
  assert(
    batch1Text.banner === 'completed',
    `expected completed Batch 1 banner, got ${batch1Text.banner}`,
  );
  assert(
    batch1Text.travelogue?.includes('File: Imported') && batch1Text.travelogue?.includes('(+1)'),
    `expected travelogue imported with +1 bookmark, got: ${batch1Text.travelogue}`,
  );
  assert(
    batch1Text.sample?.includes('File: Skipped') && batch1Text.sample?.includes('(+2)'),
    `expected sample bookmark-only with +2 bookmarks, got: ${batch1Text.sample}`,
  );

  // 7. Back to catalog (`R3-09`) keeps session alive -> Batch 2 (open book flush + Conflict override).
  await clickTestId(page, 'lan-import-back-to-catalog');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-catalog-list"]')?.checkVisibility({ visibilityProperty: true })`,
    'Back to catalog after Batch 1',
  );
  assert(
    (await page.evaluate('window.__synapsePreview.lan.getPeerStats().disconnectCount')) === 0,
    'Back to catalog must NOT disconnect the paired LAN session',
  );

  await clickTestId(page, 'lan-import-catalog-clear');
  await clickTestId(page, `lan-import-catalog-checkbox-${sampleTxtDoc.fileHash}`);
  await clickTestId(page, 'lan-import-review');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-position-checkbox-${sampleTxtDoc.fileHash}"]')?.checkVisibility({ visibilityProperty: true })`,
    'Batch 2 Preview for open book',
  );

  // Check "Close and use source position" and verify open-book warning appears.
  const openPosLabel = await page.evaluate(
    `document.querySelector('[data-testid="lan-import-position-checkbox-${sampleTxtDoc.fileHash}"]')?.closest('label')?.textContent`,
  );
  assert(
    openPosLabel?.includes('Close and use source position'),
    `expected open book checkbox label, got: ${openPosLabel}`,
  );
  await clickTestId(page, `lan-import-position-checkbox-${sampleTxtDoc.fileHash}`);
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-open-book-warning"]')`,
    'open-book close-and-flush warning banner',
  );

  // Pause inside execute after closeDocumentAndFlush completes, mutate local cursor to 72%,
  // and release to trigger a genuine CAS lan_position_conflict.
  const execCountBeforeBatch2 = await page.evaluate(
    'window.__synapsePreview.lan.getPeerStats().executeCount',
  );
  await page.evaluate(`window.__synapsePreview.lan.pauseNextTransfer('execute')`);
  await clickTestId(page, 'lan-import-start-execute');

  await page.waitFor(
    `window.__synapsePreview.lan.getPeerStats().executeCount > ${execCountBeforeBatch2}`,
    'Batch 2 execute to begin after closeDocumentAndFlush',
  );
  await page.evaluate(`(() => {
    window.__synapsePreview.lan.mutateLocalCursor(
      ${JSON.stringify(sampleTxtDoc.id)},
      { format: 'txt', startByteOffset: 10, endByteOffset: 15, lineIndex: 1 },
      0.72,
    );
    window.__synapsePreview.lan.releasePausedTransfer();
  })()`);

  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-conflict-${sampleTxtDoc.fileHash}"]')?.checkVisibility({ visibilityProperty: true })`,
    'position conflict confirmation UI',
  );
  assert(
    await page.evaluate(
      `document.querySelector('[data-testid="lan-import-conflict-${sampleTxtDoc.fileHash}"]')?.textContent?.includes('72%')`,
    ),
    'conflict card did not show updated 72% local reading position',
  );

  await clickTestId(page, `lan-import-conflict-override-${sampleTxtDoc.fileHash}`);
  await page.waitFor(
    `!document.querySelector('[data-testid="lan-import-conflict-${sampleTxtDoc.fileHash}"]')
      && document.querySelector('[data-testid="lan-import-result-row"][data-book-id="${sampleTxtDoc.fileHash}"]')?.textContent?.includes('Position: Applied')`,
    '1-click conflict override to apply source position',
  );

  // 8. Back to catalog -> Batch 3 (Mid-transfer Escape/backdrop guard + Cancel + Retry + Continue reading).
  await clickTestId(page, 'lan-import-back-to-catalog');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-catalog-list"]')?.checkVisibility({ visibilityProperty: true })`,
    'Back to catalog before Batch 3',
  );
  assert(
    (await page.evaluate('window.__synapsePreview.lan.getPeerStats().disconnectCount')) === 0,
    'second Back to catalog must NOT disconnect the paired LAN session',
  );

  await clickTestId(page, 'lan-import-catalog-clear');
  await clickTestId(page, `lan-import-catalog-checkbox-${chronicleBookId}`);
  await clickTestId(page, 'lan-import-review');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-start-execute"]')?.checkVisibility({ visibilityProperty: true })`,
    'Batch 3 Preview for Retryable Chronicle',
  );

  await page.evaluate(`window.__synapsePreview.lan.pauseNextTransfer('commit')`);
  await clickTestId(page, 'lan-import-start-execute');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-progress"] [role="progressbar"]')?.checkVisibility({ visibilityProperty: true })`,
    'active file transfer progress bar',
  );

  // Escape and backdrop click are blocked while transfer is in progress (`R3-04`).
  await page.press('Escape', 'Escape', 0);
  await page.click({ x: 10, y: 10 });
  assert(
    await page.evaluate(
      `document.querySelector('[data-testid="lan-import-dialog"]')?.checkVisibility({ visibilityProperty: true })
        && !!document.querySelector('[data-testid="lan-import-progress"]')`,
    ),
    'active transfer dialog was dismissed by Escape or backdrop click',
  );

  await clickTestId(page, 'lan-import-cancel-transfer');
  await page.evaluate(`window.__synapsePreview.lan.releasePausedTransfer()`);
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-results-banner"]')?.dataset.reportStatus === 'cancelled'`,
    'cancelled Batch 3 results banner',
  );

  await clickTestId(page, 'lan-import-retry-failed');
  await page.waitFor(
    `document.querySelector('[data-testid="lan-import-results-banner"]')?.dataset.reportStatus === 'completed'
      && !!document.querySelector('[data-testid="lan-import-continue-${chronicleBookId}"]')`,
    'Retry failed items completion with Continue reading action',
  );

  // Continue reading disconnects cleanly, closes dialog, and opens Retryable Chronicle in TXT reader.
  await clickTestId(page, `lan-import-continue-${chronicleBookId}`);
  await page.waitFor(
    `!document.querySelector('[data-testid="lan-import-dialog"]')
      && window.__synapsePreview.lan.getPeerStats().disconnectCount === 1
      && ${visibleTxtScroll}?.textContent?.includes('Opening line of Retryable Chronicle.')`,
    'Continue reading to disconnect, close dialog, and open Retryable Chronicle in TXT viewer',
  );

  // Verify live imported bookmark appears in the Bookmarks sidebar for Retryable Chronicle.
  await page.showSidebarTab('Bookmarks');
  await page.waitFor(
    `${visible('txt-viewer')}?.querySelector('[data-testid="bookmark-label"]')?.textContent?.includes('Chronicle Mark')`,
    'live imported bookmark in Bookmarks sidebar',
  );
}
