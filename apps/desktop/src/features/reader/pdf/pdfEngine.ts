import {
  getDocument,
  GlobalWorkerOptions,
  PDFWorker,
  TextLayer,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

import type { DocumentSource, NormalizedRect } from '@/types/domain';

import {
  canvasRegion,
  getBoundedLru,
  MAX_CACHED_ANNOTATION_PAGES,
  MAX_CACHED_TEXT_PAGES,
  normalizeBoxes,
  type PdfRotation,
  setBoundedLru,
} from './pdfGeometry';

// The legacy build because the modern one needs newer WebKit than we target: see
// `docs/adr/0004-pdfjs-worker-csp.md`, which also explains everything else here.
GlobalWorkerOptions.workerSrc = workerUrl;

const assetUrl = (directory: string) => new URL(`pdfjs/${directory}/`, document.baseURI).href;

export interface PageSize {
  width: number;
  height: number;
}

export interface PdfOutlineItem {
  id: string;
  title: string;
  pageIndex: number | null;
  children: readonly PdfOutlineItem[];
}

export interface PdfTextRun {
  text: string;
  rect: NormalizedRect;
  hasEOL?: boolean;
}

export interface PdfPageText {
  pageIndex: number;
  runs: readonly PdfTextRun[];
}

export interface PdfInternalLink {
  id: string;
  rect: NormalizedRect;
  targetPageIndex: number;
  title?: string;
}

export type PdfSupportedEmbeddedSubtype =
  'Highlight' | 'Text' | 'FreeText' | 'Underline' | 'StrikeOut';

export interface PdfEmbeddedAnnotation {
  id: string;
  subtype: PdfSupportedEmbeddedSubtype;
  rects: readonly NormalizedRect[];
  contents: string;
  author?: string;
  color: string;
}

export interface PdfPageAnnotations {
  links: readonly PdfInternalLink[];
  embeddedAnnotations: readonly PdfEmbeddedAnnotation[];
  unsupportedSubtypes: readonly string[];
}

export interface Cancellable {
  promise: Promise<unknown>;
  cancel(): void;
}

/** The whole of what the reader needs from pdf.js; nothing else imports it. */
export interface PdfDocumentHandle {
  readonly pageCount: number;
  /** False if pdf.js fell back to parsing on the main thread. */
  readonly usesRealWorker: boolean;
  /** Embedded PDF outline tree, or an empty array when the document has none. */
  getOutline?(): Promise<readonly PdfOutlineItem[]>;
  /** Extracted text runs and normalized rects for a page, whether rendered or not. */
  getPageText?(pageIndex: number): Promise<PdfPageText>;
  /** Internal links, visible embedded annotations, and disclosed unsupported subtypes on a page. */
  getPageAnnotations?(pageIndex: number): Promise<PdfPageAnnotations>;
  /** Size in CSS pixels at scale 1, including the page's user unit. */
  pageSize(pageIndex: number): Promise<PageSize>;
  renderPage(
    pageIndex: number,
    canvas: HTMLCanvasElement,
    scale: number,
    rotation?: PdfRotation,
  ): Cancellable;
  renderTextLayer(
    pageIndex: number,
    container: HTMLElement,
    scale: number,
    rotation?: PdfRotation,
  ): Cancellable;
  destroy(): void;
}

interface RawOutlineNode {
  title?: string;
  dest?: unknown;
  items?: readonly RawOutlineNode[];
}

async function resolveDestPageIndex(pdf: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const target = resolved[0] as unknown;
    if (
      typeof target === 'number' &&
      Number.isInteger(target) &&
      target >= 0 &&
      target < pdf.numPages
    ) {
      return target;
    }
    if (typeof target === 'object' && target !== null) {
      const index = await pdf.getPageIndex(
        target as Parameters<PDFDocumentProxy['getPageIndex']>[0],
      );
      return index >= 0 && index < pdf.numPages ? index : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function mapPdfOutline(
  pdf: PDFDocumentProxy,
  nodes: readonly RawOutlineNode[],
  prefix = 'outline',
): Promise<PdfOutlineItem[]> {
  const items: PdfOutlineItem[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node) continue;
    const id = `${prefix}-${index}`;
    const pageIndex = await resolveDestPageIndex(pdf, node.dest);
    const children = node.items ? await mapPdfOutline(pdf, node.items, id) : [];
    items.push({
      id,
      title: (node.title ?? '').trim() || `Section ${index + 1}`,
      pageIndex,
      children,
    });
  }
  return items;
}

/** Runs `render` once the page has loaded, unless already cancelled. */
function cancellableOnPage(
  document: PDFDocumentProxy,
  pageIndex: number,
  render: (page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>) => Cancellable,
): Cancellable {
  let cancelled = false;
  let inner: Cancellable | null = null;
  return {
    promise: document.getPage(pageIndex + 1).then((page) => {
      if (cancelled) return undefined;
      inner = render(page);
      return inner.promise;
    }),
    cancel() {
      cancelled = true;
      inner?.cancel();
    },
  };
}

const PDF_RANGE_CHUNK_BYTES = 64 * 1024;

export async function openPdfDocument(source: DocumentSource): Promise<PdfDocumentHandle> {
  const worker = new PDFWorker();
  await worker.promise;
  // pdf.js falls back silently and the page still renders, so nothing else would show this.
  const usesRealWorker = worker.port instanceof Worker;
  if (!usesRealWorker) console.error('pdf.js could not start its worker');

  const task = getDocument({
    // pdf.js takes ownership of the buffer it is given, but a source may be reused.
    ...(source.kind === 'url' ? { url: source.url } : { data: source.bytes.slice() }),
    worker,
    rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
  const pdf = await task.promise;
  const pageTextCache = new Map<number, Promise<PdfPageText>>();
  const pageAnnotationsCache = new Map<number, Promise<PdfPageAnnotations>>();
  const pageSizeCache = new Map<number, Promise<PageSize>>();

  const SUPPORTED_EMBEDDED_SUBTYPES = new Set<PdfSupportedEmbeddedSubtype>([
    'Highlight',
    'Text',
    'FreeText',
    'Underline',
    'StrikeOut',
  ]);

  const toHexColor = (rawColor: unknown, fallback = '#fde047'): string => {
    if (
      (Array.isArray(rawColor) || ArrayBuffer.isView(rawColor)) &&
      'length' in (rawColor as { length: number }) &&
      (rawColor as { length: number }).length >= 3
    ) {
      const rgb = Array.from(rawColor as ArrayLike<number>).slice(0, 3);
      return `#${rgb
        .map((channel) =>
          Math.min(255, Math.max(0, Math.round(channel)))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
    }
    return fallback;
  };

  return {
    pageCount: pdf.numPages,
    usesRealWorker,

    async getOutline() {
      const raw = (await pdf.getOutline()) as readonly RawOutlineNode[] | null;
      return raw ? mapPdfOutline(pdf, raw) : [];
    },

    getPageText(pageIndex) {
      const cached = getBoundedLru(pageTextCache, pageIndex);
      if (cached) return cached;
      const promise = (async (): Promise<PdfPageText> => {
        const page = await pdf.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const pageBox = { left: 0, top: 0, width: viewport.width, height: viewport.height };
        const runs: PdfTextRun[] = [];
        for (const raw of content.items) {
          if (!('str' in raw) || typeof raw.str !== 'string' || raw.str.length === 0) continue;
          const transform = Array.isArray(raw.transform)
            ? (raw.transform as number[])
            : [1, 0, 0, 1, 0, 0];
          const tx = transform[4] ?? 0;
          const ty = transform[5] ?? 0;
          const fontHeight = Math.abs(
            raw.height || Math.hypot(transform[2] ?? 0, transform[3] ?? 0) || 12,
          );
          const itemWidth = Math.abs(raw.width || fontHeight * raw.str.length * 0.5);
          const [vx1 = 0, vy1 = 0] = viewport.convertToViewportPoint(tx, ty - fontHeight * 0.2);
          const [vx2 = 0, vy2 = 0] = viewport.convertToViewportPoint(
            tx + itemWidth,
            ty + fontHeight * 0.85,
          );
          const left = Math.min(vx1, vx2);
          const top = Math.min(vy1, vy2);
          const width = Math.max(Math.abs(vx2 - vx1), 1);
          const height = Math.max(Math.abs(vy2 - vy1), 2);
          const [rect] = normalizeBoxes([{ left, top, width, height }], pageBox);
          if (rect) {
            runs.push({
              text: raw.str,
              rect,
              ...(raw.hasEOL ? { hasEOL: true } : {}),
            });
          }
        }
        return { pageIndex, runs };
      })();
      setBoundedLru(pageTextCache, pageIndex, promise, MAX_CACHED_TEXT_PAGES);
      return promise;
    },

    getPageAnnotations(pageIndex) {
      const cached = getBoundedLru(pageAnnotationsCache, pageIndex);
      if (cached) return cached;
      const promise = (async (): Promise<PdfPageAnnotations> => {
        const page = await pdf.getPage(pageIndex + 1);
        const viewport = page.getViewport({ scale: 1 });
        const pageBox = { left: 0, top: 0, width: viewport.width, height: viewport.height };
        const rawList = (await page.getAnnotations({ intent: 'display' })) as readonly Record<
          string,
          unknown
        >[];
        const links: PdfInternalLink[] = [];
        const embeddedAnnotations: PdfEmbeddedAnnotation[] = [];
        const unsupportedSet = new Set<string>();

        const normalizePdfRect = (rawRect: unknown): NormalizedRect | null => {
          if (!Array.isArray(rawRect) || rawRect.length < 4) return null;
          const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(
            Number(rawRect[0]) || 0,
            Number(rawRect[1]) || 0,
          );
          const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(
            Number(rawRect[2]) || 0,
            Number(rawRect[3]) || 0,
          );
          const left = Math.min(x1, x2);
          const top = Math.min(y1, y2);
          const width = Math.max(Math.abs(x2 - x1), 2);
          const height = Math.max(Math.abs(y2 - y1), 2);
          const [rect] = normalizeBoxes([{ left, top, width, height }], pageBox);
          return rect ?? null;
        };

        for (let index = 0; index < rawList.length; index += 1) {
          const raw = rawList[index];
          if (!raw) continue;
          const subtype = typeof raw.subtype === 'string' ? raw.subtype : '';
          if (!subtype || subtype === 'Popup') continue;
          const id =
            typeof raw.id === 'string' && raw.id ? raw.id : `pdf-annot-${pageIndex}-${index}`;

          if (subtype === 'Link') {
            const rect = normalizePdfRect(raw.rect);
            if (!rect) continue;
            const targetPageIndex = await resolveDestPageIndex(pdf, raw.dest);
            if (targetPageIndex !== null) {
              const titleObj = raw.contentsObj as { str?: string } | undefined;
              const title = (
                titleObj?.str ?? (typeof raw.contents === 'string' ? raw.contents : '')
              ).trim();
              links.push({
                id,
                rect,
                targetPageIndex,
                ...(title ? { title } : {}),
              });
            }
            continue;
          }

          if (SUPPORTED_EMBEDDED_SUBTYPES.has(subtype as PdfSupportedEmbeddedSubtype)) {
            const rects: NormalizedRect[] = [];
            const quadPoints = raw.quadPoints;
            if (
              (Array.isArray(quadPoints) || ArrayBuffer.isView(quadPoints)) &&
              'length' in (quadPoints as { length: number }) &&
              (quadPoints as { length: number }).length >= 8
            ) {
              const coords = Array.from(quadPoints as ArrayLike<number>);
              for (let offset = 0; offset + 7 < coords.length; offset += 8) {
                const points: [number, number][] = [
                  viewport.convertToViewportPoint(coords[offset] ?? 0, coords[offset + 1] ?? 0) as [
                    number,
                    number,
                  ],
                  viewport.convertToViewportPoint(
                    coords[offset + 2] ?? 0,
                    coords[offset + 3] ?? 0,
                  ) as [number, number],
                  viewport.convertToViewportPoint(
                    coords[offset + 4] ?? 0,
                    coords[offset + 5] ?? 0,
                  ) as [number, number],
                  viewport.convertToViewportPoint(
                    coords[offset + 6] ?? 0,
                    coords[offset + 7] ?? 0,
                  ) as [number, number],
                ];
                const xs = points.map((p) => p[0]);
                const ys = points.map((p) => p[1]);
                const left = Math.min(...xs);
                const top = Math.min(...ys);
                const width = Math.max(Math.max(...xs) - left, 2);
                const height = Math.max(Math.max(...ys) - top, 2);
                const [normalized] = normalizeBoxes([{ left, top, width, height }], pageBox);
                if (normalized) rects.push(normalized);
              }
            }
            if (rects.length === 0) {
              const fallbackRect = normalizePdfRect(raw.rect);
              if (fallbackRect) rects.push(fallbackRect);
            }
            if (rects.length === 0) continue;

            const contentsObj = raw.contentsObj as { str?: string } | undefined;
            const contents = (
              contentsObj?.str ?? (typeof raw.contents === 'string' ? raw.contents : '')
            ).trim();
            const titleObj = raw.titleObj as { str?: string } | undefined;
            const author = (
              titleObj?.str ?? (typeof raw.title === 'string' ? raw.title : '')
            ).trim();

            embeddedAnnotations.push({
              id,
              subtype: subtype as PdfSupportedEmbeddedSubtype,
              rects,
              contents,
              ...(author ? { author } : {}),
              color: toHexColor(raw.color),
            });
            continue;
          }

          unsupportedSet.add(subtype);
        }

        return {
          links,
          embeddedAnnotations,
          unsupportedSubtypes: [...unsupportedSet].sort(),
        };
      })();
      setBoundedLru(pageAnnotationsCache, pageIndex, promise, MAX_CACHED_ANNOTATION_PAGES);
      return promise;
    },

    pageSize(pageIndex) {
      const cached = pageSizeCache.get(pageIndex);
      if (cached) return cached;
      const promise = pdf.getPage(pageIndex + 1).then((page) => {
        const { width, height } = page.getViewport({ scale: 1 });
        return { width, height };
      });
      pageSizeCache.set(pageIndex, promise);
      return promise;
    },

    renderPage(pageIndex, canvas, scale, rotation = 0) {
      return cancellableOnPage(pdf, pageIndex, (page) => {
        // Sharp on high-density displays, while layout stays in CSS pixels.
        const pixelRatio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({
          scale: scale * pixelRatio,
          rotation: (page.rotate + rotation) % 360,
        });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        return page.render({ canvas, viewport });
      });
    },

    renderTextLayer(pageIndex, container, scale, rotation = 0) {
      return cancellableOnPage(pdf, pageIndex, (page) => {
        container.replaceChildren();
        const layer = new TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container,
          viewport: page.getViewport({
            scale,
            rotation: (page.rotate + rotation) % 360,
          }),
        });
        const promise = layer.render().then(() => {
          // Dragging past the last run would otherwise select the whole page.
          const end = container.ownerDocument.createElement('div');
          end.className = 'endOfContent';
          container.append(end);
        });
        return { promise, cancel: () => layer.cancel() };
      });
    },

    destroy() {
      pageTextCache.clear();
      pageAnnotationsCache.clear();
      pageSizeCache.clear();
      void task.destroy();
      worker.destroy();
    },
  };
}

/** A region of a rendered page as base64 PNG, ready for `excerptImagePng`. */
export function cropCanvasToPng(canvas: HTMLCanvasElement, rect: NormalizedRect): string {
  const region = canvasRegion(rect, canvas);
  const crop = canvas.ownerDocument.createElement('canvas');
  crop.width = region.width;
  crop.height = region.height;
  crop
    .getContext('2d')
    ?.drawImage(
      canvas,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      crop.width,
      crop.height,
    );
  const png = crop.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  crop.width = 0;
  crop.height = 0;
  return png;
}
