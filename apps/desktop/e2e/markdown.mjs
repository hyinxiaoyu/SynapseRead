import { assert } from './harness.mjs';

// Issue #99: the picker and the drop overlay offer Markdown, so opening it must give a
// tab with readable, excerptable text, not a placeholder. The TXT engine reads it.
const SEGMENT = '[data-testid="txt-scroll"] [data-unit]';
const visibleText = (text) =>
  `[...document.querySelectorAll(${JSON.stringify(SEGMENT)})].some((e) => e.checkVisibility({ visibilityProperty: true }) && e.textContent.includes(${JSON.stringify(text)}))`;

export async function markdownFlow(page) {
  await page.clickButton('Show MindMap');
  await page.openUntil(visibleText('# Markdown sample'), 'the Markdown sample');
  assert(
    !(await page.evaluate(`document.body.textContent.includes('Markdown support arrives')`)),
    'a Markdown file opens the placeholder',
  );

  await page.selectText(SEGMENT, 'plain text');
  await page.waitFor(
    `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`,
    'a selection in the Markdown file to enable excerpting',
  );
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `[...document.querySelectorAll('[data-annotation-id]')].some((e) => e.textContent === 'plain text')`,
    'the Markdown excerpt to paint exactly the selected text',
  );
  await page.waitFor(
    `document.querySelector('[aria-label="Jump to source of plain text"]')`,
    'a card for the Markdown excerpt',
  );
}
