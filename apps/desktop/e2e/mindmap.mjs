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
  await page.clickButton('Jump to source of quick brown fox (sample · Line 6)');
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

  // Shared helpers for sections 14–16.
  const cardByText = (text) => `(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].find((n) =>
      n.textContent?.includes(${JSON.stringify(text)}),
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      id: el.dataset.id,
      selected: el.classList.contains('selected'),
      transform: el.style.transform,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    };
  })()`;

  const hasNestingEdge = (parentTitle, childTitle) =>
    page.evaluate(
      `Boolean(document.querySelector(${JSON.stringify(`[aria-label="‘${childTitle}’ nested under ‘${parentTitle}’"]`)}))`,
    );

  const countEdges = () => page.evaluate(`document.querySelectorAll('.react-flow__edge').length`);

  const countOverlaps = () =>
    page.evaluate(`(() => {
      const rects = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].map((el) => {
        const r = el.getBoundingClientRect();
        return {
          id: el.dataset.id,
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

  const excerptAny = async (phrase, expectedTotal) => {
    await page.selectText(SEGMENT, phrase);
    await page.waitFor(
      `!document.querySelector('[data-testid="excerpt-button"]').disabled`,
      `Excerpt button to enable for ${phrase}`,
    );
    await page.evaluate(`document.querySelector('[data-testid="excerpt-button"]').click()`);
    await page.waitFor(
      `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === ${expectedTotal}`,
      `card count to reach ${expectedTotal} after "${phrase}"`,
    );
  };

  const panCardIntoView = async (text) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const move = await page.evaluate(`(() => {
        const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
        const card = (${cardByText(text)});
        if (!pane || !card) return null;
        const margin = 24;
        const dx = card.left < pane.left + margin
          ? pane.left + 80 - card.left
          : card.left + card.width > pane.right - margin
            ? pane.right - 80 - (card.left + card.width)
            : 0;
        const dy = card.top < pane.top + margin
          ? pane.top + 80 - card.top
          : card.top + card.height > pane.bottom - margin
            ? pane.bottom - 80 - (card.top + card.height)
            : 0;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return null;
        // Find an empty point on the React Flow pane to pan from.
        const candidates = [
          { x: pane.left + pane.width / 2, y: pane.bottom - 16 },
          { x: pane.right - 20, y: pane.top + 20 },
          { x: pane.left + 20, y: pane.top + 20 },
          { x: pane.left + pane.width / 2, y: pane.top + 16 },
        ];
        const start =
          candidates.find((pt) =>
            document.elementFromPoint(pt.x, pt.y)?.classList.contains('react-flow__pane'),
          ) ?? candidates[0];
        const stepX = Math.max(-240, Math.min(240, dx));
        const stepY = Math.max(-240, Math.min(240, dy));
        return { from: start, to: { x: start.x + stepX, y: start.y + stepY } };
      })()`);
      if (!move) return;
      await page.drag(move.from, move.to);
    }
  };

  const waitTwoFrames = () =>
    page.evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    );

  const waitForViewportSettled = async () => {
    await page.evaluate(`delete window.__lastRfViewport`);
    await page.waitFor(
      `(() => {
        const vp = document.querySelector('.react-flow__viewport')?.style.transform ?? '';
        const prev = window.__lastRfViewport;
        window.__lastRfViewport = vp;
        return prev !== undefined && vp === prev;
      })()`,
      'MindMap viewport animation to settle',
    );
    await page.evaluate(`delete window.__lastRfViewport`);
  };

  // 14. Issue #127 (drag blocker): Dragging an unselected card with a real mouse updates
  // and persists its position without changing the nesting target (from both no-target
  // and A-is-target states).
  // Close Inspector first so MindMap has ample horizontal space and section 15 also
  // verifies double-click reopens Inspector from its collapsed state.
  if (
    await page.evaluate(
      `document.querySelector('button[aria-label="Hide inspector"]')?.getAttribute('aria-pressed') === 'true'`,
    )
  ) {
    await page.clickButton('Hide inspector');
    await page.waitFor(
      `document.querySelector('button[aria-label="Show inspector"]')?.getAttribute('aria-pressed') === 'false'`,
      'Inspector to collapse before drag checks',
    );
    await waitTwoFrames();
  }
  await waitForViewportSettled();
  let totalCards = 17;
  let totalEdges = await countEdges();
  assert(totalEdges === 1, `expected 1 edge entering section 14, got ${totalEdges}`);

  // 14a. Starting with no nesting target, drag unselected card B ("Filler line 010")
  // into empty canvas space to the right without colliding with any other card.
  await panCardIntoView('Filler line 010');
  await waitForViewportSettled();
  const cardBBeforeNoTarget = await page.evaluate(cardByText('Filler line 010'));
  assert(
    cardBBeforeNoTarget && !cardBBeforeNoTarget.selected,
    'Filler line 010 should be visible and unselected before dragging',
  );
  await page.drag(cardBBeforeNoTarget.center, {
    x: cardBBeforeNoTarget.center.x + 280,
    y: cardBBeforeNoTarget.center.y,
  });
  await page.waitFor(
    `(${cardByText('Filler line 010')})?.transform !== ${JSON.stringify(cardBBeforeNoTarget.transform)}`,
    'dragged card B transform to move',
  );
  const movedTransform1 = (await page.evaluate(cardByText('Filler line 010'))).transform;
  assert(
    (await page.evaluate(
      `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label')`,
    )) === 'Excerpt to MindMap',
    'dragging an unselected card must keep Excerpt to MindMap (no nesting target)',
  );
  totalCards += 1;
  await excerptAny('Filler line 012', totalCards);
  await waitForViewportSettled();
  assert(
    (await countEdges()) === totalEdges,
    'excerpt after dragging unselected card B with no target must remain a root card',
  );
  assert(
    (await page.evaluate(cardByText('Filler line 010'))).transform === movedTransform1,
    'dragged card B position must remain saved after excerpting',
  );

  // 14b. Starting with card A ("Filler line 011") as nesting target, drag unselected card B.
  await panCardIntoView('Filler line 011');
  await waitForViewportSettled();
  const cardAInfo = await page.evaluate(cardByText('Filler line 011'));
  assert(cardAInfo, 'card A (Filler line 011) should be visible');
  await page.click({ x: cardAInfo.left + 32, y: cardAInfo.center.y });
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label') === 'Excerpt under ‘Filler line 011’'`,
    'clicking card A to make it the nesting target',
  );
  await panCardIntoView('Filler line 010');
  await waitForViewportSettled();
  const cardBBeforeATarget = await page.evaluate(cardByText('Filler line 010'));
  assert(
    cardBBeforeATarget && !cardBBeforeATarget.selected,
    'card B should be unselected while card A is selected',
  );
  await page.drag(cardBBeforeATarget.center, {
    x: cardBBeforeATarget.center.x + 40,
    y: cardBBeforeATarget.center.y - 60,
  });
  await page.waitFor(
    `(${cardByText('Filler line 010')})?.transform !== ${JSON.stringify(cardBBeforeATarget.transform)}`,
    'dragged card B transform to update on second drag',
  );
  assert(
    (await page.evaluate(
      `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label')`,
    )) === 'Excerpt under ‘Filler line 011’',
    'dragging unselected card B must keep card A as the nesting target',
  );
  totalCards += 1;
  totalEdges += 1;
  await excerptAny('Filler line 013', totalCards);
  await waitForViewportSettled();
  await page.waitFor(
    `document.querySelectorAll('.react-flow__edge').length === ${totalEdges}`,
    'new edge under card A after dragging card B',
  );
  assert(
    await hasNestingEdge('Filler line 011', 'Filler line 013'),
    'excerpt after dragging unselected card B must still nest under card A',
  );

  // 15. Issue #127 (double-click blockers): independent double-click on A keeps A as target,
  // slow 760 ms double-click on B keeps A as target, and double-click on B with no target keeps none.
  const inspectorTitle = () =>
    page.evaluate(`(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Title'));
      return label?.querySelector('input')?.value ?? null;
    })()`);

  // Clear target first.
  await page.evaluate(
    `document.querySelector('[data-testid="clear-nesting-target-button"]')?.click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label') === 'Excerpt to MindMap'`,
    'target cleared before section 15',
  );

  // 15a. Click left side of card A, then immediately perform an independent double-click
  // ~96 px to the right on the same card A: Inspector opens for A and A stays target.
  await panCardIntoView('Filler line 011');
  await waitForViewportSettled();
  const cardAForClick = await page.evaluate(cardByText('Filler line 011'));
  await page.click({ x: cardAForClick.left + 28, y: cardAForClick.center.y });
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label') === 'Excerpt under ‘Filler line 011’'`,
    'single click on left of card A to set A as target',
  );
  const rightSpot = { x: cardAForClick.left + 124, y: cardAForClick.center.y };
  await page.multiClick(rightSpot, 2);
  await page.waitFor(
    `(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Title'));
      return label?.querySelector('input')?.value === 'Filler line 011';
    })()`,
    'independent double-click on A to edit A in Inspector',
  );
  assert(
    (await page.evaluate(
      `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label')`,
    )) === 'Excerpt under ‘Filler line 011’',
    'independent double-click on A must keep A as the nesting target',
  );

  // 15b. With A as target, send a slow double-click (760 ms between click 1 and click 2) on B:
  // Inspector edits B and the next excerpt still nests under A.
  await panCardIntoView('Filler line 010');
  await waitForViewportSettled();
  const cardBForSlowDbl = await page.evaluate(cardByText('Filler line 010'));
  await page.mouse('mouseMoved', cardBForSlowDbl.center.x, cardBForSlowDbl.center.y);
  await page.mouse('mousePressed', cardBForSlowDbl.center.x, cardBForSlowDbl.center.y, 'left', 1);
  await page.mouse('mouseReleased', cardBForSlowDbl.center.x, cardBForSlowDbl.center.y, 'left', 1);
  await new Promise((done) => setTimeout(done, 760));
  await page.mouse('mousePressed', cardBForSlowDbl.center.x, cardBForSlowDbl.center.y, 'left', 2);
  await page.mouse('mouseReleased', cardBForSlowDbl.center.x, cardBForSlowDbl.center.y, 'left', 2);
  await page.waitFor(
    `(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Title'));
      return label?.querySelector('input')?.value === 'Filler line 010';
    })()`,
    'slow 760 ms double-click on B to edit B in Inspector',
  );
  assert(
    (await page.evaluate(
      `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label')`,
    )) === 'Excerpt under ‘Filler line 011’',
    'slow 760 ms double-click on B must keep A as the nesting target',
  );
  totalCards += 1;
  totalEdges += 1;
  await excerptAny('Filler line 014', totalCards);
  await waitForViewportSettled();
  await page.waitFor(
    `document.querySelectorAll('.react-flow__edge').length === ${totalEdges}`,
    'new edge under A after slow double-click on B',
  );
  assert(
    await hasNestingEdge('Filler line 011', 'Filler line 014'),
    'excerpt after slow double-click on B must still nest under A',
  );

  // 15c. With no target, double-click B: Inspector edits B and the next excerpt is a root card.
  await page.evaluate(
    `document.querySelector('[data-testid="clear-nesting-target-button"]')?.click()`,
  );
  await page.waitFor(
    `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label') === 'Excerpt to MindMap'`,
    'target cleared before 15c',
  );
  await panCardIntoView('Filler line 010');
  await waitForViewportSettled();
  const cardBForRootDbl = await page.evaluate(cardByText('Filler line 010'));
  await page.multiClick(cardBForRootDbl.center, 2);
  assert(
    (await inspectorTitle()) === 'Filler line 010',
    'double-click on B with no target should open B in Inspector',
  );
  assert(
    (await page.evaluate(
      `document.querySelector('[data-testid="excerpt-button"]')?.getAttribute('aria-label')`,
    )) === 'Excerpt to MindMap',
    'double-click on B with no target must keep Excerpt to MindMap',
  );
  totalCards += 1;
  await excerptAny('Filler line 015', totalCards);
  await waitForViewportSettled();
  assert(
    (await countEdges()) === totalEdges,
    'excerpt after double-clicking B with no target must remain a root card',
  );

  // Close Inspector so Reader and MindMap have plenty of room for section 16.
  await page.clickButton('Hide inspector');

  // 16. Issue #128 (PDF capture thumbnail blocker): Delaying or failing a PDF capture
  // thumbnail never lets the capture card grow over a subsequent TXT root card, both
  // while the MindMap is expanded and while it is collapsed, and preserves saved coordinates.
  await page.openUntil(
    `[...document.querySelectorAll('[data-testid="pdf-scroll"]')].some((e) => e.checkVisibility({ visibilityProperty: true })) &&
     document.querySelector('[data-testid="unified-toolbar"] [data-testid="reader-toolbar-title"]')?.dataset.documentStem === 'sample'`,
    'sample.pdf for capture thumbnail placement check',
  );
  for (const other of ['sample-labels', 'sample-footnotes']) {
    await page.evaluate(
      `[...document.querySelectorAll('[aria-label="Close ${other}"]')].forEach((b) => b.click())`,
    );
  }
  await page.waitFor(
    `document.querySelector('[data-page-index="0"] canvas')?.width > 0`,
    'sample.pdf page 0 canvas to render',
  );

  const switchToViewer = async (viewerTestId) => {
    await page.evaluate(`(() => {
      const panel = document.querySelector('[data-testid="${viewerTestId}"]')?.closest('[role="tabpanel"]');
      const tabId = panel?.getAttribute('aria-labelledby');
      if (tabId) document.getElementById(tabId)?.click();
    })()`);
    await page.waitFor(
      `document.querySelector('[data-testid="${viewerTestId}"]')?.checkVisibility({ visibilityProperty: true })`,
      `${viewerTestId} tab to become visible`,
    );
  };

  const capturePdfArea = async (expectedTotal) => {
    await switchToViewer('pdf-viewer');
    await page.clickButton('Capture area');
    const box = await page.waitFor(
      `(() => {
        const surface = document.querySelector('[data-page-index="0"] [data-testid="pdf-capture-surface"]');
        if (!surface) return null;
        const r = surface.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return {
          from: { x: r.left + r.width * 0.2, y: r.top + r.height * 0.2 },
          to: { x: r.left + r.width * 0.5, y: r.top + r.height * 0.35 },
        };
      })()`,
      'PDF capture surface on page 0',
    );
    await page.drag(box.from, box.to);
    await page.waitFor(
      `!document.querySelector('[data-testid="excerpt-button"]').disabled`,
      'Excerpt button to enable for PDF capture',
    );
    await page.evaluate(`document.querySelector('[data-testid="excerpt-button"]').click()`);
    await page.waitFor(
      `document.querySelectorAll(${JSON.stringify(CARD_NODE)}).length === ${expectedTotal}`,
      `card count to reach ${expectedTotal} after PDF capture`,
    );
  };

  // Install a reversible thumbnail src gate on HTMLImageElement.prototype.
  await page.evaluate(`(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    window.__origImgSrcDesc = desc;
    window.__holdThumbnails = false;
    window.__heldThumbnails = [];
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      enumerable: desc.enumerable,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        if (
          window.__holdThumbnails &&
          this.dataset?.testid === 'card-capture-thumbnail' &&
          typeof value === 'string' &&
          value.startsWith('data:image/png')
        ) {
          window.__heldThumbnails.push({ img: this, value });
          return;
        }
        desc.set.call(this, value);
      },
    });
    window.__releaseThumbnails = () => {
      const descNow = window.__origImgSrcDesc;
      const pending = window.__heldThumbnails.splice(0);
      for (const item of pending) descNow.set.call(item.img, item.value);
      return pending.length;
    };
    window.__failThumbnails = () => {
      const descNow = window.__origImgSrcDesc;
      const pending = window.__heldThumbnails.splice(0);
      for (const item of pending) descNow.set.call(item.img, 'data:image/png;base64,invalid');
      return pending.length;
    };
  })()`);

  try {
    // 16a. MindMap EXPANDED: delay PDF capture thumbnail -> excerpt TXT root -> release -> verify zero overlap & preserved coordinates.
    await page.evaluate(`window.__holdThumbnails = true`);
    const idsBefore16a = await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].map((el) => el.dataset.id)`,
    );
    totalCards += 1;
    await capturePdfArea(totalCards);
    await page.waitFor(
      `window.__heldThumbnails.length >= 1`,
      'delayed capture thumbnail (expanded)',
    );
    const capture16a = await page.evaluate(`(() => {
      const before = new Set(${JSON.stringify(idsBefore16a)});
      const el = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].find((n) => !before.has(n.dataset.id));
      if (!el) return null;
      return { id: el.dataset.id, transform: el.style.transform, height: el.offsetHeight };
    })()`);
    assert(capture16a, 'expanded capture card should exist');

    await switchToViewer('txt-viewer');
    totalCards += 1;
    await excerptAny('Filler line 016', totalCards);

    await page.evaluate(`window.__releaseThumbnails()`);
    await page.waitFor(
      `(() => {
        const img = document.querySelector('.react-flow__node[data-id="${capture16a.id}"] [data-testid="card-capture-thumbnail"]');
        return Boolean(img && img.complete && img.naturalHeight > 0);
      })()`,
      'expanded capture thumbnail to decode',
    );
    await waitTwoFrames();

    const capture16aAfter = await page.evaluate(`(() => {
      const el = document.querySelector('.react-flow__node[data-id="${capture16a.id}"]');
      return { transform: el?.style.transform, height: el?.offsetHeight };
    })()`);
    assert(
      capture16aAfter.transform === capture16a.transform,
      `expanded capture card coordinates must not shift: ${capture16a.transform} vs ${capture16aAfter.transform}`,
    );
    assert(
      capture16aAfter.height === capture16a.height,
      `expanded capture card layout height must stay stable across thumbnail load: ${capture16a.height} vs ${capture16aAfter.height}`,
    );
    const overlaps16a = await countOverlaps();
    assert(
      overlaps16a.overlaps.length === 0,
      `expected 0 overlaps after expanded delayed PDF thumbnail loads, got ${JSON.stringify(overlaps16a)}`,
    );

    // 16b. MindMap COLLAPSED: create PDF capture + TXT root while collapsed -> expand -> release -> verify zero overlap & preserved coordinates.
    await page.clickButton('Hide MindMap');
    const idsBefore16b = await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].map((el) => el.dataset.id)`,
    );
    totalCards += 1;
    await capturePdfArea(totalCards);
    await switchToViewer('txt-viewer');
    totalCards += 1;
    await excerptAny('Filler line 017', totalCards);

    await page.clickButton('Show MindMap');
    await page.waitFor(
      `(() => {
        const before = new Set(${JSON.stringify(idsBefore16b)});
        const added = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].filter((n) => !before.has(n.dataset.id));
        return added.length === 2 && added.every((n) => n.offsetHeight > 0);
      })()`,
      'collapsed capture and TXT cards to render when MindMap opens',
    );
    const capture16b = await page.evaluate(`(() => {
      const before = new Set(${JSON.stringify(idsBefore16b)});
      const el = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].find(
        (n) => !before.has(n.dataset.id) && !n.textContent?.includes('Filler line 017'),
      );
      return el ? { id: el.dataset.id, transform: el.style.transform, height: el.offsetHeight } : null;
    })()`);
    assert(capture16b, 'collapsed capture card should exist');
    await page.evaluate(`window.__releaseThumbnails()`);
    await page.waitFor(
      `(() => {
        const img = document.querySelector('.react-flow__node[data-id="${capture16b.id}"] [data-testid="card-capture-thumbnail"]');
        return Boolean(img && img.complete && img.naturalHeight > 0);
      })()`,
      'collapsed capture thumbnail to decode after opening MindMap',
    );
    await waitTwoFrames();

    const capture16bAfter = await page.evaluate(`(() => {
      const el = document.querySelector('.react-flow__node[data-id="${capture16b.id}"]');
      return { transform: el?.style.transform, height: el?.offsetHeight };
    })()`);
    assert(
      capture16bAfter.transform === capture16b.transform,
      `collapsed capture card coordinates must not shift: ${capture16b.transform} vs ${capture16bAfter.transform}`,
    );
    assert(
      capture16bAfter.height === capture16b.height,
      `collapsed capture card layout height must stay stable across thumbnail load: ${capture16b.height} vs ${capture16bAfter.height}`,
    );
    const overlaps16b = await countOverlaps();
    assert(
      overlaps16b.overlaps.length === 0,
      `expected 0 overlaps after collapsed delayed PDF thumbnail loads, got ${JSON.stringify(overlaps16b)}`,
    );

    // 16c. Image load FAILURE path: delay PDF capture -> excerpt TXT root -> fail image -> verify fallback, stable height, and zero overlap.
    const idsBefore16c = await page.evaluate(
      `[...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].map((el) => el.dataset.id)`,
    );
    totalCards += 1;
    await capturePdfArea(totalCards);
    await page.waitFor(
      `window.__heldThumbnails.length >= 1`,
      'delayed capture thumbnail (failure path)',
    );
    const capture16c = await page.evaluate(`(() => {
      const before = new Set(${JSON.stringify(idsBefore16c)});
      const el = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})].find((n) => !before.has(n.dataset.id));
      return el ? { id: el.dataset.id, transform: el.style.transform, height: el.offsetHeight } : null;
    })()`);
    assert(capture16c, 'failure-path capture card should exist');

    await switchToViewer('txt-viewer');
    totalCards += 1;
    await excerptAny('Filler line 018', totalCards);

    await page.evaluate(`window.__failThumbnails()`);
    await page.waitFor(
      `Boolean(document.querySelector('.react-flow__node[data-id="${capture16c.id}"] [data-testid="card-capture-fallback"]'))`,
      'capture fallback to render when thumbnail fails to load',
    );
    await waitTwoFrames();

    const capture16cAfter = await page.evaluate(`(() => {
      const el = document.querySelector('.react-flow__node[data-id="${capture16c.id}"]');
      return { transform: el?.style.transform, height: el?.offsetHeight };
    })()`);
    assert(
      capture16cAfter.transform === capture16c.transform,
      `failed capture card coordinates must not shift: ${capture16c.transform} vs ${capture16cAfter.transform}`,
    );
    assert(
      capture16cAfter.height === capture16c.height,
      `failed capture card layout height must stay stable across fallback: ${capture16c.height} vs ${capture16cAfter.height}`,
    );
    const overlaps16c = await countOverlaps();
    assert(
      overlaps16c.overlaps.length === 0,
      `expected 0 overlaps after failed PDF thumbnail fallback, got ${JSON.stringify(overlaps16c)}`,
    );
  } finally {
    await page.evaluate(`(() => {
      window.__holdThumbnails = false;
      if (window.__origImgSrcDesc) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', window.__origImgSrcDesc);
        delete window.__origImgSrcDesc;
      }
      delete window.__heldThumbnails;
      delete window.__releaseThumbnails;
      delete window.__failThumbnails;
    })()`);
  }

  // 17. Issue #125: Cards and Inspector Excerpts show which document and place each card
  // came from across multiple documents without opening the Inspector or inspecting anchors.
  await page.openUntil(visibleText('Arrival line 01'), 'sample-chapters.txt for #125');
  await page.selectText(SEGMENT, 'Arrival line 01');
  await page.waitFor(
    `!document.querySelector('[data-testid="excerpt-button"]').disabled`,
    'Excerpt button to enable for sample-chapters.txt',
  );
  await page.evaluate(`document.querySelector('[data-testid="excerpt-button"]').click()`);
  await page.waitFor(
    `[...document.querySelectorAll('[data-testid="card-source-attribution"]')].some(
      (el) => el.textContent?.includes('sample-chapters') && el.textContent?.includes('Line 17'),
    )`,
    'second document card face to show document title and chapter/line location',
  );

  // Both documents' cards show their source on the card face while Inspector stays closed.
  const attributionState = await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})];
    const foxCard = cards.find((n) => n.textContent?.includes('quick brown fox'));
    const arrivalCard = cards.find((n) => n.textContent?.includes('Arrival line 01'));
    const captureCard = cards.find((n) => n.textContent?.includes('Figure ·'));
    const describe = (node) => {
      if (!node) return null;
      const src = node.querySelector('[data-testid="card-source-attribution"]');
      const btn = node.querySelector('button[aria-label^="Jump to source of"]');
      const style = src ? getComputedStyle(src) : null;
      return {
        source: src?.textContent ?? null,
        titleAttr: src?.getAttribute('title') ?? null,
        jumpLabel: btn?.getAttribute('aria-label') ?? null,
        truncated: Boolean(
          style &&
            style.overflow === 'hidden' &&
            style.textOverflow === 'ellipsis' &&
            style.whiteSpace === 'nowrap',
        ),
      };
    };
    return {
      inspectorOpen:
        document.querySelector('button[aria-label="Hide inspector"]')?.getAttribute('aria-pressed') ===
        'true',
      fox: describe(foxCard),
      arrival: describe(arrivalCard),
      capture: describe(captureCard),
    };
  })()`);
  assert(
    !attributionState.inspectorOpen,
    'Inspector should still be closed when checking card faces',
  );
  assert(
    attributionState.fox?.source === 'sample · Line 6' &&
      attributionState.fox.truncated &&
      attributionState.fox.jumpLabel === 'Jump to source of quick brown fox (sample · Line 6)',
    `unexpected sample.txt card attribution: ${JSON.stringify(attributionState.fox)}`,
  );
  assert(
    attributionState.arrival?.source === 'sample-chapters · CHAPTER I: ARRIVAL · Line 17' &&
      attributionState.arrival.truncated &&
      attributionState.arrival.titleAttr === 'sample-chapters · CHAPTER I: ARRIVAL · Line 17' &&
      attributionState.arrival.jumpLabel ===
        'Jump to source of Arrival line 01 (sample-chapters · CHAPTER I: ARRIVAL · Line 17)',
    `unexpected sample-chapters.txt card attribution: ${JSON.stringify(attributionState.arrival)}`,
  );
  assert(
    Boolean(attributionState.capture?.source?.includes('p. 1')) &&
      attributionState.capture?.truncated,
    `unexpected PDF capture card attribution: ${JSON.stringify(attributionState.capture)}`,
  );
  await page.assertContrast(
    '[data-testid="card-source-attribution"]',
    'card source attribution line',
  );

  // Opening the Inspector on the second document's card shows the full source in Excerpts.
  await page.clickButton('Show inspector');
  await page.waitFor(
    `document.querySelector('[data-testid="inspector-excerpt-source"]')?.textContent === 'sample-chapters · CHAPTER I: ARRIVAL · Line 17'`,
    'Inspector excerpt row to show full document title and location',
  );
  const inspectorJumpLabel = await page.evaluate(
    `document.querySelector('[data-testid="inspector-excerpt-row"] button')?.getAttribute('aria-label')`,
  );
  assert(
    inspectorJumpLabel === 'Jump to this excerpt (sample-chapters · CHAPTER I: ARRIVAL · Line 17)',
    `unexpected Inspector jump button label: ${inspectorJumpLabel}`,
  );
  await page.assertContrast(
    '[data-testid="inspector-excerpt-source"]',
    'Inspector excerpt source attribution',
  );

  // Close Inspector so canvas chrome, keyboard movement, and screen reader labels are unobstructed.
  await page.clickButton('Hide inspector');
  await page.waitFor(
    `document.querySelector('button[aria-label="Show inspector"]')?.getAttribute('aria-pressed') === 'false'`,
    'Inspector to close before section 18',
  );
  await waitTwoFrames();

  // 18. Issues #184, #182, and #185:
  //   - #184: Canvas controls, minimap, attribution, and links follow system Dark Mode with AA/non-text contrast.
  //   - #182: Arrow-key and Shift+arrow-key moves coalesce into one updateNodeLayout write and flush before close.
  //   - #185: Cards and links have title-based accessible names (never IDs) and accurate keyboard descriptions.
  const probeCanvasChrome = () =>
    page.evaluate(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = (color) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a / 255 };
      };
      const over = (top, bottom) => ({
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
        a: 1,
      });
      const backdrop = (el) => {
        const layers = [];
        for (let node = el; node; node = node.parentElement) {
          const layer = rgba(getComputedStyle(node).backgroundColor);
          if (layer.a > 0) layers.push(layer);
          if (layer.a >= 1) break;
        }
        return layers.reduceRight((below, layer) => over(layer, below), { r: 255, g: 255, b: 255, a: 1 });
      };
      const lum = ({ r, g, b }) => {
        const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ratio = (a, b) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
      };
      const flow = document.querySelector('.react-flow');
      const flowBg = backdrop(flow);
      const buttons = [...document.querySelectorAll('.react-flow__controls-button:not(:disabled)')].map((btn) => {
        const bg = backdrop(btn);
        const svg = btn.querySelector('svg');
        const fill = over(rgba(getComputedStyle(svg).fill), bg);
        return {
          label: btn.getAttribute('aria-label'),
          bg,
          bgLum: lum(bg),
          iconRatio: ratio(fill, bg),
        };
      });
      const minimap = document.querySelector('.react-flow__minimap');
      const minimapBg = minimap ? backdrop(minimap) : null;
      const edgePath = document.querySelector('.react-flow__edge-path');
      const edgeStroke = edgePath ? over(rgba(getComputedStyle(edgePath).stroke), flowBg) : null;
      return {
        darkClass: flow?.classList.contains('dark') ?? false,
        lightClass: flow?.classList.contains('light') ?? false,
        flowBg,
        flowBgLum: lum(flowBg),
        buttons,
        minimapBgLum: minimapBg ? lum(minimapBg) : null,
        edgeRatio: edgeStroke ? ratio(edgeStroke, flowBg) : null,
      };
    })()`);

  // 18a. Light mode canvas chrome contrast baseline (#184).
  await page.assertContrast('.react-flow__attribution', 'MindMap attribution (Light)');
  const lightChrome = await probeCanvasChrome();
  assert(
    lightChrome.lightClass &&
      !lightChrome.darkClass &&
      lightChrome.buttons.length >= 3 &&
      lightChrome.buttons.every((b) => b.iconRatio >= 3) &&
      lightChrome.edgeRatio !== null &&
      lightChrome.edgeRatio >= 3,
    `Light mode MindMap chrome contrast failed: ${JSON.stringify(lightChrome)}`,
  );

  // 18b. Emulated system Dark Mode canvas chrome (#184).
  await page.emulateMedia([{ name: 'prefers-color-scheme', value: 'dark' }]);
  try {
    await page.waitFor(
      `document.querySelector('.react-flow')?.classList.contains('dark')`,
      'ReactFlow to switch to dark mode under prefers-color-scheme: dark',
    );
    await page.assertContrast('.react-flow__attribution', 'MindMap attribution (Dark)');
    await page.assertContrast(CARD_NODE, 'MindMap cards (Dark)');
    const darkChrome = await probeCanvasChrome();
    assert(
      darkChrome.darkClass &&
        darkChrome.flowBgLum < 0.05 &&
        darkChrome.minimapBgLum !== null &&
        darkChrome.minimapBgLum < 0.1 &&
        darkChrome.buttons.length >= 3 &&
        darkChrome.buttons.every(
          (b) => b.bgLum < 0.15 && b.bgLum > darkChrome.flowBgLum && b.iconRatio >= 3,
        ) &&
        darkChrome.edgeRatio !== null &&
        darkChrome.edgeRatio >= 3,
      `Dark mode MindMap chrome failed contrast or surface checks: ${JSON.stringify(darkChrome)}`,
    );
  } finally {
    await page.emulateMedia([{ name: 'prefers-color-scheme', value: 'light' }]);
    await page.waitFor(
      `document.querySelector('.react-flow')?.classList.contains('light')`,
      'ReactFlow to return to light mode',
    );
  }

  // 18c. Accessible names and keyboard descriptions on cards and links (#185).
  const a11yReport = await page.evaluate(`(() => {
    const cards = [...document.querySelectorAll(${JSON.stringify(CARD_NODE)})];
    const nestedCard = cards.find((n) => n.textContent?.includes('Filler line 013'));
    const edges = [...document.querySelectorAll('.react-flow__edge')];
    const nestingEdge = edges.find((e) =>
      e.getAttribute('aria-label') === '‘Filler line 013’ nested under ‘Filler line 011’',
    );
    const nodeDescId = nestedCard?.getAttribute('aria-describedby') ?? null;
    const edgeDescId = nestingEdge?.getAttribute('aria-describedby') ?? null;
    return {
      cardId: nestedCard?.dataset.id ?? null,
      cardLabel: nestedCard?.getAttribute('aria-label') ?? null,
      cardDesc: nodeDescId ? document.getElementById(nodeDescId)?.textContent ?? null : null,
      edgeLabel: nestingEdge?.getAttribute('aria-label') ?? null,
      edgeDesc: edgeDescId ? document.getElementById(edgeDescId)?.textContent ?? null : null,
      unnamedCards: cards.filter((n) => !(n.getAttribute('aria-label') ?? '').trim()).length,
      idNamedEdges: edges.filter((e) => (e.getAttribute('aria-label') ?? '').startsWith('Edge from ')).length,
    };
  })()`);
  assert(
    a11yReport.unnamedCards === 0 &&
      a11yReport.idNamedEdges === 0 &&
      Boolean(a11yReport.cardLabel?.startsWith('Card: Filler line 013')) &&
      Boolean(a11yReport.cardLabel?.includes('from sample · Line')) &&
      Boolean(a11yReport.cardLabel?.includes('nested under ‘Filler line 011’')) &&
      !a11yReport.cardLabel?.includes(a11yReport.cardId) &&
      a11yReport.edgeLabel === '‘Filler line 013’ nested under ‘Filler line 011’' &&
      Boolean(a11yReport.cardDesc?.includes('to edit card')) &&
      Boolean(a11yReport.cardDesc?.includes('Space to make it the target for the next excerpt')) &&
      Boolean(a11yReport.cardDesc?.includes('arrow keys to move it')) &&
      Boolean(a11yReport.cardDesc?.includes('to delete it')) &&
      Boolean(a11yReport.edgeDesc?.includes('to select this link')) &&
      Boolean(a11yReport.edgeDesc?.includes('to remove it')),
    `unexpected MindMap accessibility report: ${JSON.stringify(a11yReport)}`,
  );

  // 18d. Keyboard arrow movement persists via memory backend, coalesces bursts,
  // keeps mouse drag as one write, and flushes immediately before close (#182).
  await panCardIntoView('Filler line 010');
  await waitForViewportSettled();
  const arrowTarget = await page.evaluate(cardByText('Filler line 010'));
  assert(arrowTarget, 'Filler line 010 should be visible before arrow-key movement test');
  await page.click({ x: arrowTarget.left + 28, y: arrowTarget.center.y });
  await page.waitFor(
    `document.activeElement?.closest('.react-flow__node')?.dataset.id === ${JSON.stringify(arrowTarget.id)}`,
    'Filler line 010 card to receive focus before arrow moves',
  );

  const parseTranslate = (transform) => {
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(transform ?? '');
    assert(match, `unexpected transform: ${transform}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const startCoords = parseTranslate(arrowTarget.transform);
  const writesBeforeBurst = await page.evaluate(
    `window.__synapsePreview.getNodeLayoutWrites().length`,
  );

  // Burst: 4x ArrowDown (+20y) + 1x Shift+ArrowRight (+20x) -> 1 coalesced write.
  const SHIFT = 8;
  await page.press('ArrowDown');
  await page.press('ArrowDown');
  await page.press('ArrowDown');
  await page.press('ArrowDown');
  await page.press('ArrowRight', 'ArrowRight', SHIFT);

  await page.waitFor(
    `window.__synapsePreview.getNodeLayoutWrites().length === ${writesBeforeBurst + 1}`,
    'debounced updateNodeLayout write after arrow-key burst',
  );
  // Allow an extra debounce interval to verify no duplicate write occurs.
  await new Promise((done) => setTimeout(done, 400));
  const burstWrites = await page.evaluate(
    `window.__synapsePreview.getNodeLayoutWrites().slice(${writesBeforeBurst})`,
  );
  assert(
    burstWrites.length === 1 &&
      burstWrites[0].nodeId === arrowTarget.id &&
      Math.round(burstWrites[0].posX) === Math.round(startCoords.x + 20) &&
      Math.round(burstWrites[0].posY) === Math.round(startCoords.y + 20),
    `expected 1 coalesced write at (+20, +20), got: ${JSON.stringify({ startCoords, burstWrites })}`,
  );

  // Mouse drag still produces exactly one write on release.
  const writesBeforeDrag = await page.evaluate(
    `window.__synapsePreview.getNodeLayoutWrites().length`,
  );
  const beforeDrag = await page.evaluate(cardByText('Filler line 010'));
  await page.drag(beforeDrag.center, { x: beforeDrag.center.x + 24, y: beforeDrag.center.y + 12 });
  await page.waitFor(
    `window.__synapsePreview.getNodeLayoutWrites().length === ${writesBeforeDrag + 1}`,
    'mouse drag to persist layout on release',
  );
  await new Promise((done) => setTimeout(done, 400));
  const dragWrites = await page.evaluate(
    `window.__synapsePreview.getNodeLayoutWrites().slice(${writesBeforeDrag})`,
  );
  assert(
    dragWrites.length === 1 && dragWrites[0].nodeId === arrowTarget.id,
    `expected mouse drag to produce exactly 1 layout write, got ${JSON.stringify(dragWrites)}`,
  );

  // A keyboard move right before quitting flushes immediately via onBeforeClose.
  const afterDrag = await page.evaluate(cardByText('Filler line 010'));
  const beforeQuitCoords = parseTranslate(afterDrag.transform);
  const writesBeforeQuit = await page.evaluate(
    `window.__synapsePreview.getNodeLayoutWrites().length`,
  );
  await page.evaluate(
    `document.querySelector('.react-flow__node[data-id="${arrowTarget.id}"]')?.focus()`,
  );
  await page.press('ArrowUp');
  await page.evaluate(`window.__synapsePreview.triggerBeforeClose()`);
  const quitWritesImmediate = await page.evaluate(
    `window.__synapsePreview.getNodeLayoutWrites().slice(${writesBeforeQuit})`,
  );
  assert(
    quitWritesImmediate.length === 1 &&
      quitWritesImmediate[0].nodeId === arrowTarget.id &&
      Math.round(quitWritesImmediate[0].posX) === Math.round(beforeQuitCoords.x) &&
      Math.round(quitWritesImmediate[0].posY) === Math.round(beforeQuitCoords.y - 5),
    `expected pre-quit flush to save ArrowUp move immediately, got ${JSON.stringify({ beforeQuitCoords, quitWritesImmediate })}`,
  );
  await new Promise((done) => setTimeout(done, 400));
  const quitWritesAfterWait = await page.evaluate(
    `window.__synapsePreview.getNodeLayoutWrites().slice(${writesBeforeQuit})`,
  );
  assert(
    quitWritesAfterWait.length === 1,
    `expected no duplicate write after pre-quit flush, got ${JSON.stringify(quitWritesAfterWait)}`,
  );
}
