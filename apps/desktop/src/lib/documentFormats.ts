import contract from '../../../../fixtures/contract/document-formats.json';

import type { DocumentFormat, StudyDocument } from '@/types/domain';

/**
 * The file formats the app opens, read from the contract core's picker filter is
 * tested against (`fixtures/contract/document-formats.json`). Every piece of copy
 * that names formats is built from this list, so it cannot drift from the picker
 * again (issue #99).
 */
export interface SupportedFormat {
  /** What the reader calls it: "PDF", "Markdown". */
  label: string;
  /** What files with these extensions register as. Markdown registers as `txt`. */
  format: DocumentFormat;
  extensions: readonly string[];
}

const KNOWN_FORMATS: readonly string[] = ['pdf', 'epub', 'txt', 'md'] satisfies DocumentFormat[];

const isDocumentFormat = (value: string): value is DocumentFormat => KNOWN_FORMATS.includes(value);

export const SUPPORTED_FORMATS: readonly SupportedFormat[] = contract.formats.map((entry) => {
  if (!isDocumentFormat(entry.format)) {
    throw new Error(`document-formats.json names an unknown format: ${entry.format}`);
  }
  return { label: entry.label, format: entry.format, extensions: entry.extensions };
});

/** Joins labels as English prose: "A or B", "A, B, or C". */
export function listAlternatives(labels: readonly string[]): string {
  const last = labels.at(-1) ?? '';
  if (labels.length < 2) return last;
  const head = labels.slice(0, -1).join(', ');
  return labels.length === 2 ? `${head} or ${last}` : `${head}, or ${last}`;
}

/** Joins labels as English conjunction: "A and B", "A, B, and C". */
export function listConjunction(labels: readonly string[]): string {
  const last = labels.at(-1) ?? '';
  if (labels.length < 2) return last;
  const head = labels.slice(0, -1).join(', ');
  return labels.length === 2 ? `${head} and ${last}` : `${head}, and ${last}`;
}

/** "PDF, EPUB, TXT, or Markdown", for the drop overlay and the empty state. */
export const SUPPORTED_FORMAT_LIST = listAlternatives(
  SUPPORTED_FORMATS.map((entry) => entry.label),
);

/** "PDF, EPUB, TXT, and Markdown", for statements of what SynapseRead opens. */
export const SUPPORTED_FORMAT_CONJUNCTION = listConjunction(
  SUPPORTED_FORMATS.map((entry) => entry.label),
);

const extensionOf = (path: string): string => {
  const fileName = path.split(/[\\/]/).pop() ?? path;
  return fileName.includes('.') ? (fileName.split('.').pop()?.toLowerCase() ?? '') : '';
};

/** The format a file at `path` registers as, mirroring core's `from_extension`. */
export function formatForPath(path: string): DocumentFormat | null {
  const extension = extensionOf(path);
  return SUPPORTED_FORMATS.find((entry) => entry.extensions.includes(extension))?.format ?? null;
}

/**
 * How to label a document: by its file's extension, so Markdown read with the TXT
 * engine still says Markdown, falling back to the stored format.
 */
export function documentFormatLabel(document: Pick<StudyDocument, 'filePath' | 'format'>): string {
  const extension = extensionOf(document.filePath);
  const entry = SUPPORTED_FORMATS.find(
    (candidate) => candidate.format === document.format && candidate.extensions.includes(extension),
  );
  return entry?.label ?? document.format.toUpperCase();
}
