import {
  getDocument,
  GlobalWorkerOptions,
  PDFWorker,
  TextLayer,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

import type { DocumentSource, NormalizedRect } from '@/types/domain';

import { canvasRegion } from './pdfGeometry';

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
  /** Size in CSS pixels at scale 1, including the page's user unit. */
  pageSize(pageIndex: number): Promise<PageSize>;
  renderPage(pageIndex: number, canvas: HTMLCanvasElement, scale: number): Cancellable;
  renderTextLayer(pageIndex: number, container: HTMLElement, scale: number): Cancellable;
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
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
  const pdf = await task.promise;

  return {
    pageCount: pdf.numPages,
    usesRealWorker,

    async getOutline() {
      const raw = (await pdf.getOutline()) as readonly RawOutlineNode[] | null;
      return raw ? mapPdfOutline(pdf, raw) : [];
    },

    async pageSize(pageIndex) {
      const { width, height } = (await pdf.getPage(pageIndex + 1)).getViewport({ scale: 1 });
      return { width, height };
    },

    renderPage(pageIndex, canvas, scale) {
      return cancellableOnPage(pdf, pageIndex, (page) => {
        // Sharp on high-density displays, while layout stays in CSS pixels.
        const pixelRatio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * pixelRatio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        return page.render({ canvas, viewport });
      });
    },

    renderTextLayer(pageIndex, container, scale) {
      return cancellableOnPage(pdf, pageIndex, (page) => {
        container.replaceChildren();
        const layer = new TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container,
          viewport: page.getViewport({ scale }),
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
  return crop.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}
