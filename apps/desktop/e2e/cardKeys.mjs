import { assert } from './harness.mjs';

const CARD_NODE = '.react-flow__node';
const INSPECTOR_TOGGLE = `document.querySelector('button[aria-label="Show inspector"], button[aria-label="Hide inspector"]')`;

/**
 * Issue #123: right after an excerpt selects its new card, bare Backspace, Delete,
 * and Return pressed in the reader must stay the reader's. Clicks `focusPoint` (a
 * real click, so focus lands where a reader's would), presses each key, and checks
 * that no card was deleted, the Inspector did not open, and focus never moved into
 * its Notes.
 *
 * `focus` names the element that must own focus before the keys are sent, so the
 * check exercises that reader's key path and cannot pass with focus on `body` or
 * a stray control. `selector` must match `document.activeElement` itself; with
 * `within`, the active element only has to be inside it.
 */
export async function assertCardKeysStayInReader(page, focusPoint, where, focus) {
  assert(focus?.selector, `an expected focus target is required for ${where}`);
  await page.waitFor(
    `Boolean(document.querySelector(${JSON.stringify(`${CARD_NODE}.selected`)}))`,
    `a selected card before pressing card keys in ${where}`,
  );
  const before = await page.evaluate(`({
    cards: document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length,
    inspector: ${INSPECTOR_TOGGLE}?.getAttribute('aria-label'),
  })`);

  await page.click(focusPoint);
  const actual = await page.evaluate(`(() => {
    const active = document.activeElement;
    const selector = ${JSON.stringify(focus.selector)};
    return {
      expected: Boolean(${focus.within ? 'active?.closest(selector)' : 'active?.matches(selector)'}),
      onCanvas: Boolean(active?.closest('.react-flow')),
      tag: active?.tagName ?? null,
      testId: active?.closest('[data-testid]')?.getAttribute('data-testid') ?? null,
    };
  })()`);
  assert(
    actual.expected && !actual.onCanvas,
    `focus must be on ${focus.within ? 'something inside ' : ''}${focus.selector} in ${where} ` +
      `before the card keys: ${JSON.stringify(actual)}`,
  );

  for (const key of ['Backspace', 'Delete', 'Enter']) {
    await page.press(key);
  }
  // Card deletion and the Inspector both go through async store updates.
  await new Promise((done) => setTimeout(done, 400));

  const after = await page.evaluate(`({
    cards: document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length,
    inspector: ${INSPECTOR_TOGGLE}?.getAttribute('aria-label'),
    activeTag: document.activeElement?.tagName ?? null,
    deletedNotice: Boolean(document.querySelector('[data-testid="card-deleted-notice"]')),
  })`);
  assert(
    after.cards === before.cards,
    `Backspace/Delete in ${where} must not delete a card: ${before.cards} -> ${after.cards}`,
  );
  assert(!after.deletedNotice, `no card-deleted notice may appear for keys in ${where}`);
  assert(
    after.inspector === before.inspector,
    `Return in ${where} must not open the Inspector: ${before.inspector} -> ${after.inspector}`,
  );
  assert(
    after.activeTag !== 'TEXTAREA',
    `Return in ${where} must not move focus into the card's Notes (focus: ${after.activeTag})`,
  );
}
