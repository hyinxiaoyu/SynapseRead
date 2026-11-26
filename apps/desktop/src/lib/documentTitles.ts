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

/** Maximum display width (in narrow-character units) for the visible suffix next to a truncated title. */
export const MAX_VISIBLE_SUFFIX_WIDTH = 12;

export interface TabLabel {
  /** Human-facing title (truncatable when a tab narrows). */
  base: string;
  /** Compact disambiguating qualifier and/or short ordinal without leading separator. */
  suffix: string;
  /** Compact suffix text rendered in a non-shrinking span alongside `base`. */
  suffixDisplay: string;
  /** Full accessible label (`aria-label`) preserving complete disambiguating context. */
  text: string;
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3040 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Display width in narrow-character units (wide CJK, fullwidth, and emoji glyphs count as 2). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

function formatSuffix(
  qualifiers: readonly string[],
  ordinal: number | null,
): { suffix: string; suffixDisplay: string } {
  const qualifier = qualifiers.join(' · ');
  const ordinalSuffix = ordinal === null ? '' : `(${ordinal})`;
  const suffix =
    qualifier && ordinalSuffix ? `${qualifier} ${ordinalSuffix}` : qualifier || ordinalSuffix;
  const suffixDisplay = qualifier ? `· ${suffix}` : ordinalSuffix;
  return { suffix, suffixDisplay };
}

function formatFullLabel(
  base: string,
  qualifiers: readonly string[],
  ordinal: number | null,
): string {
  const { suffixDisplay } = formatSuffix(qualifiers, ordinal);
  return suffixDisplay ? `${base} ${suffixDisplay}` : base;
}

function findCollisionGroups(labels: readonly string[]): number[][] {
  const groups = new Map<string, number[]>();
  labels.forEach((label, index) => {
    const key = label.toLowerCase();
    const bucket = groups.get(key);
    if (bucket) bucket.push(index);
    else groups.set(key, [index]);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

function assignOrdinals(baseLabels: readonly string[]): Array<number | null> {
  // Pre-seed `used` with all base/qualified labels so generated `(2)`/`(3)` suffixes
  // never collide with an existing document's title.
  const used = new Set<string>(baseLabels.map((label) => label.toLowerCase()));
  const ordinals = new Array<number | null>(baseLabels.length).fill(null);
  for (const group of findCollisionGroups(baseLabels)) {
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
  return ordinals;
}

/**
 * Computes unique tab labels across `docs` so `text` (`aria-label`) carries full
 * disambiguation (format, file name, parent folder, ordinal) while the visible
 * `suffixDisplay` stays within `MAX_VISIBLE_SUFFIX_WIDTH`, trading overflowing
 * qualifiers for short group-unique ordinals so titles and Close buttons fit.
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

  // Layer 1: full qualifiers + ordinals for complete accessible `aria-label` (`text`).
  for (const getQualifier of qualifiers) {
    const groups = findCollisionGroups(entries.map((entry) => entry.parts.join(' · ')));
    if (groups.length === 0) break;
    for (const group of groups) {
      const candidateValues = group.map((index) => getQualifier(entries[index]!.doc).trim());
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

  const fullBaseLabels = entries.map((entry) => entry.parts.join(' · '));
  const fullOrdinals = assignOrdinals(fullBaseLabels);

  // Layer 2: trim visible trailing qualifiers to stay within `MAX_VISIBLE_SUFFIX_WIDTH`,
  // falling back to group-unique ordinals whenever trimming or `(2)` causes an overflow.
  const visibleQualifiers = entries.map((entry) => {
    const quals = entry.parts.slice(1);
    while (
      quals.length > 0 &&
      displayWidth(formatSuffix(quals, null).suffixDisplay) > MAX_VISIBLE_SUFFIX_WIDTH
    ) {
      quals.pop();
    }
    return quals;
  });

  let visibleOrdinals = new Array<number | null>(entries.length).fill(null);
  for (;;) {
    const visibleBaseLabels = entries.map((entry, index) =>
      formatFullLabel(entry.parts[0]!, visibleQualifiers[index]!, null),
    );
    visibleOrdinals = assignOrdinals(visibleBaseLabels);

    let trimmedAny = false;
    for (const group of findCollisionGroups(visibleBaseLabels)) {
      const groupOverflowed = group.some((index) => {
        const quals = visibleQualifiers[index]!;
        const ordinal = visibleOrdinals[index] ?? null;
        return (
          quals.length > 0 &&
          displayWidth(formatSuffix(quals, ordinal).suffixDisplay) > MAX_VISIBLE_SUFFIX_WIDTH
        );
      });
      if (!groupOverflowed) continue;
      for (const index of group) {
        const quals = visibleQualifiers[index]!;
        if (quals.length > 0) {
          quals.pop();
          trimmedAny = true;
        }
      }
    }
    if (!trimmedAny) break;
  }

  const result = new Map<string, TabLabel>();
  entries.forEach((entry, index) => {
    const base = entry.parts[0]!;
    const fullQualifiers = entry.parts.slice(1);
    const fullOrdinal = fullOrdinals[index] ?? null;
    const { suffix, suffixDisplay } = formatSuffix(
      visibleQualifiers[index]!,
      visibleOrdinals[index] ?? null,
    );
    result.set(entry.doc.id, {
      base,
      suffix,
      suffixDisplay,
      text: formatFullLabel(base, fullQualifiers, fullOrdinal),
    });
  });
  return result;
}
