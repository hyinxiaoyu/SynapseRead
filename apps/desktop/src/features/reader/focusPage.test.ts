import { afterEach, describe, expect, it, vi } from 'vitest';

import { focusReadingPage } from '@/features/reader/focusPage';

function pageSurface(): { page: HTMLDivElement; field: HTMLTextAreaElement } {
  document.body.innerHTML = `
    <div id="page" tabindex="-1"></div>
    <textarea id="note"></textarea>
    <div id="rich" contenteditable="true"></div>
    <button id="control"></button>
    <div role="tablist"><button role="tab" id="tab"></button></div>`;
  return {
    page: document.getElementById('page') as HTMLDivElement,
    field: document.getElementById('note') as HTMLTextAreaElement,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focusReadingPage', () => {
  it('focuses the page from elsewhere without scrolling it', () => {
    const { page } = pageSurface();
    const focus = vi.spyOn(page, 'focus');
    document.getElementById('control')?.focus();

    expect(focusReadingPage(page)).toBe(true);
    expect(page).toHaveFocus();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('leaves a text field alone, so typing is never interrupted', () => {
    const { page, field } = pageSurface();
    for (const target of [field, document.getElementById('rich')]) {
      (target as HTMLElement).focus();
      expect(focusReadingPage(page)).toBe(false);
      expect(target).toHaveFocus();
    }
  });

  it('leaves the tablist alone, so its arrows keep moving between tabs', () => {
    const { page } = pageSurface();
    document.getElementById('tab')?.focus();

    expect(focusReadingPage(page)).toBe(false);
    expect(document.getElementById('tab')).toHaveFocus();
  });

  it('takes focus from a field or the tablist when an explicit leave forces it', () => {
    const { page, field } = pageSurface();
    field.focus();
    expect(focusReadingPage(page, { force: true })).toBe(true);
    expect(page).toHaveFocus();

    document.getElementById('tab')?.focus();
    expect(focusReadingPage(page, { force: true })).toBe(true);
    expect(page).toHaveFocus();
  });

  it('does nothing without a page, or for one already unmounted', () => {
    const { page } = pageSurface();
    expect(focusReadingPage(null)).toBe(false);
    page.remove();
    document.getElementById('control')?.focus();
    expect(focusReadingPage(page)).toBe(false);
    expect(document.getElementById('control')).toHaveFocus();
  });
});
