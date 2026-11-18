import { describe, expect, it } from 'vitest';

import contract from '../../../../fixtures/contract/document-formats.json';
import {
  documentFormatLabel,
  formatForPath,
  listAlternatives,
  SUPPORTED_FORMAT_LIST,
  SUPPORTED_FORMATS,
} from '@/lib/documentFormats';

describe('supported document formats (#99)', () => {
  it('names every format the picker offers, in contract order', () => {
    expect(SUPPORTED_FORMATS.map((entry) => entry.label)).toEqual(
      contract.formats.map((entry) => entry.label),
    );
    expect(SUPPORTED_FORMAT_LIST).toBe('PDF, EPUB, TXT, or Markdown');
  });

  it('never offers a format without a reader', () => {
    // `md` is reserved for the Markdown reader; until then Markdown opens as text.
    expect(SUPPORTED_FORMATS.map((entry) => entry.format)).not.toContain('md');
  });

  it('maps extensions as core does, case-insensitively', () => {
    expect(formatForPath('/notes/README.md')).toBe('txt');
    expect(formatForPath('C:\\notes\\Plan.MARKDOWN')).toBe('txt');
    expect(formatForPath('server.log')).toBe('txt');
    expect(formatForPath('book.epub')).toBe('epub');
    expect(formatForPath('paper.PDF')).toBe('pdf');
    expect(formatForPath('sheet.docx')).toBeNull();
    expect(formatForPath('Makefile')).toBeNull();
  });

  it('labels Markdown read with the TXT engine as Markdown', () => {
    expect(documentFormatLabel({ filePath: '/n/README.md', format: 'txt' })).toBe('Markdown');
    expect(documentFormatLabel({ filePath: '/n/a.txt', format: 'txt' })).toBe('TXT');
    expect(documentFormatLabel({ filePath: '/n/a.pdf', format: 'pdf' })).toBe('PDF');
    // A legacy `md` row that kept its format falls back to the stored format.
    expect(documentFormatLabel({ filePath: '/n/old.md', format: 'md' })).toBe('MD');
  });

  it('joins labels as prose', () => {
    expect(listAlternatives([])).toBe('');
    expect(listAlternatives(['PDF'])).toBe('PDF');
    expect(listAlternatives(['PDF', 'EPUB'])).toBe('PDF or EPUB');
    expect(listAlternatives(['PDF', 'EPUB', 'TXT'])).toBe('PDF, EPUB, or TXT');
  });
});
