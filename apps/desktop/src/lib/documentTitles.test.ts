import { describe, expect, it } from 'vitest';

import type { StudyDocument } from '@/types/domain';

import {
  documentDisplayName,
  documentTabLabels,
  documentTooltip,
  fileNameOf,
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

  it('keeps lone tab labels plain and disambiguates same-named tabs by format, filename, folder, and ordinal', () => {
    const lone = makeDoc({
      id: 'lone',
      title: 'alone',
      filePath: '/a/alone.epub',
      format: 'epub',
    });
    expect(documentTabLabels([lone]).get('lone')).toBe('alone');

    // Issue #129 example: sample.txt, sample.pdf, sample.epub, sample.md
    const samples = [
      makeDoc({ id: 's-txt', title: 'sample', filePath: '/samples/sample.txt', format: 'txt' }),
      makeDoc({ id: 's-pdf', title: 'sample', filePath: '/samples/sample.pdf', format: 'pdf' }),
      makeDoc({ id: 's-epub', title: 'sample', filePath: '/samples/sample.epub', format: 'epub' }),
      makeDoc({ id: 's-md', title: 'sample', filePath: '/samples/sample.md', format: 'txt' }),
    ];
    const sampleLabels = documentTabLabels(samples);
    expect(sampleLabels.get('s-txt')).toBe('sample · TXT');
    expect(sampleLabels.get('s-pdf')).toBe('sample · PDF');
    expect(sampleLabels.get('s-epub')).toBe('sample · EPUB');
    expect(sampleLabels.get('s-md')).toBe('sample · Markdown');
    expect(new Set(sampleLabels.values()).size).toBe(4);

    // Two EPUBs sharing the same dc:title are told apart by file name.
    const sameTitleEpubs = [
      makeDoc({
        id: 'e1',
        title: 'middlemarch-gutenberg',
        displayTitle: 'Middlemarch',
        filePath: '/books/middlemarch-gutenberg.epub',
        format: 'epub',
      }),
      makeDoc({
        id: 'e2',
        title: 'middlemarch-annotated',
        displayTitle: 'Middlemarch',
        filePath: '/books/middlemarch-annotated.epub',
        format: 'epub',
      }),
    ];
    const epubLabels = documentTabLabels(sameTitleEpubs);
    expect(epubLabels.get('e1')).toBe('Middlemarch · middlemarch-gutenberg.epub');
    expect(epubLabels.get('e2')).toBe('Middlemarch · middlemarch-annotated.epub');

    // Same name and format in different folders are told apart by parent folder.
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
    expect(folderLabels.get('f1')).toBe('notes · work');
    expect(folderLabels.get('f2')).toBe('notes · personal');

    // Identical display name, format, filename, and parent folder fall back to ordinals.
    const identical = [
      makeDoc({ id: 'i1', title: 'dup', filePath: '/same/dup.txt', format: 'txt' }),
      makeDoc({ id: 'i2', title: 'dup', filePath: '/same/dup.txt', format: 'txt' }),
    ];
    const identicalLabels = documentTabLabels(identical);
    expect(identicalLabels.get('i1')).toBe('dup');
    expect(identicalLabels.get('i2')).toBe('dup (2)');
  });
});
