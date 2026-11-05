import { useEffect } from 'react';

import type { DocumentViewerProps } from '@/types/domain';

/**
 * For a format with no engine yet. Markdown is reserved for V1.1. A jump must
 * still complete, or the store would hold it open forever.
 */
export function UnsupportedFormatViewer({
  document,
  jumpRequest,
  onJumpHandled,
}: DocumentViewerProps<'md'>) {
  const nonce = jumpRequest?.nonce ?? null;
  useEffect(() => {
    if (nonce !== null) onJumpHandled(nonce);
  }, [nonce, onJumpHandled]);

  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div>
        <h2 className="text-lg font-semibold">{document.title}</h2>
        <p className="text-sm text-muted-foreground">Markdown support arrives in V1.1.</p>
      </div>
    </div>
  );
}
