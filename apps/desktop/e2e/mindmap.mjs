import { assert } from './harness.mjs';

// Issues #116–#120: empty canvas onboarding hint, opening Inspector from a card,
// debounced auto-save without blur, notes & tags on card faces, and card delete + Undo.
const SEGMENT = '[data-testid="txt-scroll"] [data-unit]';
const CARD_NODE = '.react-flow__node';
const visibleText = (text) =>
  `[...document.querySelectorAll(${JSON.stringify(SEGMENT)})].some((e) => e.checkVisibility({ visibilityProperty: true }) && e.textContent.includes(${JSON.stringify(text)}))`;

async function cardCenter(page) {
  return page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(CARD_NODE)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

export async function mindmapFlow(page) {
  // 1. Empty canvas shows onboarding hint with shortcut from command registry and hides MiniMap (#120).
  await page.clickButton('Show MindMap');
  await page.waitFor(
    `document.querySelector('[data-testid="mindmap-empty-hint"]')?.textContent?.includes('Excerpt to MindMap')`,
    'empty canvas onboarding hint',
  );
  assert(
    !(await page.evaluate(`Boolean(document.querySelector('.react-flow__minimap'))`)),
    'MiniMap should be hidden while the canvas is empty',
  );
  await page.assertContrast('[data-testid="mindmap-empty-hint"]', 'empty canvas hint');

  // 2. Open TXT sample and excerpt a phrase: hint disappears, card appears, Inspector stays collapsed (#119, #120).
  await page.openUntil(visibleText('quick brown fox'), 'the TXT sample');
  await page.selectText(SEGMENT, 'quick brown fox');
  await page.waitFor(
    `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`,
    'Excerpt to MindMap to enable',
  );
  await page.clickButton('Excerpt to MindMap');

  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 1`,
    'a MindMap card to appear after excerpting',
  );
  assert(
    !(await page.evaluate(`Boolean(document.querySelector('[data-testid="mindmap-empty-hint"]'))`)),
    'empty canvas hint should disappear once a card exists',
  );
  assert(
    await page.evaluate(
      `document.querySelector('button[aria-label="Show inspector"]')?.getAttribute('aria-pressed') === 'false'`,
    ),
    'excerpting should not auto-open the Inspector',
  );

  // 3. Double-clicking the card opens the Inspector and focuses Notes (#119).
  const center = await cardCenter(page);
  assert(center, 'card bounding box should exist');
  await page.multiClick(center, 2);
  await page.waitFor(
    `document.querySelector('button[aria-label="Hide inspector"]')?.getAttribute('aria-pressed') === 'true'`,
    'Inspector to open on card double-click',
  );
  await page.waitFor(
    `document.activeElement?.tagName === 'TEXTAREA'`,
    'Notes textarea to receive focus when opening Inspector from a card',
  );

  // 4. Typing notes persists via debounce without blurring and updates the card face (#117, #118).
  await page.typeText('Key idea: foxes are quick.');
  await page.waitFor(
    `document.querySelector('[data-testid="card-notes-preview"]')?.textContent?.includes('Key idea: foxes are quick.')`,
    'debounced notes to save and render on the card face without blur',
  );

  // 5. Typing tags also persists via debounce and renders tag chips on the card face (#117, #118).
  const tagsBox = await page.evaluate(`(() => {
    const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Tags'));
    const input = label?.querySelector('input');
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  assert(tagsBox, 'Tags input should be visible');
  await page.click(tagsBox);
  await page.typeText('animals, speed');
  await page.waitFor(
    `(() => {
      const tags = document.querySelector('[data-testid="card-tags"]')?.textContent ?? '';
      return tags.includes('animals') && tags.includes('speed');
    })()`,
    'debounced tags to save and render on the card face',
  );
  await page.assertContrast(CARD_NODE, 'card face with notes and tags');

  // 6. Esc in the Inspector returns focus to the card (#119).
  await page.press('Escape');
  await page.waitFor(
    `Boolean(document.activeElement?.closest(${JSON.stringify(CARD_NODE)}))`,
    'Escape in Inspector to return focus to the selected card',
  );

  // 7. Right-clicking the card opens context menu and Delete Card removes it (#116).
  const afterCenter = await cardCenter(page);
  assert(afterCenter, 'card should remain visible');
  await page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(CARD_NODE)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    }));
  })()`);
  await page.waitFor(
    `Boolean(document.querySelector('[data-testid="card-context-menu"]'))`,
    'card context menu to appear on right-click',
  );
  await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Delete Card'),
    );
    item?.click();
  })()`);
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 0`,
    'card to be deleted from context menu',
  );
  await page.waitFor(
    `Boolean(document.querySelector('[data-testid="mindmap-empty-hint"]'))`,
    'empty canvas hint to reappear after deleting the last card',
  );

  // 8. Undo (Ctrl/Cmd+Z) restores the card with its notes and tags intact (#116).
  await page.press('z', 'KeyZ', 2);
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 1`,
    'Undo to restore the deleted card',
  );
  await page.waitFor(
    `document.querySelector('[data-testid="card-notes-preview"]')?.textContent?.includes('Key idea: foxes are quick.') &&
     document.querySelector('[data-testid="card-tags"]')?.textContent?.includes('animals')`,
    'restored card to retain its notes and tags',
  );

  // 9. Selecting the card and pressing Backspace deletes it via keyboard (#116).
  const restoredCenter = await cardCenter(page);
  assert(restoredCenter, 'restored card should have bounds');
  await page.click(restoredCenter);
  await page.press('Backspace');
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 0`,
    'Backspace to delete the selected card',
  );
}
