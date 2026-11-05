import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AnchorLocation, DocumentFormat, DocumentViewerProps } from '@/types/domain';

const PULSE_MS = 1200;

const AVAILABILITY: Record<DocumentFormat, string> = {
  pdf: 'The PDF engine (pdfjs-dist) arrives in Phase 2.',
  epub: 'The EPUB engine (epubjs) arrives in Phase 2.',
  txt: 'The virtualized TXT engine arrives in Phase 2.',
  md: 'Markdown support is reserved for V1.1.',
};

const SAMPLE_ANCHOR: Record<DocumentFormat, AnchorLocation> = {
  pdf: { format: 'pdf', pageIndex: 0, rects: [{ x: 0.1, y: 0.2, width: 0.6, height: 0.04 }] },
  epub: {
    format: 'epub',
    cfiRange: 'epubcfi(/6/4!/4/2,/1:0,/1:24)',
    chapterHref: 'chapter1.xhtml',
  },
  txt: { format: 'txt', startByteOffset: 0, endByteOffset: 24, lineIndex: 0 },
  md: { format: 'md', astNodeId: 'paragraph-1', offset: 0 },
};

const describeAnchor = (anchor: AnchorLocation) => JSON.stringify(anchor);

/**
 * Stand-in that implements the full `DocumentViewerProps` contract, so the
 * Reader <-> MindMap loop runs end to end before the real engines exist. It
 * emits a sample anchor instead of a real selection and is deleted in Phase 2.
 */
export function EnginePendingViewer({
  document,
  highlights,
  jumpRequest,
  onSelectionChange,
  onJumpHandled,
}: DocumentViewerProps) {
  const [pulsedAnchor, setPulsedAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (!jumpRequest) return;
    const nonce = jumpRequest.nonce;
    const showPulse = window.setTimeout(() => setPulsedAnchor(jumpRequest.annotationId), 0);
    const endPulse = window.setTimeout(() => {
      setPulsedAnchor(null);
      onJumpHandled(nonce);
    }, PULSE_MS);
    return () => {
      window.clearTimeout(showPulse);
      window.clearTimeout(endPulse);
    };
  }, [jumpRequest, onJumpHandled]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-6">
      <div>
        <h2 className="text-lg font-semibold">{document.title}</h2>
        <p className="text-sm text-muted-foreground">{AVAILABILITY[document.format]}</p>
      </div>

      <div className="rounded-lg border border-dashed p-4">
        <p className="mb-3 text-sm text-muted-foreground">
          Until then, send a sample selection through the excerpt pipeline:
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onSelectionChange({
              documentId: document.id,
              anchor: SAMPLE_ANCHOR[document.format],
              text: `Sample excerpt ${highlights.length + 1} from ${document.title}`,
              imagePath: null,
            })
          }
        >
          Simulate selection
        </Button>
      </div>

      {highlights.length > 0 && (
        <section aria-label="Highlights" className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Highlights</h3>
          {highlights.map((highlight) => (
            <p
              key={highlight.annotationId}
              data-annotation-id={highlight.annotationId}
              style={{
                borderColor: highlight.color,
                ['--anchor-pulse-color' as string]: highlight.color,
              }}
              className={cn(
                'rounded border-l-4 bg-muted px-3 py-2 font-mono text-xs break-all',
                pulsedAnchor === highlight.annotationId && 'anchor-pulse',
              )}
            >
              {describeAnchor(highlight.anchor)}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
