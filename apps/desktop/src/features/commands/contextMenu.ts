import { useEffect } from 'react';

import { isEditableShortcutTarget } from '@/features/commands/registry';

/**
 * Whether the webview's own context menu belongs here. A text field keeps it: Cut,
 * Copy, Paste, and spelling are the browser's. Everywhere else it is Edge WebView2's
 * browser menu (`Back`, `Reload`, `Save as…`, `Print…`), which acts on the document
 * the app is showing rather than on anything the reader can see (#84).
 */
export function keepsNativeContextMenu(target: EventTarget | null): boolean {
  return isEditableShortcutTarget(target);
}

/**
 * Hides the webview's default context menu outside text fields. Returns the
 * cleanup, so a caller can stop listening again.
 */
export function suppressDefaultContextMenu(): () => void {
  const onContextMenu = (event: MouseEvent) => {
    if (keepsNativeContextMenu(event.target)) return;
    event.preventDefault();
  };
  window.addEventListener('contextmenu', onContextMenu);
  return () => window.removeEventListener('contextmenu', onContextMenu);
}

/**
 * Installs the guard while the app runs as the desktop shell. The browser preview
 * (`pnpm dev:web`) keeps its context menu, which is a development tool there, and
 * WebView2's devtools stay reachable with F12 in a debug build.
 */
export function useDefaultContextMenuGuard(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    return suppressDefaultContextMenu();
  }, [enabled]);
}
