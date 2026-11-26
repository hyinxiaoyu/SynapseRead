import { crc32 } from 'node:zlib';

export const visible = (testId) =>
  `[...document.querySelectorAll('[data-testid="${testId}"]')].find((e) => e.checkVisibility({ visibilityProperty: true }))`;

export const toolbar = `document.querySelector('[data-testid="unified-toolbar"]')`;
export const titleIs = (title) =>
  `${toolbar}?.querySelector('[data-testid="reader-toolbar-title"]')?.dataset.documentStem === ${JSON.stringify(title)}`;
export const chapterIs = (title) =>
  `[...(${visible('epub-host')}?.querySelectorAll('iframe') ?? [])].some((view) => view.contentDocument?.querySelector('h1')?.textContent === ${JSON.stringify(title)})`;
export const pdfPageField = `${toolbar}?.querySelector('input[aria-label="Page number"]')`;

export const visibleEpubHost = visible('epub-host');
export const visibleEpubViewer = visible('epub-viewer');
export const visibleEpubArea = visible('epub-page-area');
export const visiblePdfViewer = visible('pdf-viewer');
export const visiblePdfScroll = visible('pdf-scroll');
export const visibleTxtScroll = visible('txt-scroll');

export async function openAppearance(page, { customize = true } = {}) {
  await page.clickButton('Reading appearance');
  await page.waitFor(
    `document.querySelector('[data-testid="appearance-popover"]')`,
    'appearance popover to open',
  );
  if (customize) {
    await page.clickButton('Customize');
    await page.waitFor(
      `document.querySelector('[data-testid="appearance-popover"]') && !document.querySelector('[data-testid="appearance-popover"] [inert]')`,
      'Customize view in appearance popover to become active',
    );
    await new Promise((done) => setTimeout(done, 250));
  }
}

export async function closeAppearance(page) {
  await page.press('Escape');
  await page.waitFor(
    `!document.querySelector('[data-testid="appearance-popover"]')`,
    'appearance popover to close',
  );
  await page.evaluate(`document.activeElement?.blur?.()`);
}

function pageTurnRadioExpr(label) {
  return `(() => {
    const popover = document.querySelector('[data-testid="appearance-popover"]');
    const group = [...(popover?.querySelectorAll('[role="radiogroup"]') ?? [])].find(
      (el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() === 'Page turn',
    );
    return [...(group?.querySelectorAll('[role="radio"]') ?? [])].find(
      (el) => el.textContent?.trim() === ${JSON.stringify(label)},
    );
  })()`;
}

export async function readPageTurnOptions(page, options) {
  await openAppearance(page, options);
  const result = await page.evaluate(`(() => {
    const popover = document.querySelector('[data-testid="appearance-popover"]');
    const group = [...(popover?.querySelectorAll('[role="radiogroup"]') ?? [])].find(
      (el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() === 'Page turn',
    );
    return [...(group?.querySelectorAll('[role="radio"]') ?? [])].map((radio) => ({
      label: radio.textContent?.trim() ?? '',
      checked: radio.getAttribute('aria-checked') === 'true',
    }));
  })()`);
  await closeAppearance(page);
  return result;
}

export async function selectPageTurn(page, label, options) {
  await openAppearance(page, options);
  const radioExpr = pageTurnRadioExpr(label);
  await page.evaluate(`${radioExpr}?.click()`);
  await page.waitFor(
    `${radioExpr}?.getAttribute('aria-checked') === 'true'`,
    `Page turn option ${label} to become active`,
  );
  await closeAppearance(page);
}

function buildUncompressedZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataBytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(dataBytes) >>> 0;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(dataBytes.length, 18);
    local.writeUInt32LE(dataBytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBytes.length, 20);
    central.writeUInt32LE(dataBytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    localChunks.push(local, dataBytes);
    centralChunks.push(central);
    offset += local.length + dataBytes.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, centralDir, end]);
}

export function createSyntheticEpubBase64({ id, title, chapters }) {
  const navItems = chapters
    .map((ch) => `      <li><a href="${ch.href}">${ch.title}</a></li>`)
    .join('\n');
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc">
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`;

  const manifestItems = chapters
    .map((ch) => `    <item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`)
    .join('\n');
  const spineItems = chapters.map((ch) => `    <itemref idref="${ch.id}"/>`).join('\n');

  const contentOpf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${id}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifestItems}
  </manifest>
  <spine>
${spineItems}
  </spine>
</package>`;

  const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/epub+zip"/>
  </rootfiles>
</container>`;

  const entries = [
    { name: 'mimetype', content: 'application/epub+zip' },
    { name: 'META-INF/container.xml', content: containerXml },
    { name: 'OEBPS/content.opf', content: contentOpf },
    { name: 'OEBPS/nav.xhtml', content: nav },
    ...chapters.map((ch) => ({
      name: `OEBPS/${ch.href}`,
      content: `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${ch.title}</title></head>
<body>
  ${ch.body}
</body>
</html>`,
    })),
  ];

  return buildUncompressedZip(entries).toString('base64');
}

export async function dropBinaryFile(page, base64, filename, mimeType) {
  await page.evaluate(`(() => {
    const bin = atob(${JSON.stringify(base64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], ${JSON.stringify(filename)}, { type: ${JSON.stringify(mimeType)} }));
    const main = document.querySelector('main');
    main.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    main.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
}

export async function dropTextFile(page, content, filename) {
  await page.evaluate(`(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(filename)}, { type: 'text/plain' }));
    const main = document.querySelector('main');
    main.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    main.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  })()`);
}
