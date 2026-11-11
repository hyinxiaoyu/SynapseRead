import { assert } from './harness.mjs';

const FIRST = 'first line\nsecond line';
const EDITED = 'first line\nsecond line\nthird line';

const visibleIn = (viewer, selector) =>
  `[...(${viewer})?.querySelectorAll(${JSON.stringify(selector)}) ?? []].filter((e) => e.checkVisibility({ visibilityProperty: true }))`;
const popover = `document.querySelector('[data-testid="selection-popover"]')`;

/**
 * Notes where they were written (#48), for any reader: a note added to a
 * highlight shows on the page, opens with the highlight, and keeps its line
 * breaks in the popover and in the sidebar, where it edits in a multi-line field.
 *
 * `highlightPoint` is an expression for a point on the highlight to click, and
 * `markerShown` one that holds once the reader draws the note marker.
 */
export async function notesInPlaceFlow(page, { name, viewer, highlightPoint, markerShown }) {
  const openHighlight = async (description) => {
    const point = await page.waitFor(highlightPoint, `${name}: the highlight to click`);
    await page.click(point);
    await page.waitFor(`${popover}?.dataset.popoverMode === 'edit'`, `${name}: ${description}`);
  };

  // Saving moves focus out of the closing note field, so put it back on a control first.
  const closePopover = async (description) => {
    await page.evaluate(`${popover}.querySelector('[data-popover-control]').focus()`);
    await page.press('Escape');
    await page.waitFor(`!${popover}`, description);
  };

  await openHighlight('a click on the highlight to open it');
  await page.clickButton('Add Note');
  await page.setInputValue('[data-testid="popover-note-input"]', FIRST);
  await page.clickButton('Save Note');
  await page.waitFor(markerShown, `${name}: the note marker on the page`);
  await closePopover(`${name}: Esc to put the popover away`);

  // Opening the highlight again shows the note at once, as written, with Edit.
  await openHighlight('the noted highlight to open');
  const shown = await page.waitFor(
    `${popover}?.querySelector('[data-testid="popover-note-text"]')?.innerText`,
    `${name}: the note to show in the popover`,
  );
  assert(shown === FIRST, `${name}: the popover keeps line breaks, got ${JSON.stringify(shown)}`);
  await page.waitFor(
    `${popover}.querySelector('[data-testid="popover-note-edit"]')`,
    `${name}: an Edit button beside the note`,
  );
  await closePopover(`${name}: Esc to put the noted popover away`);

  // The sidebar shows the note's lines and edits them in a multi-line field.
  await page.showSidebarTab('Highlights & Notes');
  const preview = `${visibleIn(viewer, '[data-testid="annotation-note-preview"]')}[0]`;
  await page.waitFor(
    `${preview}?.innerText === ${JSON.stringify(FIRST)}`,
    `${name}: the sidebar note keeps its line breaks`,
  );
  await page.evaluate(
    `${preview}.closest('[data-testid="annotation-item"]').querySelector('[data-testid="annotation-edit-button"]').click()`,
  );
  const fieldTag = await page.waitFor(
    `${visibleIn(viewer, '[data-testid="annotation-note-input"]')}[0]?.tagName`,
    `${name}: the sidebar note field`,
  );
  assert(fieldTag === 'TEXTAREA', `${name}: the sidebar edits notes in a ${fieldTag}`);
  await page.setInputValue('[data-testid="annotation-note-input"]', EDITED);
  await page.evaluate(`${visibleIn(viewer, '[data-testid="annotation-note-save"]')}[0].click()`);
  await page.waitFor(
    `${preview}?.innerText === ${JSON.stringify(EDITED)}`,
    `${name}: saving from the sidebar keeps every line`,
  );

  // Has Note leaves only the noted row; turning it off brings the rest back.
  const rows = `${visibleIn(viewer, '[data-testid="annotation-item"]')}.length`;
  const before = await page.evaluate(rows);
  assert(before > 1, `${name}: more than one highlight to filter, got ${before}`);
  await page.evaluate(
    `${visibleIn(viewer, '[data-testid="annotation-filter-has-note"]')}[0].click()`,
  );
  await page.waitFor(`${rows} === 1`, `${name}: Has Note to leave the noted row`);
  await page.evaluate(
    `${visibleIn(viewer, '[data-testid="annotation-filter-has-note"]')}[0].click()`,
  );
  await page.waitFor(`${rows} === ${before}`, `${name}: every row back without Has Note`);
  await page.hideSidebar();
}
