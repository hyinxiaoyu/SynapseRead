import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStudySyncStore } from '@/stores/useStudySyncStore';

import { StudyWorkspace } from './StudyWorkspace';

// The memory backend behind the singleton store outlives each reset, so a test
// may reload cards from earlier tests: assert on the newest one.
const initialState = useStudySyncStore.getState();

describe('StudyWorkspace', () => {
  beforeEach(() => {
    useStudySyncStore.setState(initialState, true);
  });

  const renderReady = async () => {
    render(<StudyWorkspace />);
    return screen.findByRole('region', { name: 'Document reader' });
  };

  it('renders all three panes once loaded', async () => {
    await renderReady();
    expect(screen.getByRole('region', { name: 'MindMap canvas' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Card inspector' })).toBeInTheDocument();
  });

  it('labels a session that will not be saved', async () => {
    await renderReady();
    expect(screen.getByText(/nothing is saved/i)).toBeInTheDocument();
  });

  it('only enables excerpting while something is selected', async () => {
    await renderReady();
    const excerpt = screen.getByRole('button', { name: 'Excerpt to MindMap' });
    expect(excerpt).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    expect(excerpt).toBeEnabled();
  });

  it('runs selection -> excerpt -> highlight -> inspector', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));

    const highlights = await screen.findByRole('region', { name: 'Highlights' });
    expect(highlights.querySelector('[data-annotation-id]')).not.toBeNull();
    expect(screen.getByLabelText('Title')).toHaveValue(
      useStudySyncStore.getState().cards.at(-1)?.title,
    );
    expect(screen.getByRole('button', { name: 'Excerpt to MindMap' })).toBeDisabled();
  });

  it('pulses the source highlight on a jump, then completes it', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));
    const highlights = await screen.findByRole('region', { name: 'Highlights' });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Jump to this excerpt' }));
      expect(useStudySyncStore.getState().jumpRequest).not.toBeNull();

      act(() => void vi.advanceTimersByTime(1));
      expect(highlights.querySelector('.anchor-pulse')).not.toBeNull();

      act(() => void vi.advanceTimersByTime(2000));
      expect(highlights.querySelector('.anchor-pulse')).toBeNull();
      expect(useStudySyncStore.getState().jumpRequest).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves card edits when the selection moves on without a blur', async () => {
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simulate selection' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excerpt to MindMap' }));

    const notes = await screen.findByLabelText('Notes');
    fireEvent.change(notes, { target: { value: 'unsaved thought' } });
    act(() => useStudySyncStore.getState().selectNode(null));

    await vi.waitFor(() =>
      expect(useStudySyncStore.getState().cards.at(-1)?.markdownNotes).toBe('unsaved thought'),
    );
  });

  it('shows store errors until dismissed', async () => {
    await renderReady();
    act(() => useStudySyncStore.setState({ error: 'disk full' }));
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
