import { describe, expect, it } from 'vitest';

import { formatAnnotationSource, formatCardSource } from '@/lib/sourceAttribution';
import type { Annotation, NoteCard, StudyDocument } from '@/types/domain';

function makeDoc(overrides: Partial<StudyDocument> = {}): StudyDocument {
  return {
    id: 'doc-1',
    title: 'thinking-fast',
    displayTitle: 'Thinking, Fast and Slow',
    filePath: '/books/thinking-fast.pdf',
    fileHash: 'hash-1',
    format: 'pdf',
    encoding: 'utf-8',
    lastCursorAnchor: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: 'ann-1',
    documentId: 'doc-1',
    notebookId: 'nb-1',
    anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 5, lineIndex: 0 },
    excerptText: 'hello',
    excerptImagePath: null,
    note: null,
    color: '#fde047',
    style: 'highlight',
    locationLabel: 'Ch. 3 · p. 41',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('sourceAttribution (#125)', () => {
  it('combines document display title with locationLabel', () => {
    expect(formatAnnotationSource(makeAnnotation(), [makeDoc()])).toBe(
      'Thinking, Fast and Slow · Ch. 3 · p. 41',
    );
  });

  it('falls back to filename stem when displayTitle is absent', () => {
    expect(formatAnnotationSource(makeAnnotation(), [makeDoc({ displayTitle: null })])).toBe(
      'thinking-fast · Ch. 3 · p. 41',
    );
  });

  it('shows document title alone for older annotations without a locationLabel', () => {
    expect(formatAnnotationSource(makeAnnotation({ locationLabel: null }), [makeDoc()])).toBe(
      'Thinking, Fast and Slow',
    );
    const legacy = makeAnnotation();
    delete legacy.locationLabel;
    expect(formatAnnotationSource(legacy, [makeDoc()])).toBe('Thinking, Fast and Slow');
  });

  it('falls back to locationLabel if the document is missing, or null when neither exists', () => {
    expect(formatAnnotationSource(makeAnnotation(), [])).toBe('Ch. 3 · p. 41');
    expect(formatAnnotationSource(makeAnnotation({ locationLabel: null }), [])).toBeNull();
  });

  it('formats single-excerpt and multi-excerpt cards without inspecting anchors', () => {
    const doc1 = makeDoc();
    const doc2 = makeDoc({ id: 'doc-2', title: 'notes', displayTitle: null });
    const ann1 = makeAnnotation({
      id: 'ann-1',
      documentId: 'doc-1',
      locationLabel: 'Ch. 3 · p. 41',
    });
    const ann2 = makeAnnotation({ id: 'ann-2', documentId: 'doc-2', locationLabel: 'Line 12' });
    const singleCard: NoteCard = {
      id: 'card-1',
      notebookId: 'nb-1',
      title: 'Card',
      markdownNotes: '',
      tags: [],
      annotationIds: ['ann-1'],
      createdAt: '2026-01-01T00:00:00Z',
    };
    expect(formatCardSource(singleCard, [ann1, ann2], [doc1, doc2])).toBe(
      'Thinking, Fast and Slow · Ch. 3 · p. 41',
    );
    expect(
      formatCardSource({ annotationIds: ['ann-1', 'ann-2'] }, [ann1, ann2], [doc1, doc2]),
    ).toBe('Thinking, Fast and Slow · Ch. 3 · p. 41 (+1)');
    expect(formatCardSource({ annotationIds: [] }, [ann1], [doc1])).toBeNull();
  });
});
