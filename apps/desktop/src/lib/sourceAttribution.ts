import { documentDisplayName } from '@/lib/documentTitles';
import type { Annotation, NoteCard, StudyDocument } from '@/types/domain';

/** Must match `LOCATION_LABEL_MAX_CHARS` in `crates/synapse-core/src/db.rs`. */
export const MAX_LOCATION_LABEL_CHARS = 160;

function isControlOrBidiChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    code <= 0x001f ||
    (code >= 0x007f && code <= 0x009f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Strips control/bidi chars and flattens whitespace so embedded newlines never drop a trailing suffix. */
function cleanLocationSegment(raw: string | null | undefined): string {
  if (!raw) return '';
  return Array.from(raw.replace(/\s+/g, ' '))
    .filter((ch) => !isControlOrBidiChar(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateUnicodeChars(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('');
  return `${chars.slice(0, maxChars - 1).join('')}…`;
}

/**
 * Combines an optional chapter/heading prefix with a required page or line suffix within
 * `maxChars` Unicode scalar values, reserving room for the separator and suffix first so
 * persistence never crowds out page numbers, page ranges, or line numbers (#125).
 */
export function formatLocationWithSuffix(
  prefix: string | null | undefined,
  suffix: string,
  maxChars = MAX_LOCATION_LABEL_CHARS,
): string {
  const cleanSuffix = cleanLocationSegment(suffix);
  const cleanPrefix = cleanLocationSegment(prefix);
  if (!cleanPrefix) return truncateUnicodeChars(cleanSuffix, maxChars);
  if (!cleanSuffix) return truncateUnicodeChars(cleanPrefix, maxChars);

  const separator = ' · ';
  const suffixLen = Array.from(cleanSuffix).length;
  const separatorLen = Array.from(separator).length;
  const availableForPrefix = maxChars - separatorLen - suffixLen;
  if (availableForPrefix <= 1) {
    return truncateUnicodeChars(cleanSuffix, maxChars);
  }
  return `${truncateUnicodeChars(cleanPrefix, availableForPrefix)}${separator}${cleanSuffix}`;
}

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
