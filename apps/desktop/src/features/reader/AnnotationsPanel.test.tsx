import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  type AnnotationsController,
  AnnotationsList,
  filterAnnotations,
  localHighlights,
  useAnnotationsController,
} from '@/features/reader/AnnotationsPanel';
import type { Annotation } from '@/types/domain';

const YELLOW = '#fde047';
const GREEN = '#86efac';

function annotation(id: string, overrides: Partial<Annotation> = {}): Annotation {
  return {
    id,
    documentId: 'doc',
    notebookId: 'nb',
    anchor: { format: 'txt', startByteOffset: 0, endByteOffset: 4, lineIndex: 0 },
    excerptText: `excerpt ${id}`,
    excerptImagePath: null,
    note: null,
    color: YELLOW,
    style: 'highlight',
    createdAt: '2026-11-01T10:00:00.000Z',
    ...overrides,
  };
}

function controllerFor(
  annotations: readonly Annotation[],
  overrides: Partial<AnnotationsController> = {},
): AnnotationsController {
  return {
    annotations,
    activeColor: YELLOW,
    activeStyle: 'highlight',
    highlightMode: false,
    draftNoteOpen: false,
    draftNote: '',
    canUndoDelete: false,
    setActiveColor: vi.fn(),
    setActiveStyle: vi.fn(),
    setActiveMarkup: vi.fn(),
    toggleHighlightMode: vi.fn(),
    setDraftNote: vi.fn(),
    toggleDraftNote: vi.fn(),
    openDraftNote: vi.fn(),
    closeDraftNote: vi.fn(),
    createHighlight: vi.fn(),
    submitNoteSelection: vi.fn(),
    selectAnnotation: vi.fn(),
    updateAnnotation: vi.fn(),
    deleteAnnotation: vi.fn(),
    undoDelete: vi.fn(),
    isAnnotationStale: () => false,
    ...overrides,
  };
}

const excerpts = () =>
  screen.getAllByTestId('annotation-excerpt').map((element) => element.textContent);

describe('filterAnnotations', () => {
  const all = [
    annotation('a', { color: YELLOW, note: 'Remember this' }),
    annotation('b', { color: GREEN }),
    annotation('c', { color: GREEN, note: '  ' }),
  ];

  it('filters by color, by Has Note, and by text together', () => {
    const none = { colors: new Set<string>(), noteOnly: false };
    expect(filterAnnotations(all, '', none).map(({ id }) => id)).toEqual(['a', 'b', 'c']);
    expect(
      filterAnnotations(all, '', { colors: new Set([GREEN]), noteOnly: false }).map(({ id }) => id),
    ).toEqual(['b', 'c']);
    // A blank note is not a note.
    expect(filterAnnotations(all, '', { ...none, noteOnly: true }).map(({ id }) => id)).toEqual([
      'a',
    ]);
    expect(filterAnnotations(all, 'remember', none).map(({ id }) => id)).toEqual(['a']);
    expect(
      filterAnnotations(all, 'remember', { colors: new Set([GREEN]), noteOnly: false }),
    ).toEqual([]);
  });
});

describe('localHighlights', () => {
  it('says which highlights carry a note', () => {
    expect(
      localHighlights([annotation('a', { note: 'n' }), annotation('b')]).map(
        ({ annotationId, hasNote }) => [annotationId, hasNote],
      ),
    ).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });
});

describe('AnnotationsList', () => {
  it('filters rows by color and Has Note, and says how many match', () => {
    const controller = controllerFor([
      annotation('a', { note: 'with a note' }),
      annotation('b', { color: GREEN }),
    ]);
    render(<AnnotationsList controller={controller} filter="" />);
    expect(excerpts()).toEqual(['excerpt a', 'excerpt b']);

    fireEvent.click(screen.getByTestId('annotation-filter-color-green'));
    expect(screen.getByTestId('annotation-filter-color-green')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(excerpts()).toEqual(['excerpt b']);
    expect(screen.getByTestId('annotations-count')).toHaveTextContent('1 of 2 highlights');

    fireEvent.click(screen.getByTestId('annotation-filter-has-note'));
    expect(screen.getByTestId('annotations-no-match')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('annotation-filter-color-green'));
    expect(excerpts()).toEqual(['excerpt a']);
  });

  it('orders rows that share a place with the tie-break, and names the place as told', () => {
    const controller = controllerFor([
      annotation('late', { excerptText: 'later in the chapter' }),
      annotation('early', { excerptText: 'earlier in the chapter' }),
      annotation('next', { excerptText: 'next chapter' }),
    ]);
    const chapterOf = (a: Annotation) => (a.id === 'next' ? 1 : 0);
    render(
      <AnnotationsList
        controller={controller}
        filter=""
        placementOf={(a) => ({
          group: chapterOf(a) === 0 ? 'Chapter One' : 'Chapter Two',
          label: chapterOf(a) === 0 ? 'Chapter One' : 'Chapter Two',
          order: chapterOf(a),
        })}
        compareWithinOrder={(a, b) => (a.id === 'early' ? -1 : b.id === 'early' ? 1 : 0)}
      />,
    );
    expect(excerpts()).toEqual(['earlier in the chapter', 'later in the chapter', 'next chapter']);
    expect(screen.getAllByTestId('annotation-location').map((e) => e.textContent)).toEqual([
      'Chapter One',
      'Chapter One',
      'Chapter Two',
    ]);
  });

  it('expands a clamped row in place with the button or the arrow keys', () => {
    const long = 'A long excerpt that the sidebar clamps to three lines. '.repeat(6);
    const controller = controllerFor([annotation('a', { excerptText: long, note: 'one\ntwo' })]);
    // jsdom has no layout: the clamp hides text when content is taller than its box.
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'annotation-excerpt' ? 120 : 0;
      });
    try {
      render(<AnnotationsList controller={controller} filter="" />);
      const excerpt = screen.getByTestId('annotation-excerpt');
      expect(excerpt).toHaveClass('line-clamp-3');
      const toggle = screen.getByTestId('annotation-expand-button');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(toggle);
      expect(excerpt).not.toHaveClass('line-clamp-3');
      expect(screen.getByTestId('annotation-note-preview')).not.toHaveClass('line-clamp-2');
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const row = screen.getByTestId('annotation-jump-button');
      fireEvent.keyDown(row, { key: 'ArrowLeft' });
      expect(excerpt).toHaveClass('line-clamp-3');
      fireEvent.keyDown(row, { key: 'ArrowRight' });
      expect(excerpt).not.toHaveClass('line-clamp-3');
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('measures a long note again once the editor that hid it closes', () => {
    const long = 'A long note. '.repeat(20);
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'annotation-note-preview' ? 120 : 0;
      });
    try {
      const updateAnnotation = vi.fn();
      const { rerender } = render(
        <AnnotationsList
          controller={controllerFor([annotation('a', { note: long })], { updateAnnotation })}
          filter=""
        />,
      );
      expect(screen.getByTestId('annotation-expand-button')).toBeInTheDocument();

      // Leaving the field saves and keeps the editor open, so the note changes while
      // its preview is hidden.
      fireEvent.click(screen.getByTestId('annotation-edit-button'));
      const field = screen.getByTestId('annotation-note-input');
      fireEvent.change(field, { target: { value: `${long} more` } });
      fireEvent.blur(field);
      expect(updateAnnotation).toHaveBeenCalledTimes(1);
      rerender(
        <AnnotationsList
          controller={controllerFor([annotation('a', { note: `${long} more` })], {
            updateAnnotation,
          })}
          filter=""
        />,
      );
      fireEvent.keyDown(screen.getByTestId('annotation-note-input'), { key: 'Escape' });
      expect(screen.getByTestId('annotation-note-preview')).toBeInTheDocument();
      expect(screen.getByTestId('annotation-expand-button')).toBeInTheDocument();
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('saves once when the field blurs as Save or ⌘↩ closes it', () => {
    const updateAnnotation = vi.fn();
    const controller = controllerFor([annotation('a', { note: 'old' })], { updateAnnotation });
    render(<AnnotationsList controller={controller} filter="" />);

    // jsdom fires no blur when a focused field is removed; a WebView can. Blurring
    // inside the same act, before React removes the field, stands in for that.
    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    let field = screen.getByTestId('annotation-note-input');
    fireEvent.change(field, { target: { value: 'new' } });
    act(() => {
      fireEvent.click(screen.getByTestId('annotation-note-save'));
      fireEvent.blur(field);
    });
    expect(updateAnnotation).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('annotation-note-input')).toBeNull();

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    field = screen.getByTestId('annotation-note-input');
    fireEvent.change(field, { target: { value: 'newer' } });
    act(() => {
      fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
      fireEvent.blur(field);
    });
    expect(updateAnnotation).toHaveBeenCalledTimes(2);
    expect(updateAnnotation).toHaveBeenLastCalledWith('a', { note: 'newer', color: null });
  });

  it('shows no note preview for a note that is only whitespace', () => {
    render(
      <AnnotationsList controller={controllerFor([annotation('a', { note: ' \n ' })])} filter="" />,
    );
    expect(screen.queryByTestId('annotation-note-preview')).toBeNull();
  });

  it('offers no expand button when nothing is cut off', () => {
    render(<AnnotationsList controller={controllerFor([annotation('a')])} filter="" />);
    expect(screen.queryByTestId('annotation-expand-button')).toBeNull();
  });

  it('edits a note in a multi-line field that keeps its line breaks', () => {
    const updateAnnotation = vi.fn();
    const controller = controllerFor([annotation('a', { note: 'first line' })], {
      updateAnnotation,
    });
    render(<AnnotationsList controller={controller} filter="" />);
    // The preview shows line breaks as written.
    expect(screen.getByTestId('annotation-note-preview')).toHaveClass('whitespace-pre-wrap');

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    const field = screen.getByTestId('annotation-note-input');
    expect(field.tagName).toBe('TEXTAREA');
    expect(field).toHaveFocus();
    // Return is a new line, not a save.
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(updateAnnotation).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'first line\nsecond line' } });
    fireEvent.click(screen.getByTestId('annotation-note-save'));
    expect(updateAnnotation).toHaveBeenCalledWith('a', {
      note: 'first line\nsecond line',
      color: null,
    });
    expect(screen.queryByTestId('annotation-note-input')).toBeNull();
  });

  it('saves with ⌘↩ and throws the draft away with Esc or Cancel', () => {
    const updateAnnotation = vi.fn();
    const controller = controllerFor([annotation('a', { note: 'kept' })], { updateAnnotation });
    render(<AnnotationsList controller={controller} filter="" />);

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    fireEvent.change(screen.getByTestId('annotation-note-input'), {
      target: { value: 'thrown away' },
    });
    fireEvent.keyDown(screen.getByTestId('annotation-note-input'), { key: 'Escape' });
    expect(screen.queryByTestId('annotation-note-input')).toBeNull();

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    const form = screen.getByTestId('annotation-note-form');
    fireEvent.change(screen.getByTestId('annotation-note-input'), {
      target: { value: 'also not' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(updateAnnotation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('annotation-edit-button'));
    expect(screen.getByTestId('annotation-note-input')).toHaveValue('kept');
    fireEvent.change(screen.getByTestId('annotation-note-input'), {
      target: { value: 'line one\nline two' },
    });
    fireEvent.keyDown(screen.getByTestId('annotation-note-input'), { key: 'Enter', metaKey: true });
    expect(updateAnnotation).toHaveBeenCalledWith('a', {
      note: 'line one\nline two',
      color: null,
    });
  });
});

describe('useAnnotationsController', () => {
  it('remembers the last color and style for the next document', () => {
    const options = { documentId: 'doc', onSelectAnnotation: vi.fn(), onCreateAnnotation: vi.fn() };
    const first = renderHook(() => useAnnotationsController(options));
    expect(first.result.current.activeColor).toBe(YELLOW);
    act(() => first.result.current.createHighlight({ color: GREEN, style: 'underline' }));
    first.unmount();

    const next = renderHook(() => useAnnotationsController({ ...options, documentId: 'other' }));
    expect(next.result.current.activeColor).toBe(GREEN);
    expect(next.result.current.activeStyle).toBe('underline');

    // A tab that was already open offers the new choice too.
    act(() => next.result.current.setActiveColor(YELLOW));
    const open = renderHook(() => useAnnotationsController(options));
    act(() => next.result.current.setActiveColor('#93c5fd'));
    expect(open.result.current.activeColor).toBe('#93c5fd');
  });

  it('records the color and style of a new highlight in one write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    try {
      const options = {
        documentId: 'doc',
        onSelectAnnotation: vi.fn(),
        onCreateAnnotation: vi.fn(),
      };
      const { result } = renderHook(() => useAnnotationsController(options));
      setItem.mockClear();
      act(() => result.current.createHighlight({ color: '#c4b5fd', style: 'highlight' }));
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(result.current.activeColor).toBe('#c4b5fd');
    } finally {
      setItem.mockRestore();
    }
  });
});
