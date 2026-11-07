import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { type OutlineNode, OutlineTree } from './OutlineTree';

const leaf = (id: string, label: string, target: number): OutlineNode<number> => ({
  id,
  label,
  target,
  children: [],
});

const BOOK: OutlineNode<number>[] = [
  leaf('front', 'Preface', 0),
  {
    id: 'ch1',
    label: 'Chapter 1: What is an AI agent? A long title that has to wrap',
    target: 1,
    hint: '2',
    children: [
      leaf('ch1-1', '1.1 Workflows', 2),
      {
        id: 'ch1-2',
        label: '1.2 Tasks',
        target: 3,
        children: [leaf('ch1-2-1', '1.2.1 Tasks that require an agent', 4)],
      },
    ],
  },
  {
    id: 'ch2',
    label: 'Chapter 2',
    target: 5,
    children: [leaf('ch2-1', '2.1 Tools', 6)],
  },
];

const item = (name: string | RegExp) => screen.getByRole('treeitem', { name });
const queryItem = (name: string | RegExp) => screen.queryByRole('treeitem', { name });

describe('OutlineTree', () => {
  it('expands only the current path, marks the current item, and exposes tree semantics', () => {
    render(<OutlineTree items={BOOK} currentId="ch1-1" emptyMessage="None" onSelect={vi.fn()} />);
    expect(screen.getByRole('tree', { name: 'Table of contents' })).toBeInTheDocument();
    const chapter = item(/Chapter 1/);
    expect(chapter).toHaveAttribute('aria-expanded', 'true');
    expect(chapter).toHaveAttribute('aria-level', '1');
    expect(chapter).toHaveAttribute('aria-posinset', '2');
    expect(chapter).toHaveAttribute('aria-setsize', '3');
    // The full title is the tooltip and accessible name, and the label wraps to two lines.
    expect(chapter).toHaveAttribute('title', BOOK[1]?.label);
    expect(chapter.querySelector('.line-clamp-2')).not.toBeNull();
    expect(chapter).toHaveTextContent('2');

    const current = item('1.1 Workflows');
    expect(current).toHaveAttribute('aria-current', 'location');
    expect(current).toHaveAttribute('aria-level', '2');
    expect(current).toHaveAttribute('tabindex', '0');
    // Siblings of the path stay collapsed.
    expect(item('Chapter 2')).toHaveAttribute('aria-expanded', 'false');
    expect(queryItem('2.1 Tools')).not.toBeInTheDocument();
    expect(item('1.2 Tasks')).toHaveAttribute('aria-expanded', 'false');
  });

  it('moves with arrows, collapses and expands with ←/→, expands siblings with *, and selects with Return', () => {
    const onSelect = vi.fn();
    render(<OutlineTree items={BOOK} currentId="ch1" emptyMessage="None" onSelect={onSelect} />);
    const chapter = item(/Chapter 1/);
    chapter.focus();

    fireEvent.keyDown(chapter, { key: 'ArrowDown' });
    expect(item('1.1 Workflows')).toHaveFocus();
    fireEvent.keyDown(item('1.1 Workflows'), { key: 'ArrowDown' });
    const tasks = item('1.2 Tasks');
    expect(tasks).toHaveFocus();

    fireEvent.keyDown(tasks, { key: 'ArrowRight' });
    expect(tasks).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(tasks, { key: 'ArrowRight' });
    expect(item(/1\.2\.1/)).toHaveFocus();

    fireEvent.keyDown(item(/1\.2\.1/), { key: 'ArrowLeft' });
    expect(tasks).toHaveFocus();
    fireEvent.keyDown(tasks, { key: 'ArrowLeft' });
    expect(tasks).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(tasks, { key: 'ArrowLeft' });
    expect(item(/Chapter 1/)).toHaveFocus();

    fireEvent.keyDown(item(/Chapter 1/), { key: '*' });
    expect(item('Chapter 2')).toHaveAttribute('aria-expanded', 'true');
    expect(item('2.1 Tools')).toBeInTheDocument();

    fireEvent.keyDown(item(/Chapter 1/), { key: 'End' });
    expect(item('2.1 Tools')).toHaveFocus();
    fireEvent.keyDown(item('2.1 Tools'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(6);
  });

  it('toggles a branch from its disclosure triangle without jumping', () => {
    const onSelect = vi.fn();
    render(<OutlineTree items={BOOK} currentId={null} emptyMessage="None" onSelect={onSelect} />);
    const disclosure = item('Chapter 2').querySelector('[data-testid="toc-disclosure"]');
    fireEvent.click(disclosure as Element);
    expect(item('Chapter 2')).toHaveAttribute('aria-expanded', 'true');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('opens the path to a new location and keeps what the reader expanded', () => {
    const view = render(
      <OutlineTree items={BOOK} currentId="front" emptyMessage="None" onSelect={vi.fn()} />,
    );
    expect(queryItem(/1\.2\.1/)).not.toBeInTheDocument();
    view.rerender(
      <OutlineTree items={BOOK} currentId="ch1-2-1" emptyMessage="None" onSelect={vi.fn()} />,
    );
    expect(item(/1\.2\.1/)).toHaveAttribute('aria-current', 'location');
    expect(item('1.2 Tasks')).toHaveAttribute('aria-expanded', 'true');
  });

  it('filters to matching sections and their ancestors', () => {
    render(
      <OutlineTree
        items={BOOK}
        currentId={null}
        filter="tools"
        emptyMessage="None"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByRole('treeitem').map((row) => row.getAttribute('aria-label'))).toEqual([
      'Chapter 2',
      '2.1 Tools',
    ]);
  });

  it('subdues sections before the current one when asked, but not its ancestors', () => {
    render(
      <OutlineTree items={BOOK} currentId="ch1-2" dimRead emptyMessage="None" onSelect={vi.fn()} />,
    );
    expect(item('Preface')).toHaveAttribute('data-read', 'true');
    expect(item('1.1 Workflows')).toHaveAttribute('data-read', 'true');
    expect(item(/Chapter 1/)).not.toHaveAttribute('data-read');
    expect(item('Chapter 2')).not.toHaveAttribute('data-read');
  });

  it('explains an empty outline', () => {
    render(
      <OutlineTree items={[]} currentId={null} emptyMessage="No outline." onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId('reader-toc')).toHaveTextContent('No outline.');
  });
});
