import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type StudySyncState, useStudySyncStore } from '@/stores/useStudySyncStore';
import {
  DEFAULT_READING_PREFERENCES,
  type DocumentFormat,
  type StudyDocument,
} from '@/types/domain';

import { useReaderChromeTheme } from './useReaderChromeTheme';

const documentOf = (id: string, format: DocumentFormat): StudyDocument => ({
  id,
  title: `${format} document`,
  filePath: `/books/${id}`,
  fileHash: 'hash',
  format,
  encoding: 'utf-8',
  lastCursorAnchor: null,
  createdAt: '2026-01-01T00:00:00Z',
});

function Probe() {
  const chrome = useReaderChromeTheme();
  return <output data-testid="chrome">{chrome.theme ?? 'system'}</output>;
}

const setState = (state: Partial<StudySyncState>) => useStudySyncStore.setState(state);

beforeEach(() => {
  setState({
    documents: [],
    activeDocumentId: null,
    readingPreferences: { ...DEFAULT_READING_PREFERENCES },
  });
});

afterEach(() => {
  setState({
    documents: [],
    activeDocumentId: null,
    readingPreferences: { ...DEFAULT_READING_PREFERENCES },
  });
});

describe('useReaderChromeTheme', () => {
  it('takes the reading theme for a PDF tab, not only for reflowable ones', () => {
    setState({
      documents: [documentOf('pdf-1', 'pdf')],
      activeDocumentId: 'pdf-1',
      readingPreferences: { ...DEFAULT_READING_PREFERENCES, theme: 'sepia' },
    });
    render(<Probe />);

    expect(screen.getByTestId('chrome')).toHaveTextContent('sepia');
  });

  it('leaves the chrome to the system while no document is open', () => {
    setState({ readingPreferences: { ...DEFAULT_READING_PREFERENCES, theme: 'dark' } });
    render(<Probe />);

    expect(screen.getByTestId('chrome')).toHaveTextContent('system');
  });
});
