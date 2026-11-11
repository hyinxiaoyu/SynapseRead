import { type RefObject, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * How a toolbar popover or menu (Aa, `»`, Recent, Find's options) puts itself away
 * while `open`: Esc, a press outside `rootRef`, or focus moving into an iframe.
 *
 * Esc is caught in the capture phase, so the popover closes before Find or focus
 * mode see the key. A click into an EPUB chapter fires no `pointerdown` here; it
 * blurs the window instead, and closing then matters: Esc pressed in the frame is
 * forwarded straight to `dispatchEscape`, where an open popover would make focus
 * mode decline and leave nothing to take the key.
 */
export function useDismissOnOutside(
  open: boolean,
  onClose: () => void,
  {
    rootRef,
    stopPropagation = false,
  }: {
    /** Presses inside it keep the popover open. Without it, presses never close it. */
    rootRef?: RefObject<HTMLElement | null>;
    /** Keeps Esc from reaching the focused element, such as Find's own field. */
    stopPropagation?: boolean;
  } = {},
) {
  const latest = useRef(onClose);
  useLayoutEffect(() => {
    latest.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const close = () => latest.current();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (stopPropagation) event.stopPropagation();
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef) return;
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      close();
    };
    const onBlur = () => {
      if (document.activeElement instanceof HTMLIFrameElement) close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, rootRef, stopPropagation]);
}
