import { documentFormatLabel } from '@/lib/documentFormats';
import type { StudyDocument } from '@/types/domain';

const PLACEHOLDER_TITLES = new Set([
  'untitled',
  'untitled-1',
  'untitled document',
  'unknown',
  'title',
  'document',
  'document1',
  'none',
  'null',
]);

const OFFICE_APP_PREFIX_RE = /^microsoft (?:word|powerpoint|excel) - /i;
const FILE_EXTENSION_TITLE_RE = /\.(?:doc|docx|pdf|txt|epub|tex|dvi|indd|pages|rtf|odt|ps|qxd)$/i;
const HAS_LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

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

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]/).filter((segment) => segment.length > 0);
}

/** Human-facing document name: persisted metadata display title, or the file stem. */
export function documentDisplayName(
  document: Pick<StudyDocument, 'title' | 'displayTitle'>,
): string {
  const display = document.displayTitle?.trim();
  return display && display.length > 0 ? display : document.title;
}

/** Final file name (with extension) of `filePath`, handling both `/` and `\`. */
export function fileNameOf(filePath: string): string {
  return pathSegments(filePath).at(-1) ?? filePath;
}

/** Immediate parent folder name of `filePath`, or empty string when none exists. */
export function parentFolderOf(filePath: string): string {
  const segments = pathSegments(filePath);
  return segments.length >= 2 ? (segments.at(-2) ?? '') : '';
}

/** Hover/focus tooltip showing the full display title and file name. */
export function documentTooltip(
  document: Pick<StudyDocument, 'title' | 'displayTitle' | 'filePath'>,
): string {
  const displayName = documentDisplayName(document);
  const fileName = fileNameOf(document.filePath);
  if (fileName && displayName !== fileName) {
    return `${displayName}\n${fileName}`;
  }
  return fileName || displayName;
}

/**
 * Cleans embedded metadata titles (EPUB `dc:title`, PDF `Info.Title` / XMP
 * `dc:title`) and rejects empty strings or common generator placeholders.
 */
export function normalizeMetadataTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Collapse whitespace before stripping control characters so `\n` / `\t` stay word separators.
  const stripped = Array.from(raw.replace(/\s+/g, ' '))
    .filter((ch) => !isControlOrBidiChar(ch))
    .join('');
  const cleaned = stripped.replace(/\s+/g, ' ').trim();
  if (!cleaned || !HAS_LETTER_OR_DIGIT_RE.test(cleaned)) return null;
  const lower = cleaned.toLowerCase();
  if (PLACEHOLDER_TITLES.has(lower)) return null;
  if (OFFICE_APP_PREFIX_RE.test(cleaned)) return null;
  if (FILE_EXTENSION_TITLE_RE.test(cleaned)) return null;
  return cleaned;
}

/** Maximum length (Unicode code points) for a qualifier suffix shown alongside the truncated title. */
export const MAX_QUALIFIER_CHARS = 12;

export interface TabLabel {
  /** Human-facing title (truncatable when a tab narrows). */
  base: string;
  /** Disambiguating qualifier(s) and/or fallback ordinal without leading separator. */
  suffix: string;
  /** Suffix text rendered in a non-shrinking span alongside `base`. */
  suffixDisplay: string;
  /** Full accessible label (`aria-label`). */
  text: string;
}

/**
 * Computes unique tab labels across `docs` so no two open tabs show the same
 * text, adding format, short file name, short parent folder, and finally
 * `(2)`/`(3)` only where labels still collide.
 */
export function documentTabLabels(docs: readonly StudyDocument[]): Map<string, TabLabel> {
  const entries = docs.map((doc) => {
    const base = documentDisplayName(doc);
    return { doc, parts: [base] };
  });

  const qualifiers: Array<(doc: StudyDocument) => string> = [
    (doc) => documentFormatLabel(doc),
    (doc) => fileNameOf(doc.filePath),
    (doc) => parentFolderOf(doc.filePath),
  ];

  const currentLabel = (parts: readonly string[]) => parts.join(' · ');

  const collisionGroups = () => {
    const groups = new Map<string, number[]>();
    entries.forEach((entry, index) => {
      const key = currentLabel(entry.parts).toLowerCase();
      const bucket = groups.get(key);
      if (bucket) bucket.push(index);
      else groups.set(key, [index]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  };

  for (const getQualifier of qualifiers) {
    const groups = collisionGroups();
    if (groups.length === 0) break;
    for (const group of groups) {
      const candidateValues = group.map((index) => {
        const raw = getQualifier(entries[index]!.doc).trim();
        return Array.from(raw).length <= MAX_QUALIFIER_CHARS ? raw : '';
      });
      const nonEmptyValues = candidateValues.filter((value) => value.length > 0);
      if (nonEmptyValues.length === 0) continue;
      const distinctValues = new Set(nonEmptyValues.map((value) => value.toLowerCase()));
      // Skip if every member in the group shares the same qualifier (would not disambiguate).
      if (distinctValues.size <= 1 && nonEmptyValues.length === group.length) continue;

      group.forEach((entryIndex, memberIndex) => {
        const value = candidateValues[memberIndex] ?? '';
        if (!value) return;
        const entry = entries[entryIndex]!;
        const alreadyPresent = entry.parts.some(
          (part) => part.toLowerCase() === value.toLowerCase(),
        );
        if (!alreadyPresent) {
          entry.parts.push(value);
        }
      });
    }
  }

  // Fallback for any remaining collisions: pre-seed `used` with all base/qualified labels
  // so generated `(2)`/`(3)` suffixes never collide with an existing document's title.
  const baseLabels = entries.map((entry) => currentLabel(entry.parts));
  const used = new Set<string>(baseLabels.map((label) => label.toLowerCase()));
  const finalGroups = new Map<string, number[]>();
  baseLabels.forEach((label, index) => {
    const key = label.toLowerCase();
    const bucket = finalGroups.get(key);
    if (bucket) bucket.push(index);
    else finalGroups.set(key, [index]);
  });

  const ordinals = new Array<number | null>(entries.length).fill(null);
  for (const group of finalGroups.values()) {
    if (group.length === 1) continue;
    let ordinal = 2;
    for (const index of group.slice(1)) {
      const base = baseLabels[index]!;
      while (used.has(`${base} (${ordinal})`.toLowerCase())) {
        ordinal += 1;
      }
      ordinals[index] = ordinal;
      used.add(`${base} (${ordinal})`.toLowerCase());
      ordinal += 1;
    }
  }

  const result = new Map<string, TabLabel>();
  entries.forEach((entry, index) => {
    const base = entry.parts[0]!;
    const qualifier = entry.parts.slice(1).join(' · ');
    const ordinal = ordinals[index] ?? null;
    const ordinalSuffix = ordinal === null ? '' : `(${ordinal})`;
    const suffix =
      qualifier && ordinalSuffix ? `${qualifier} ${ordinalSuffix}` : qualifier || ordinalSuffix;
    const suffixDisplay = qualifier ? `· ${suffix}` : ordinalSuffix;
    const text = qualifier
      ? ordinalSuffix
        ? `${base} · ${qualifier} ${ordinalSuffix}`
        : `${base} · ${qualifier}`
      : ordinalSuffix
        ? `${base} ${ordinalSuffix}`
        : base;
    result.set(entry.doc.id, {
      base,
      suffix,
      suffixDisplay,
      text,
    });
  });
  return result;
}
