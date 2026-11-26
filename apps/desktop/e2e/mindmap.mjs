import { assertCardKeysStayInReader } from './cardKeys.mjs';
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

  // 2b. The excerpt selected its card, but Backspace, Delete, and Return pressed on
  // the reading page stay the reader's: the card survives and the Inspector stays
  // closed (#123).
  const plainText = await page.textRect(SEGMENT, 'lazy dog');
  await assertCardKeysStayInReader(page, plainText.end, 'the TXT page', {
    selector: '[data-testid="txt-scroll"]',
  });
  const readerFocus = await page.evaluate(
    `document.activeElement?.closest('[data-testid="txt-scroll"]') !== null`,
  );
  assert(readerFocus, 'clicking plain text should leave focus on the TXT page');

  // The same with the highlight's popover open, where a reader might press Delete to
  // remove the highlight: the card must survive (#123).
  const highlight = await page.textRect(SEGMENT, 'brown');
  assert(highlight, 'the excerpted text is still rendered');
  // The popover opens without taking focus; the page keeps it.
  await assertCardKeysStayInReader(page, highlight.start, 'the TXT highlight popover', {
    selector: '[data-testid="txt-scroll"]',
  });
  assert(
    await page.evaluate(`Boolean(document.querySelector('[data-reader-popover]'))`),
    "the highlight's popover should be open while the keys are pressed",
  );
  await page.press('Escape');

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
  // A deletion is never silent: a notice offers Undo, and the polite live region
  // that was mounted empty at startup announces it (#123).
  await page.waitFor(
    `(() => {
      const notice = document.querySelector('[data-testid="card-deleted-notice"]');
      const status = document.querySelector('[data-testid="card-deleted-status"]');
      return notice?.textContent?.includes('Card deleted') &&
        !notice.querySelector('[role="status"]') &&
        status?.getAttribute('role') === 'status' &&
        status.textContent === 'Card deleted';
    })()`,
    'a Card deleted notice after deleting from the context menu',
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

  // 10. With two cards (A selected, keyboard focus moved to B without selecting),
  // Backspace deletes focused card B and keeps A; and deleting a middle root among
  // three roots does not cause the next root excerpt to overlap the surviving third (#116).
  const excerptPhrase = async (phrase, expectedCount) => {
    await page.selectText(SEGMENT, phrase);
    await page.waitFor(
      `![...document.querySelectorAll('button')].find((b) => b.textContent.includes('Excerpt to MindMap')).disabled`,
      `Excerpt to MindMap to enable for ${phrase}`,
    );
    await page.clickButton('Excerpt to MindMap');
    await page.waitFor(
      `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === ${expectedCount}`,
      `card count to reach ${expectedCount}`,
    );
  };

  await excerptPhrase('quick brown fox', 1);
  await excerptPhrase('jumps over', 2);
  await excerptPhrase('lazy dog', 3);

  // Select first card, then move keyboard focus to the middle card without selecting it.
  await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})];
    nodes[0].click();
    nodes[1].focus();
  })()`);
  await page.press('Backspace');
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 2`,
    'Backspace to delete the focused middle card',
  );
  const survivingTitles = await page.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].map((el) => el.textContent ?? '')`,
  );
  assert(
    survivingTitles.some((text) => text.includes('quick brown fox')) &&
      survivingTitles.some((text) => text.includes('lazy dog')) &&
      !survivingTitles.some((text) => text.includes('jumps over')),
    `expected focused middle card to be deleted while keeping first and third, got: ${JSON.stringify(survivingTitles)}`,
  );

  // Excerpt another root: all three cards must occupy distinct canvas positions.
  await page.evaluate(`document.querySelector('.react-flow__pane')?.click()`);
  await excerptPhrase('jumps over', 3);
  const distinctPositions = await page.evaluate(`(() => {
    const transforms = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].map((el) => el.style.transform);
    return new Set(transforms).size;
  })()`);
  assert(
    distinctPositions === 3,
    `expected 3 distinct card positions after deleting middle root and excerpting again, got ${distinctPositions}`,
  );

  // 11. In Focus Mode with the overlay toolbar still expanded, deleting a card
  // shows the Undo notice below the toolbar so a real click hits Undo, not the toolbar.
  await page.clickButton('Enter focus mode');
  await page.waitFor(
    `document.querySelector('[data-testid="unified-toolbar"]')?.dataset.immersive === 'true'`,
    'focus mode to activate',
  );
  await page.clickButton('Show MindMap');
  await page.waitFor(
    `Boolean(document.querySelector('button[aria-label="Hide MindMap"]')) && Boolean(document.querySelector(${JSON.stringify(CARD_NODE)}))`,
    'MindMap to reopen in focus mode',
  );
  const focusCard = await cardCenter(page);
  assert(focusCard, 'card should be visible in reopened MindMap');
  await page.click(focusCard);
  await page.press('Backspace');
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 2`,
    'Backspace to delete the focused card in focus mode',
  );
  const hitCheck = await page.waitFor(
    `(() => {
      const toolbar = document.querySelector('[data-testid="unified-toolbar"]');
      const notice = document.querySelector('[data-testid="card-deleted-notice"]');
      if (!toolbar || !notice) return null;
      const undo = [...notice.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Undo');
      if (!undo) return null;
      const toolbarRect = toolbar.getBoundingClientRect();
      const noticeRect = notice.getBoundingClientRect();
      const undoRect = undo.getBoundingClientRect();
      if (undoRect.width === 0 || undoRect.height === 0) return null;
      const center = { x: undoRect.left + undoRect.width / 2, y: undoRect.top + undoRect.height / 2 };
      const topEl = document.elementFromPoint(center.x, center.y);
      return {
        toolbarHidden: toolbar.dataset.hidden === 'true',
        clearsToolbar: noticeRect.top >= toolbarRect.bottom,
        undoHit: undo.contains(topEl),
        hitTag: topEl?.tagName ?? null,
        hitLabel: topEl?.getAttribute('aria-label') ?? topEl?.textContent?.trim() ?? null,
        noticeTop: noticeRect.top,
        toolbarBottom: toolbarRect.bottom,
      };
    })()`,
    'card-deleted notice and Undo button in focus mode',
  );
  assert(
    !hitCheck.toolbarHidden,
    'expected the focus mode toolbar to still be expanded when Undo appeared',
  );
  assert(
    hitCheck.clearsToolbar && hitCheck.undoHit,
    `Undo in focus mode must sit below the expanded toolbar and receive pointer hits: ${JSON.stringify(hitCheck)}`,
  );
  await page.clickButton('Undo');
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 3`,
    'Undo click in focus mode to restore the deleted card',
  );
  await page.waitFor(
    `!document.querySelector('[data-testid="card-deleted-notice"]')`,
    'card-deleted notice to clear after Undo',
  );
  assert(await page.inFocusMode(), 'Undo should keep Focus Mode active');
  await page.clickButton('Exit focus mode');

  // 12. Issue #127: Jump to source (link and context menu) never sets the nesting target;
  // deliberately clicking a card shows "Excerpt under ‘<title>’" in the toolbar, popover,
  // and post-excerpt notice, and the reader can clear it without opening MindMap.
  const expectNoEdges = async (reason) => {
    const edgeCount = await page.evaluate(`document.querySelectorAll('.react-flow__edge').length`);
    assert(edgeCount === 0, `${reason}: expected 0 edges, got ${edgeCount}`);
  };
  await expectNoEdges('before jump-then-excerpt check');

  // 12a. Jump via the card's link button -> hide MindMap -> excerpt creates a root with no edge.
  await page.clickButton('Jump to source of quick brown fox');
  await page.clickButton('Hide MindMap');
  await page.selectText(SEGMENT, 'Pack my box');
  await page.waitFor(
    `(() => {
      const btn = document.querySelector('[data-testid="excerpt-button"]');
      return btn && !btn.disabled && btn.getAttribute('aria-label') === 'Excerpt to MindMap';
    })()`,
    'Excerpt button to stay root-targeted after Jump to source link',
  );
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-added-notice"]')?.textContent?.includes('Added to MindMap')`,
    'Added to MindMap notice after jump-link excerpt',
  );
  await page.clickButton('Show MindMap');
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 4`,
    '4th card after jump-link excerpt',
  );
  await expectNoEdges('after Jump to source link and excerpt');

  // 12b. Jump via card context menu -> excerpt creates a root with no edge.
  await page.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].find((n) =>
      n.textContent?.includes('Pack my box'),
    );
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
    'card context menu before Jump to Source',
  );
  await page.evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('Jump to Source'),
    );
    item?.click();
  })()`);
  await excerptPhrase('daft zebras', 5);
  await expectNoEdges('after context menu Jump to Source and excerpt');

  // 12c. Deliberately clicking a card body sets it as nesting target; toolbar, popover,
  // and notice all name it, and clearing from the reader toolbar works while MindMap is hidden.
  const packCardCenter = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].find((n) =>
      n.textContent?.includes('Pack my box'),
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 3, y: r.top + r.height / 2 };
  })()`);
  assert(packCardCenter, 'Pack my box card should be visible');
  await page.click(packCardCenter);
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label') === 'Excerpt under ‘Pack my box’'`,
    'toolbar Excerpt button to name the nesting target',
  );
  await page.selectText(SEGMENT, 'first section');
  await page.waitFor(
    `(() => {
      const btn = document.querySelector('[data-testid="popover-excerpt"]');
      const bar = document.querySelector('[data-testid="popover-nesting-target"]');
      return btn?.getAttribute('aria-label') === 'Excerpt under ‘Pack my box’' &&
        bar?.textContent?.includes('Pack my box');
    })()`,
    'selection popover to name the nesting target',
  );
  await page.clickButton('Hide MindMap');
  await page.evaluate(`document.querySelector('[data-testid="excerpt-button"]')?.click()`);
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-added-notice"]')?.textContent?.includes('Added under ‘Pack my box’')`,
    'post-excerpt notice to name the parent card',
  );

  // Clear the nesting target from the reader without opening the MindMap.
  await page.evaluate(
    `document.querySelector('[data-testid="clear-nesting-target-button"]')?.click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label') === 'Excerpt to MindMap' &&
     !document.querySelector('[data-testid="clear-nesting-target-button"]')`,
    'nesting target to clear from the reader toolbar',
  );
  await page.selectText(SEGMENT, 'Filler line 001');
  await page.waitFor(
    `!document.querySelector('[data-testid="excerpt-button"]').disabled`,
    'Excerpt button to enable for Filler line 001',
  );
  await page.clickButton('Excerpt to MindMap');
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-added-notice"]')?.textContent?.includes('Added to MindMap')`,
    'post-excerpt notice to return to Added to MindMap after clearing target',
  );
  await page.clickButton('Show MindMap');
  await page.waitFor(
    `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === 7 &&
     document.querySelectorAll('.react-flow__edge').length === 1`,
    'nested excerpt to have 1 edge and post-clear excerpt to remain a root',
  );

  // 13. Issue #128: Ten consecutive root excerpts never overlap and each is fully visible once revealed.
  const consecutivePhrases = [
    'Filler line 002',
    'Filler line 003',
    'Filler line 004',
    'Filler line 005',
    'Filler line 006',
    'Filler line 007',
    'Filler line 008',
    'Filler line 009',
    'Filler line 010',
    'Filler line 011',
  ];
  let expectedCount = 7;
  for (const phrase of consecutivePhrases) {
    expectedCount += 1;
    await excerptPhrase(phrase, expectedCount);
    await page.waitFor(
      `(() => {
        const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
        const card = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].find((n) =>
          n.textContent?.includes(${JSON.stringify(phrase)}),
        )?.getBoundingClientRect();
        if (!pane || !card || card.width === 0 || card.height === 0) return false;
        return card.left >= pane.left - 1 &&
          card.top >= pane.top - 1 &&
          card.right <= pane.right + 1 &&
          card.bottom <= pane.bottom + 1;
      })()`,
      `newly excerpted card "${phrase}" to be fully visible once revealed`,
    );
  }

  const overlapReport = await page.evaluate(`(() => {
    const rects = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? '').trim().slice(0, 24),
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      };
    });
    const overlaps = [];
    const eps = 0.5;
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i];
        const b = rects[j];
        if (
          a.left < b.right - eps &&
          a.right > b.left + eps &&
          a.top < b.bottom - eps &&
          a.bottom > b.top + eps
        ) {
          overlaps.push([a.text, b.text]);
        }
      }
    }
    return { count: rects.length, overlaps };
  })()`);
  assert(
    overlapReport.count === 17 && overlapReport.overlaps.length === 0,
    `expected 17 non-overlapping cards after 10 consecutive root excerpts, got ${JSON.stringify(overlapReport)}`,
  );
}
