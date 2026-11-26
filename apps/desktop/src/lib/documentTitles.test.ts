import { describe, expect, it } from 'vitest';

import type { StudyDocument } from '@/types/domain';

import {
  documentDisplayName,
  documentTabLabels,
  documentTooltip,
  fileNameOf,
  MAX_QUALIFIER_CHARS,
  normalizeMetadataTitle,
  parentFolderOf,
} from './documentTitles';

function makeDoc(
  overrides: Partial<StudyDocument> & Pick<StudyDocument, 'id' | 'title' | 'filePath' | 'format'>,
): StudyDocument {
  return {
    fileHash: `hash-${overrides.id}`,
    encoding: 'utf-8',
    lastCursorAnchor: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('documentTitles', () => {
  it('resolves display name from displayTitle with fallback to file stem', () => {
    expect(
      documentDisplayName({
        title: 'pg1342-images-3',
        displayTitle: 'Pride and Prejudice',
      }),
    ).toBe('Pride and Prejudice');
    expect(documentDisplayName({ title: 'pg1342-images-3', displayTitle: null })).toBe(
      'pg1342-images-3',
    );
    expect(documentDisplayName({ title: 'pg1342-images-3', displayTitle: '   ' })).toBe(
      'pg1342-images-3',
    );
  });

  it('extracts cross-platform file names and parent folders', () => {
    expect(fileNameOf('/Users/reader/Books/sample.epub')).toBe('sample.epub');
    expect(fileNameOf('C:\\Users\\reader\\Books\\sample.pdf')).toBe('sample.pdf');
    expect(fileNameOf('sample.txt')).toBe('sample.txt');

    expect(parentFolderOf('/Users/reader/Books/sample.epub')).toBe('Books');
    expect(parentFolderOf('C:\\Users\\reader\\Books\\sample.pdf')).toBe('Books');
    expect(parentFolderOf('/sample.epub')).toBe('');
    expect(parentFolderOf('sample.txt')).toBe('');
  });

  it('formats tooltips with display title and file name when they differ', () => {
    expect(
      documentTooltip({
        title: 'pg1342-images-3',
        displayTitle: 'Pride and Prejudice',
        filePath: '/books/pg1342-images-3.epub',
      }),
    ).toBe('Pride and Prejudice\npg1342-images-3.epub');

    expect(
      documentTooltip({
        title: 'notes',
        displayTitle: null,
        filePath: '/books/notes.txt',
      }),
    ).toBe('notes\nnotes.txt');

    expect(
      documentTooltip({
        title: 'book.epub',
        displayTitle: 'book.epub',
        filePath: '/books/book.epub',
      }),
    ).toBe('book.epub');
  });

  it('normalizes metadata titles and rejects placeholders and filenames', () => {
    expect(normalizeMetadataTitle('  Pride   and\n\tPrejudice \u202E ')).toBe(
      'Pride and Prejudice',
    );
    expect(normalizeMetadataTitle('红楼梦')).toBe('红楼梦');
    expect(normalizeMetadataTitle(null)).toBeNull();
    expect(normalizeMetadataTitle(42)).toBeNull();
    expect(normalizeMetadataTitle('   ---   ')).toBeNull();

    for (const placeholder of [
      'Untitled',
      'untitled-1',
      'Untitled Document',
      'UNKNOWN',
      'Title',
      'document',
      'Document1',
      'none',
      'null',
      'Microsoft Word - draft',
      'Microsoft PowerPoint - slides',
      'Microsoft Excel - budget',
      'paper.pdf',
      'chapter1.docx',
      'thesis.tex',
      'book.epub',
    ]) {
      expect(normalizeMetadataTitle(placeholder)).toBeNull();
    }
  });

  it('keeps lone tab labels plain and disambiguates same-named tabs by format, short filename, short folder, and ordinal', () => {
    const lone = makeDoc({
      id: 'lone',
      title: 'alone',
      filePath: '/a/alone.epub',
      format: 'epub',
    });
    expect(documentTabLabels([lone]).get('lone')).toEqual({
      base: 'alone',
      suffix: '',
      suffixDisplay: '',
      text: 'alone',
    });

    // Issue #129 example: sample.txt, sample.pdf, sample.epub, sample.md
    const samples = [
      makeDoc({ id: 's-txt', title: 'sample', filePath: '/samples/sample.txt', format: 'txt' }),
      makeDoc({ id: 's-pdf', title: 'sample', filePath: '/samples/sample.pdf', format: 'pdf' }),
      makeDoc({ id: 's-epub', title: 'sample', filePath: '/samples/sample.epub', format: 'epub' }),
      makeDoc({ id: 's-md', title: 'sample', filePath: '/samples/sample.md', format: 'txt' }),
    ];
    const sampleLabels = documentTabLabels(samples);
    expect(sampleLabels.get('s-txt')).toEqual({
      base: 'sample',
      suffix: 'TXT',
      suffixDisplay: '· TXT',
      text: 'sample · TXT',
    });
    expect(sampleLabels.get('s-pdf')?.text).toBe('sample · PDF');
    expect(sampleLabels.get('s-epub')?.text).toBe('sample · EPUB');
    expect(sampleLabels.get('s-md')?.text).toBe('sample · Markdown');
    expect(new Set([...sampleLabels.values()].map((label) => label.text)).size).toBe(4);

    // Two EPUBs sharing the same dc:title are told apart by short file names (<= MAX_QUALIFIER_CHARS).
    expect('first.epub'.length).toBeLessThanOrEqual(MAX_QUALIFIER_CHARS);
    const sameTitleShortEpubs = [
      makeDoc({
        id: 'e1',
        title: 'first',
        displayTitle: 'Middlemarch',
        filePath: '/books/first.epub',
        format: 'epub',
      }),
      makeDoc({
        id: 'e2',
        title: 'second',
        displayTitle: 'Middlemarch',
        filePath: '/books/second.epub',
        format: 'epub',
      }),
    ];
    const shortEpubLabels = documentTabLabels(sameTitleShortEpubs);
    expect(shortEpubLabels.get('e1')).toEqual({
      base: 'Middlemarch',
      suffix: 'first.epub',
      suffixDisplay: '· first.epub',
      text: 'Middlemarch · first.epub',
    });
    expect(shortEpubLabels.get('e2')).toEqual({
      base: 'Middlemarch',
      suffix: 'second.epub',
      suffixDisplay: '· second.epub',
      text: 'Middlemarch · second.epub',
    });

    // Long file names (> MAX_QUALIFIER_CHARS) in the same folder skip filename and fall back to `(2)`.
    const sameTitleLongEpubs = [
      makeDoc({
        id: 'le1',
        title: 'middlemarch-gutenberg',
        displayTitle: 'Middlemarch',
        filePath: '/books/middlemarch-gutenberg.epub',
        format: 'epub',
      }),
      makeDoc({
        id: 'le2',
        title: 'middlemarch-annotated',
        displayTitle: 'Middlemarch',
        filePath: '/books/middlemarch-annotated.epub',
        format: 'epub',
      }),
    ];
    const longEpubLabels = documentTabLabels(sameTitleLongEpubs);
    expect(longEpubLabels.get('le1')).toEqual({
      base: 'Middlemarch',
      suffix: '',
      suffixDisplay: '',
      text: 'Middlemarch',
    });
    expect(longEpubLabels.get('le2')).toEqual({
      base: 'Middlemarch',
      suffix: '(2)',
      suffixDisplay: '(2)',
      text: 'Middlemarch (2)',
    });

    // Same name and format in different short folders are told apart by parent folder.
    const sameFileDifferentDirs = [
      makeDoc({
        id: 'f1',
        title: 'notes',
        filePath: '/work/notes.txt',
        format: 'txt',
      }),
      makeDoc({
        id: 'f2',
        title: 'notes',
        filePath: '/personal/notes.txt',
        format: 'txt',
      }),
    ];
    const folderLabels = documentTabLabels(sameFileDifferentDirs);
    expect(folderLabels.get('f1')?.text).toBe('notes · work');
    expect(folderLabels.get('f2')?.text).toBe('notes · personal');

    // Over-long folder names (> 12 code points, counting surrogate pairs as 1) fall back to `(2)`.
    const longDirDocs = [
      makeDoc({
        id: 'ld1',
        title: 'notes',
        filePath: '/project-alpha-folder/notes.txt',
        format: 'txt',
      }),
      makeDoc({
        id: 'ld2',
        title: 'notes',
        filePath: '/project-beta-folder/notes.txt',
        format: 'txt',
      }),
    ];
    const longDirLabels = documentTabLabels(longDirDocs);
    expect(longDirLabels.get('ld1')?.text).toBe('notes');
    expect(longDirLabels.get('ld2')?.text).toBe('notes (2)');

    // Identical display name, format, filename, and parent folder fall back to ordinals.
    const identical = [
      makeDoc({ id: 'i1', title: 'dup', filePath: '/same/dup.txt', format: 'txt' }),
      makeDoc({ id: 'i2', title: 'dup', filePath: '/same/dup.txt', format: 'txt' }),
    ];
    const identicalLabels = documentTabLabels(identical);
    expect(identicalLabels.get('i1')?.text).toBe('dup');
    expect(identicalLabels.get('i2')).toEqual({
      base: 'dup',
      suffix: '(2)',
      suffixDisplay: '(2)',
      text: 'dup (2)',
    });
  });

  it('skips ordinals already claimed by another tab title regardless of open order (#129)', () => {
    const atlasA = makeDoc({
      id: 'atlas-1',
      title: 'Atlas',
      filePath: '/same/Atlas.pdf',
      format: 'pdf',
    });
    const atlasB = makeDoc({
      id: 'atlas-2',
      title: 'Atlas',
      filePath: '/same/Atlas.pdf',
      format: 'pdf',
    });
    const atlas2 = makeDoc({
      id: 'atlas-existing-2',
      title: 'Atlas (2)',
      filePath: '/same/Atlas (2).pdf',
      format: 'pdf',
    });

    // Existing `Atlas (2)` opened last (after the two colliding `Atlas` tabs).
    const existingLast = documentTabLabels([atlasA, atlasB, atlas2]);
    expect(existingLast.get('atlas-1')?.text).toBe('Atlas');
    expect(existingLast.get('atlas-2')?.text).toBe('Atlas (3)');
    expect(existingLast.get('atlas-existing-2')?.text).toBe('Atlas (2)');
    expect(new Set([...existingLast.values()].map((l) => l.text.toLowerCase())).size).toBe(3);

    // Existing `Atlas (2)` opened first (and case-insensitive match).
    const atlas2Lower = makeDoc({
      id: 'atlas-existing-lower-2',
      title: 'atlas (2)',
      filePath: '/same/atlas (2).pdf',
      format: 'pdf',
    });
    const existingFirst = documentTabLabels([atlas2Lower, atlasA, atlasB]);
    expect(existingFirst.get('atlas-existing-lower-2')?.text).toBe('atlas (2)');
    expect(existingFirst.get('atlas-1')?.text).toBe('Atlas');
    expect(existingFirst.get('atlas-2')?.text).toBe('Atlas (3)');
    expect(new Set([...existingFirst.values()].map((l) => l.text.toLowerCase())).size).toBe(3);
  });
});
