import { documentDisplayName } from '@/lib/documentTitles';
import type { Annotation, NoteCard, StudyDocument } from '@/types/domain';

/**
 * Formats an annotation's source attribution (document title and optional reader-reported
 * location label) without ever inspecting `AnchorLocation` (#125).
 */
export function formatAnnotationSource(
  annotation: Pick<Annotation, 'documentId' | 'locationLabel'>,
  documents: readonly StudyDocument[],
): string | null {
  const document = documents.find((candidate) => candidate.id === annotation.documentId);
  const documentTitle = document ? documentDisplayName(document).trim() : '';
  const location = annotation.locationLabel?.trim() ?? '';
  if (documentTitle && location) return `${documentTitle} · ${location}`;
  if (documentTitle) return documentTitle;
  if (location) return location;
  return null;
}

/**
 * Formats a card's primary source attribution line for the MindMap face and jump button.
 * Reads the document title live from `documents` so relinks and metadata titles stay current.
 */
export function formatCardSource(
  card: Pick<NoteCard, 'annotationIds'>,
  annotations: readonly Annotation[],
  documents: readonly StudyDocument[],
): string | null {
  if (card.annotationIds.length === 0) return null;
  const linked = card.annotationIds
    .map((id) => annotations.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is Annotation => candidate !== undefined);
  const primary = linked[0];
  if (!primary) return null;
  const primaryLabel = formatAnnotationSource(primary, documents);
  if (!primaryLabel) return null;
  const extraCount = linked.length - 1;
  return extraCount > 0 ? `${primaryLabel} (+${extraCount})` : primaryLabel;
}
