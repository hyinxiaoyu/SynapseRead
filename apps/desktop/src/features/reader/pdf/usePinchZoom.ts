import { type RefObject, useCallback, useEffect, useRef } from 'react';

import { clampZoomRatio, type Point, previewStyle, wheelZoomFactor } from './pdfZoom';

/**
 * A ctrl-wheel burst has no end event, so it ends once the wheel has been quiet
 * this long. Shorter, and a slow pinch commits (and redraws) halfway through.
 */
export const WHEEL_ZOOM_IDLE_MS = 160;

/** What a finished pinch hands back: everything is in pixels, before any redraw. */
export interface PinchZoomCommit {
  /** How much the preview scaled the pages. */
  ratio: number;
  /** The point the preview scaled about, in content pixels. */
  origin: Point;
  /** Where the pointer is now, in pixels from the scroller's top left. */
  pointer: Point;
}

/** WebKit's `GestureEvent`, which TypeScript's DOM library does not declare. */
interface GestureEventLike extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface Gesture {
  source: 'wheel' | 'webkit';
  origin: Point;
  pointer: Point;
  ratio: number;
  /** The ratio a WebKit gesture's own `scale` multiplies: a wheel burst may precede it. */
  startRatio: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Pinch and ctrl-wheel zoom, through one code path on every platform (#51).
 *
 * WebKit reports a trackpad pinch as `gesturestart`/`gesturechange`/`gestureend`;
 * Chromium and Firefox report it, and a ctrl-held mouse wheel, as `wheel` with
 * `ctrlKey`. Both feed the same gesture. While it runs only a CSS transform on
 * `contentRef` changes, so nothing re-renders; on release `onCommit` gets the
 * ratio and the caller re-lays out once, then calls `clearPreview` in the same frame.
 *
 * Default handling is cancelled so the webview never zooms the whole app instead.
 */
export function usePinchZoom({
  enabled,
  scrollRef,
  contentRef,
  baseScale,
  onCommit,
}: {
  enabled: boolean;
  scrollRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLElement | null>;
  /** The scale the preview starts from, which bounds how far it may go. */
  baseScale: number;
  /**
   * Re-lays out at the new scale and returns true, or returns false when the scale
   * does not change, and the preview is dropped here.
   */
  onCommit: (commit: PinchZoomCommit) => boolean;
}): { clearPreview: () => void } {
  const latest = useRef({ baseScale, onCommit });
  useEffect(() => {
    latest.current = { baseScale, onCommit };
  });
  const gestureRef = useRef<Gesture | null>(null);

  const clearPreview = useCallback(() => {
    const content = contentRef.current;
    if (!content) return;
    content.style.transform = '';
    content.style.transformOrigin = '';
    content.style.willChange = '';
  }, [contentRef]);

  useEffect(() => {
    const area = scrollRef.current;
    if (!enabled || !area) return;

    const viewportPoint = (clientX: number, clientY: number): Point => {
      const box = area.getBoundingClientRect();
      return { x: clientX - box.left - area.clientLeft, y: clientY - box.top - area.clientTop };
    };

    const begin = (source: Gesture['source'], clientX: number, clientY: number): Gesture => {
      const pointer = viewportPoint(clientX, clientY);
      const gesture: Gesture = {
        source,
        origin: { x: area.scrollLeft + pointer.x, y: area.scrollTop + pointer.y },
        pointer,
        ratio: 1,
        startRatio: 1,
        idleTimer: null,
      };
      gestureRef.current = gesture;
      const content = contentRef.current;
      if (content) content.style.willChange = 'transform';
      return gesture;
    };

    const preview = (gesture: Gesture, ratio: number, clientX: number, clientY: number) => {
      gesture.ratio = clampZoomRatio(latest.current.baseScale, ratio);
      gesture.pointer = viewportPoint(clientX, clientY);
      const content = contentRef.current;
      if (!content) return;
      const style = previewStyle(gesture.origin, gesture.ratio);
      content.style.transformOrigin = style.transformOrigin;
      content.style.transform = style.transform;
    };

    const finish = () => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.idleTimer !== null) clearTimeout(gesture.idleTimer);
      gestureRef.current = null;
      if (Math.abs(gesture.ratio - 1) < 1e-3) {
        clearPreview();
        return;
      }
      const relaid = latest.current.onCommit({
        ratio: gesture.ratio,
        origin: gesture.origin,
        pointer: gesture.pointer,
      });
      if (!relaid) clearPreview();
    };

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const current = gestureRef.current;
      // WebKit may also send ctrl-wheel for the pinch it reports as a gesture.
      if (current?.source === 'webkit') return;
      const gesture = current ?? begin('wheel', event.clientX, event.clientY);
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode, area.clientHeight);
      preview(gesture, gesture.ratio * factor, event.clientX, event.clientY);
      if (gesture.idleTimer !== null) clearTimeout(gesture.idleTimer);
      gesture.idleTimer = setTimeout(finish, WHEEL_ZOOM_IDLE_MS);
    };

    const onGestureStart = (event: Event) => {
      const gestureEvent = event as GestureEventLike;
      event.preventDefault();
      const current = gestureRef.current;
      if (current) {
        // A wheel burst that turns into a gesture continues from where it is.
        if (current.idleTimer !== null) clearTimeout(current.idleTimer);
        current.idleTimer = null;
        current.source = 'webkit';
        current.startRatio = current.ratio;
        return;
      }
      begin('webkit', gestureEvent.clientX, gestureEvent.clientY);
    };

    const onGestureChange = (event: Event) => {
      const gestureEvent = event as GestureEventLike;
      event.preventDefault();
      const gesture = gestureRef.current;
      if (gesture?.source !== 'webkit') return;
      preview(
        gesture,
        gesture.startRatio * gestureEvent.scale,
        gestureEvent.clientX,
        gestureEvent.clientY,
      );
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      if (gestureRef.current?.source === 'webkit') finish();
    };

    area.addEventListener('wheel', onWheel, { passive: false });
    area.addEventListener('gesturestart', onGestureStart, { passive: false });
    area.addEventListener('gesturechange', onGestureChange, { passive: false });
    area.addEventListener('gestureend', onGestureEnd, { passive: false });
    return () => {
      area.removeEventListener('wheel', onWheel);
      area.removeEventListener('gesturestart', onGestureStart);
      area.removeEventListener('gesturechange', onGestureChange);
      area.removeEventListener('gestureend', onGestureEnd);
      // A tab put away mid-pinch drops it rather than committing out of view.
      const gesture = gestureRef.current;
      if (gesture?.idleTimer != null) clearTimeout(gesture.idleTimer);
      gestureRef.current = null;
      clearPreview();
    };
  }, [enabled, scrollRef, contentRef, clearPreview]);

  return { clearPreview };
}
