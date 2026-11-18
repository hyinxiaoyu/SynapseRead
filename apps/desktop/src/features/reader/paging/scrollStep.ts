import type { TurnDirection } from './pageTurn';

const DEFAULT_LINE_HEIGHT_PX = 24;
const OVERSIZED_BLOCK_RATIO = 0.8;
const BOUNDARY_SNAP_PX = 2;
const BOUNDARY_TOLERANCE_PX = 1;
const MIN_TEXT_LINE_PX = 6;
const MAX_TEXT_LINE_PX = 120;
const MAX_IFRAME_DEPTH = 8;

/** Minimal scroller surface needed to compute an explicit scroll page step. */
export interface ScrollViewport {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  ownerDocument?: Document | null | undefined;
  getBoundingClientRect?: () => { top: number; bottom?: number };
}

/** A text line box in scroller-viewport coordinates (`0` = top of viewport). */
export interface ScrollLineRect {
  top: number;
  bottom: number;
  height?: number | undefined;
}

export interface ComputeScrollPageStepOptions {
  scroller: ScrollViewport | null | undefined;
  contentRoot?: Element | null | undefined;
  direction: TurnDirection;
  /** Optional viewport-relative line rects, bypassing DOM inspection for deterministic tests. */
  lineRects?: readonly ScrollLineRect[] | undefined;
  lineHeightPx?: number | undefined;
}

interface NormalizedLineRect {
  top: number;
  bottom: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parentElementOf(node: Node): Element | null {
  const parent = node.parentElement ?? node.parentNode;
  return parent && parent.nodeType === 1 ? (parent as Element) : null;
}

function isExcludedSelf(element: Element, extraSelector?: string): boolean {
  const tag = element.localName?.toLowerCase() ?? '';
  if (
    tag === 'script' ||
    tag === 'style' ||
    tag === 'noscript' ||
    tag === 'template' ||
    tag === 'title'
  ) {
    return true;
  }
  if (element.hasAttribute?.('hidden') || element.hasAttribute?.('inert')) {
    return true;
  }
  if (element.classList?.contains('sr-only')) {
    return true;
  }
  return Boolean(extraSelector && element.matches?.(extraSelector));
}

function isOutsideViewportCullBounds(
  element: Element,
  viewportOriginTop: number,
  viewportHeight: number,
): boolean {
  if (viewportHeight <= 0 || typeof element.getBoundingClientRect !== 'function') return false;
  const rect = element.getBoundingClientRect();
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.height <= 0) {
    return false;
  }
  const relTop = rect.top - viewportOriginTop;
  const relBottom = rect.bottom - viewportOriginTop;
  // Keep a one-viewport buffer above and below so straddling lines and median line-height
  // estimation never miss nearby content while skipping far-off chapter subtrees.
  // Culling uses the element's own box, assuming flowing EPUB prose and PDF `.textLayer`
  // containers enclose their descendants vertically (fixed-height overflowing or out-of-flow
  // positioned descendants outside the parent box are not expected here).
  return relBottom < -viewportHeight || relTop > viewportHeight * 2;
}

function frameTopOffset(contentDoc: Document, scrollerDoc: Document | null): number {
  if (scrollerDoc && contentDoc === scrollerDoc) return 0;
  let offset = 0;
  let currentDoc: Document | null = contentDoc;
  let depth = 0;
  while (currentDoc && currentDoc !== scrollerDoc && depth < MAX_IFRAME_DEPTH) {
    const frame = currentDoc.defaultView?.frameElement as Element | null | undefined;
    if (!frame || frame.nodeType !== 1) break;
    const frameRect = frame.getBoundingClientRect();
    const clientTop = (frame as Partial<HTMLElement>).clientTop ?? 0;
    offset += frameRect.top + clientTop;
    currentDoc = frame.ownerDocument ?? null;
    depth += 1;
  }
  return offset;
}

function pushValidRect(
  out: NormalizedLineRect[],
  top: number,
  bottom: number,
  explicitHeight?: number,
): void {
  const height = explicitHeight ?? bottom - top;
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || !Number.isFinite(height)) return;
  if (height <= 0) return;
  out.push({ top, bottom, height });
}

function collectTextNodeRects(
  root: Element,
  viewportOriginTop: number,
  viewportHeight: number,
  rangeCache: WeakMap<Document, Range>,
  out: NormalizedLineRect[],
  options: { extraExcludeSelector?: string; allowParentRectFallback: boolean },
): void {
  if (isExcludedSelf(root, options.extraExcludeSelector)) return;
  const doc = root.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== 'function') return;
  const showElement = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_ELEMENT : 1;
  const showText = typeof NodeFilter !== 'undefined' ? NodeFilter.SHOW_TEXT : 4;
  const filterAccept = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_ACCEPT : 1;
  const filterReject = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_REJECT : 2;
  const filterSkip = typeof NodeFilter !== 'undefined' ? NodeFilter.FILTER_SKIP : 3;

  const walker = doc.createTreeWalker(root, showElement | showText, {
    acceptNode(node) {
      if (node.nodeType === 1) {
        const el = node as Element;
        if (isExcludedSelf(el, options.extraExcludeSelector)) return filterReject;
        if (el !== root && isOutsideViewportCullBounds(el, viewportOriginTop, viewportHeight)) {
          return filterReject;
        }
        return filterSkip;
      }
      if (node.nodeType === 3) {
        const value = node.nodeValue;
        return value && value.trim().length > 0 ? filterAccept : filterSkip;
      }
      return filterSkip;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const parent = parentElementOf(node);
    if (parent) {
      const nodeDoc = node.ownerDocument ?? doc;
      let collectedFromRange = false;
      if (typeof nodeDoc.createRange === 'function') {
        let range = rangeCache.get(nodeDoc);
        if (!range) {
          range = nodeDoc.createRange();
          rangeCache.set(nodeDoc, range);
        }
        range.selectNodeContents(node);
        if (typeof range.getClientRects === 'function') {
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && rect.height > 0) {
              collectedFromRange = true;
              pushValidRect(
                out,
                rect.top - viewportOriginTop,
                rect.bottom - viewportOriginTop,
                rect.height,
              );
            }
          }
        }
      }
      if (
        !collectedFromRange &&
        options.allowParentRectFallback &&
        typeof parent.getBoundingClientRect === 'function'
      ) {
        const rect = parent.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          pushValidRect(
            out,
            rect.top - viewportOriginTop,
            rect.bottom - viewportOriginTop,
            rect.height,
          );
        }
      }
    }
    node = walker.nextNode();
  }
}

function collectDomLineRects(scroller: ScrollViewport, contentRoot: Element): NormalizedLineRect[] {
  const scrollerTop =
    typeof scroller.getBoundingClientRect === 'function' ? scroller.getBoundingClientRect().top : 0;
  const viewportHeight = scroller.clientHeight;
  const scrollerDoc = scroller.ownerDocument ?? null;
  const rangeCache = new WeakMap<Document, Range>();
  const out: NormalizedLineRect[] = [];
  const visited = new Set<Element>();

  const inspectRoot = (root: Element) => {
    if (visited.has(root)) return;
    visited.add(root);
    const rootDoc = root.ownerDocument;
    if (!rootDoc) return;
    const viewportOriginTop = scrollerTop - frameTopOffset(rootDoc, scrollerDoc);

    const isTextLayer = root.classList?.contains('textLayer') ?? false;
    const textLayers = isTextLayer
      ? [root]
      : typeof root.querySelectorAll === 'function'
        ? Array.from(root.querySelectorAll('.textLayer'))
        : [];

    if (textLayers.length > 0) {
      for (const layer of textLayers) {
        if (isOutsideViewportCullBounds(layer, viewportOriginTop, viewportHeight)) continue;
        collectTextNodeRects(layer, viewportOriginTop, viewportHeight, rangeCache, out, {
          extraExcludeSelector: '.endOfContent',
          allowParentRectFallback: true,
        });
      }
      return;
    }

    collectTextNodeRects(root, viewportOriginTop, viewportHeight, rangeCache, out, {
      allowParentRectFallback: false,
    });

    if (typeof root.querySelectorAll === 'function') {
      for (const frame of root.querySelectorAll('iframe')) {
        if (isOutsideViewportCullBounds(frame, scrollerTop, viewportHeight)) continue;
        try {
          const frameBody = (frame as HTMLIFrameElement).contentDocument?.body;
          if (frameBody) inspectRoot(frameBody);
        } catch {
          // Cross-origin frame access is safely ignored.
        }
      }
    }
  };

  inspectRoot(contentRoot);
  return out;
}

function resolveLineHeight(
  explicit: number | undefined,
  rects: readonly NormalizedLineRect[],
  contentRoot: Element | null | undefined,
): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const typicalHeights = rects
    .map((rect) => rect.height)
    .filter((height) => height >= MIN_TEXT_LINE_PX && height <= MAX_TEXT_LINE_PX)
    .sort((a, b) => a - b);
  if (typicalHeights.length > 0) {
    const middle = typicalHeights[Math.floor(typicalHeights.length / 2)];
    if (middle !== undefined) return middle;
  }
  const computed = contentRoot?.ownerDocument?.defaultView?.getComputedStyle?.(contentRoot);
  if (computed?.lineHeight.endsWith('px')) {
    const parsed = Number.parseFloat(computed.lineHeight);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LINE_HEIGHT_PX;
}

function pickForwardAnchor(
  rects: readonly NormalizedLineRect[],
  viewportHeight: number,
  fallbackOverlap: number,
): NormalizedLineRect | null {
  const edge = viewportHeight - BOUNDARY_TOLERANCE_PX;
  const maxOversized = viewportHeight * OVERSIZED_BLOCK_RATIO;

  let bestStraddling: NormalizedLineRect | null = null;
  let bestOversizedStraddling: NormalizedLineRect | null = null;
  for (const rect of rects) {
    if (rect.top < edge && rect.bottom > edge) {
      if (rect.height < maxOversized) {
        if (
          !bestStraddling ||
          rect.top < bestStraddling.top ||
          (rect.top === bestStraddling.top && rect.bottom < bestStraddling.bottom)
        ) {
          bestStraddling = rect;
        }
      } else if (
        !bestOversizedStraddling ||
        rect.top < bestOversizedStraddling.top ||
        (rect.top === bestOversizedStraddling.top && rect.bottom < bestOversizedStraddling.bottom)
      ) {
        bestOversizedStraddling = rect;
      }
    }
  }
  if (bestStraddling) return bestStraddling;
  if (bestOversizedStraddling) return bestOversizedStraddling;

  const bandStart = viewportHeight - fallbackOverlap;
  let bestClean: NormalizedLineRect | null = null;
  for (const rect of rects) {
    if (
      rect.height < maxOversized &&
      rect.top >= BOUNDARY_TOLERANCE_PX &&
      rect.bottom <= edge &&
      rect.bottom >= bandStart
    ) {
      if (
        !bestClean ||
        rect.bottom > bestClean.bottom ||
        (rect.bottom === bestClean.bottom && rect.top > bestClean.top)
      ) {
        bestClean = rect;
      }
    }
  }
  return bestClean;
}

function pickBackwardAnchor(
  rects: readonly NormalizedLineRect[],
  viewportHeight: number,
  fallbackOverlap: number,
): NormalizedLineRect | null {
  const topEdge = BOUNDARY_TOLERANCE_PX;
  const bottomEdge = viewportHeight - BOUNDARY_TOLERANCE_PX;
  const maxOversized = viewportHeight * OVERSIZED_BLOCK_RATIO;

  let bestStraddling: NormalizedLineRect | null = null;
  let bestOversizedStraddling: NormalizedLineRect | null = null;
  for (const rect of rects) {
    if (rect.top < topEdge && rect.bottom > topEdge) {
      if (rect.height < maxOversized) {
        if (
          !bestStraddling ||
          rect.bottom > bestStraddling.bottom ||
          (rect.bottom === bestStraddling.bottom && rect.top > bestStraddling.top)
        ) {
          bestStraddling = rect;
        }
      } else if (
        !bestOversizedStraddling ||
        rect.bottom > bestOversizedStraddling.bottom ||
        (rect.bottom === bestOversizedStraddling.bottom && rect.top > bestOversizedStraddling.top)
      ) {
        bestOversizedStraddling = rect;
      }
    }
  }
  if (bestStraddling) return bestStraddling;
  if (bestOversizedStraddling) return bestOversizedStraddling;

  let bestClean: NormalizedLineRect | null = null;
  for (const rect of rects) {
    if (
      rect.height < maxOversized &&
      rect.top >= topEdge &&
      rect.top <= fallbackOverlap &&
      rect.bottom <= bottomEdge
    ) {
      if (
        !bestClean ||
        rect.top < bestClean.top ||
        (rect.top === bestClean.top && rect.bottom < bestClean.bottom)
      ) {
        bestClean = rect;
      }
    }
  }
  return bestClean;
}

/**
 * Computes the next `scrollTop` for an explicit page turn in a continuous-scrolling
 * reader (TXT, EPUB scroll, PDF continuous), keeping partially obscured edge lines
 * wholly visible after the turn with reading-continuity breathing room.
 *
 * Returns `null` when already at the boundary in `direction` or when the container
 * cannot scroll.
 */
export function computeScrollPageStep({
  scroller,
  contentRoot,
  direction,
  lineRects,
  lineHeightPx,
}: ComputeScrollPageStepOptions): number | null {
  if (!scroller) return null;
  const { scrollTop, clientHeight: viewportHeight, scrollHeight } = scroller;
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(scrollHeight)
  ) {
    return null;
  }
  if (viewportHeight <= 0 || scrollHeight <= viewportHeight + BOUNDARY_TOLERANCE_PX) {
    return null;
  }
  if (direction < 0 && scrollTop <= BOUNDARY_TOLERANCE_PX) return null;
  if (direction > 0 && scrollTop + viewportHeight >= scrollHeight - BOUNDARY_TOLERANCE_PX) {
    return null;
  }

  let rects: NormalizedLineRect[];
  if (lineRects !== undefined) {
    rects = [];
    for (const rect of lineRects) {
      pushValidRect(rects, rect.top, rect.bottom, rect.height);
    }
  } else if (contentRoot) {
    rects = collectDomLineRects(scroller, contentRoot);
  } else {
    rects = [];
  }

  const linePx = resolveLineHeight(lineHeightPx, rects, contentRoot);
  const minStep = Math.min(
    Math.max(Math.round(viewportHeight * 0.25), 24),
    Math.max(Math.floor(viewportHeight * 0.5), 1),
  );
  const contextPad = Math.min(
    Math.max(Math.round(linePx), 8),
    24,
    Math.max(Math.floor(viewportHeight * 0.15), 1),
  );
  const minOverlap = Math.min(Math.max(contextPad, 16), Math.floor(viewportHeight * 0.25));
  const maxStep = Math.max(minStep, viewportHeight - minOverlap);
  const fallbackOverlap = Math.min(
    Math.max(Math.round(viewportHeight * 0.12), Math.round(linePx * 1.5), 32),
    Math.floor(viewportHeight * 0.35),
  );
  const fallbackStep = clamp(viewportHeight - fallbackOverlap, minStep, viewportHeight);
  const maxOversized = viewportHeight * OVERSIZED_BLOCK_RATIO;

  if (direction > 0) {
    const anchor = pickForwardAnchor(rects, viewportHeight, fallbackOverlap);
    let step = fallbackStep;
    if (anchor && anchor.height < maxOversized) {
      const candidateStep = anchor.top - contextPad;
      if (candidateStep >= minStep) {
        step = Math.min(candidateStep, maxStep);
      }
    }
    const maxScrollTop = scrollHeight - viewportHeight;
    let nextTop = clamp(scrollTop + step, 0, maxScrollTop);
    if (maxScrollTop - nextTop <= BOUNDARY_SNAP_PX) {
      nextTop = maxScrollTop;
    }
    return nextTop;
  }

  const anchor = pickBackwardAnchor(rects, viewportHeight, fallbackOverlap);
  let step = fallbackStep;
  if (anchor && anchor.height < maxOversized) {
    const candidateStep = viewportHeight - (anchor.bottom + contextPad);
    if (candidateStep >= minStep) {
      step = Math.min(candidateStep, maxStep);
    }
  }
  let nextTop = Math.max(scrollTop - step, 0);
  if (nextTop <= BOUNDARY_SNAP_PX) {
    nextTop = 0;
  }
  return nextTop;
}
