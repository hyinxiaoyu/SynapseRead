import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PageGestureSample, WheelSample } from '@/features/reader/paging/pageTurn';
import { DEFAULT_READING_PREFERENCES } from '@/types/domain';
import {
  decorateWithNoteMarker,
  type EpubCodeBlockHover,
  type EpubFramePointerUp,
  type EpubSelection,
  openEpubDocument,
  type PaneMark,
  type RenditionAnnotation,
  resolveChapterLink,
} from './epubEngine';

/**
 * jsdom cannot host epub.js, so the book and rendition are a fake that reproduces the
 * timing that made jumps disappear (#41): `display()` resolves the in-flight display
 * as soon as a newer one replaces it, the reported location lags by a frame, and a
 * resize re-displays whatever location was reported last. The engine's own
 * navigation rules are the subject here; `pnpm e2e` drives the real epub.js.
 */
const fake = vi.hoisted(() => {
  const chapters = [
    { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
    // A second position in the same chapter: a jump here never changes the href.
    { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/4/1:4)' },
    { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
  ];
  interface Pending {
    target: string | undefined;
    resolve: () => void;
  }
  interface LocationState {
    start: { href: string; cfi: string };
  }
  interface FakeContents {
    document: Document;
    window: Window;
    cfiFromRange: (range: Range) => string;
    expand: ReturnType<typeof vi.fn<() => void>>;
  }
  interface SpineSection {
    href: string;
    document?: Document;
  }
  const spineItems: SpineSection[] = [{ href: 'chapter1.xhtml' }, { href: 'chapter2.xhtml' }];
  const state = {
    displays: [] as (string | undefined)[],
    resizes: [] as (number | string | undefined)[][],
    contents: [] as FakeContents[],
    views: [] as { _needsReframe?: boolean }[],
    pending: [] as Pending[],
    spineHooks: [] as ((chapter: Document) => void)[],
    renditionHooks: [] as ((contents: FakeContents) => void)[],
    listeners: {} as Record<string, (...args: unknown[]) => void>,
  };
  const hrefOf = (target: string | undefined) =>
    chapters.find((chapter) => chapter.href === target || chapter.cfi === target)?.href;
  const sectionOf = (target: string | undefined) => {
    const found = chapters.find((chapter) => chapter.href === target || chapter.cfi === target);
    if (!found) return null;
    const index = spineItems.findIndex((item) => item.href === found.href);
    return { index, href: found.href };
  };
  /** Resolves the pending display for `target`, as a rendered chapter would. */
  const settle = (target: string | undefined, contents = 1) => {
    const index = state.pending.findIndex((entry) => entry.target === target);
    const entry = index === -1 ? undefined : state.pending.splice(index, 1)[0];
    if (!entry) throw new Error(`no pending display for ${String(target)}`);
    const href = hrefOf(target);
    if (href) rendition.location = { start: { href, cfi: target ?? '' } };
    const spineSection = href ? spineItems.find((item) => item.href === href) : undefined;
    // Matches `epubjs/src/section.js`: `book.spine.hooks.content` runs only on the
    // first parse of a section; later re-renders clone/serialize cached `document`.
    if (spineSection && !spineSection.document) {
      const parsed = document.implementation.createHTMLDocument('');
      parsed.body.innerHTML = '<p>Sample chapter text</p>';
      for (const hook of state.spineHooks) hook(parsed);
      spineSection.document = parsed;
    }
    state.views = Array.from({ length: contents }, () => ({ _needsReframe: false }));
    state.contents = Array.from({ length: contents }, () => {
      const frameDoc = document.implementation.createHTMLDocument('');
      if (spineSection?.document) {
        frameDoc.documentElement.innerHTML = spineSection.document.documentElement.innerHTML;
      }
      const item: FakeContents = {
        document: frameDoc,
        window,
        // epub.js computes the CFI of a range from the chapter's base; the fake
        // returns the chapter's start, which is all the selection tests need.
        cfiFromRange: () => chapters.find((chapter) => chapter.href === href)?.cfi ?? '',
        expand: vi.fn<() => void>(),
      };
      for (const hook of state.renditionHooks) hook(item);
      return item;
    });
    entry.resolve();
  };
  const rendition = {
    location: undefined as LocationState | undefined,
    hooks: {
      content: {
        register: (hook: (contents: FakeContents) => void) => {
          state.renditionHooks.push(hook);
        },
      },
    },
    q: {
      enqueue: (task: () => unknown) =>
        Promise.resolve()
          .then(() => task())
          .then(() => undefined),
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      state.listeners[event] = listener;
    },
    getContents: () => state.contents,
    views: () => state.views,
    display: (target?: string) => {
      state.displays.push(target);
      // epub.js: a newer display resolves the one it replaces, landing or not.
      state.pending.shift()?.resolve();
      return new Promise<void>((resolve) => state.pending.push({ target, resolve }));
    },
    next: () => Promise.resolve(),
    prev: () => Promise.resolve(),
    flow: () => undefined,
    spread: () => undefined,
    clear: () => {
      state.contents = [];
      state.views = [];
    },
    resize: (width?: number, height?: number, epubcfi?: string) => {
      state.resizes.push([width, height, epubcfi]);
      // epub.js: `manager.resize` clears views; `onResized` only re-displays when
      // `this.location && this.location.start` is truthy (`rendition.js` L479-481).
      state.contents = [];
      state.views = [];
      if (rendition.location?.start) {
        const target =
          typeof epubcfi === 'string' && epubcfi.length > 0
            ? epubcfi
            : rendition.location.start.cfi;
        void rendition.display(target);
      }
    },
    annotations: {
      // Returns an annotation with no mark yet, as epub.js does before a chapter renders.
      add: vi.fn<(...args: unknown[]) => { mark: undefined; on: () => undefined }>(() => ({
        mark: undefined,
        on: () => undefined,
      })),
      underline: () => undefined,
      highlight: () => undefined,
      remove: () => undefined,
    },
    destroy: () => undefined,
  };
  const book = {
    ready: Promise.resolve(),
    packaging: {},
    navigation: { toc: [] },
    spine: {
      hooks: {
        content: {
          register: (hook: (chapter: Document) => void) => {
            state.spineHooks.push(hook);
          },
        },
      },
      spineItems,
      get: sectionOf,
    },
    renderTo: () => rendition,
    load: () => Promise.resolve(),
    destroy: () => undefined,
  };
  return { state, settle, rendition, book, spineItems };
});

vi.mock('epubjs', () => ({ default: () => fake.book }));

/** jsdom's animation frames do not reliably tick here, and the engine waits on one. */
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  setTimeout(() => callback(0), 0),
);

describe('EPUB navigation', () => {
  beforeEach(() => {
    fake.state.displays = [];
    fake.state.resizes = [];
    fake.state.pending = [];
    fake.state.contents = [];
    fake.state.views = [];
    fake.state.spineHooks = [];
    fake.state.renditionHooks = [];
    fake.state.listeners = {};
    for (const item of fake.spineItems) {
      delete item.document;
    }
    fake.rendition.location = undefined;
  });

  const open = async () => {
    fake.rendition.location = { start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' } };
    return openEpubDocument(
      { kind: 'bytes', bytes: new Uint8Array() },
      document.createElement('div'),
    );
  };

  it('lets a newer jump supersede one that has not landed yet', async () => {
    const handle = await open();
    const first = handle.display('chapter1.xhtml');
    const second = handle.display('epubcfi(/6/4!/4/2/1:0)');
    // epub.js resolves `first` here; the engine must not repair it over `second`.
    fake.settle('epubcfi(/6/4!/4/2/1:0)');
    await Promise.all([first, second]);
    expect(fake.state.displays).toEqual(['chapter1.xhtml', 'epubcfi(/6/4!/4/2/1:0)']);
    expect(fake.rendition.location?.start.href).toBe('chapter2.xhtml');
  });

  /** Opens the book and settles on Chapter One, with a rendered chapter document. */
  const renderedChapter = async () => {
    const handle = await open();
    const jump = handle.display('epubcfi(/6/2!/4/2/1:0)');
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await jump;
    const contents = fake.state.contents.at(-1);
    if (!contents) throw new Error('no rendered chapter');
    return { handle, contents };
  };

  const selectionOf = (text: string) =>
    ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => document.createRange(),
      toString: () => text,
    }) as unknown as Selection;

  it('reports the settled selection on release, not the partial one epub.js debounced', async () => {
    const { handle, contents } = await renderedChapter();
    const seen: (EpubSelection | null)[] = [];
    handle.onSelection((selection) => seen.push(selection));

    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf('汉字'));
    try {
      contents.document.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
      expect(seen.at(-1)).toEqual({
        cfiRange: 'epubcfi(/6/2!/4/2/1:0)',
        chapterHref: 'chapter1.xhtml',
        text: '汉字',
      });
      // epub.js' 250 ms debounce reports the same range again; it must not look
      // like a fresh selection that re-opens a popover the reader dismissed.
      fake.state.listeners.selected?.('epubcfi(/6/2!/4/2/1:0)', contents);
      expect(seen).toHaveLength(1);
    } finally {
      getSelection.mockRestore();
    }
  });

  it('resolves chapterLabel by DOM order when multiple TOC #fragments share one XHTML file (#125)', async () => {
    const previousToc = fake.book.navigation.toc;
    (
      fake.book.navigation as {
        toc: { id: string; label: string; href: string; subitems?: unknown[] }[];
      }
    ).toc = [
      { id: 'ch1', label: 'Chapter One: Arrival', href: 'chapter1.xhtml#arrival', subitems: [] },
      {
        id: 'ch2',
        label: 'Chapter Two: Departure',
        href: 'chapter1.xhtml#departure',
        subitems: [],
      },
    ];
    try {
      const { handle, contents } = await renderedChapter();
      contents.document.body.innerHTML = `
        <section id="arrival"><h1>Chapter One: Arrival</h1><p>Arrival passage text.</p></section>
        <section id="departure"><h1>Chapter Two: Departure</h1><p>Departure passage text.</p></section>
      `;
      const seen: (EpubSelection | null)[] = [];
      handle.onSelection((selection) => seen.push(selection));

      const rangeFor = (needle: string): Range => {
        const walker = contents.document.createTreeWalker(
          contents.document.body,
          NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? '';
          const idx = text.indexOf(needle);
          if (idx !== -1) {
            const range = contents.document.createRange();
            range.setStart(node, idx);
            range.setEnd(node, idx + needle.length);
            return range;
          }
        }
        throw new Error(`Missing text: ${needle}`);
      };

      const arrivalRange = rangeFor('Arrival passage');
      const departureRange = rangeFor('Departure passage');

      const getSelection = vi.spyOn(window, 'getSelection');
      try {
        getSelection.mockReturnValue({
          isCollapsed: false,
          rangeCount: 1,
          getRangeAt: () => arrivalRange,
          toString: () => 'Arrival passage',
        } as unknown as Selection);
        contents.document.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
        expect(seen.at(-1)).toEqual({
          cfiRange: 'epubcfi(/6/2!/4/2/1:0)',
          chapterHref: 'chapter1.xhtml',
          text: 'Arrival passage',
          chapterLabel: 'Chapter One: Arrival',
        });

        getSelection.mockReturnValue({
          isCollapsed: false,
          rangeCount: 1,
          getRangeAt: () => departureRange,
          toString: () => 'Departure passage',
        } as unknown as Selection);
        contents.document.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
        expect(seen.at(-1)).toEqual({
          cfiRange: 'epubcfi(/6/2!/4/2/1:0)',
          chapterHref: 'chapter1.xhtml',
          text: 'Departure passage',
          chapterLabel: 'Chapter Two: Departure',
        });

        // Also verified through epub.js' debounced `selected` event path.
        fake.state.listeners.selected?.('epubcfi(/6/2!/4/4/1:4)', contents);
        expect(seen.at(-1)).toEqual({
          cfiRange: 'epubcfi(/6/2!/4/4/1:4)',
          chapterHref: 'chapter1.xhtml',
          text: 'Departure passage',
          chapterLabel: 'Chapter Two: Departure',
        });

        // When a fragment target is missing from the XHTML, fail closed to null (book title only).
        contents.document.getElementById('departure')?.removeAttribute('id');
        contents.document.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
        expect(seen.at(-1)?.chapterLabel).toBeNull();
      } finally {
        getSelection.mockRestore();
      }
    } finally {
      fake.book.navigation.toc = previousToc;
    }
  });

  it('does not report a click inside the selection as a new one', async () => {
    const { handle, contents } = await renderedChapter();
    const seen: (EpubSelection | null)[] = [];
    handle.onSelection((selection) => seen.push(selection));

    const getSelection = vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf('汉字'));
    try {
      contents.document.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
      contents.document.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
      expect(seen).toHaveLength(0);
    } finally {
      getSelection.mockRestore();
    }
  });

  it('restores a jump in flight on resize, not the location epub.js reported last', async () => {
    const handle = await open();
    const jump = handle.display('epubcfi(/6/2!/4/2/1:0)');
    // The location is seeded with the jump's destination ahead of `reportLocation()`,
    // so epub.js' `onResized` (`if (this.location && this.location.start)`) re-displays
    // the destination rather than skipping re-display or restoring the pre-jump chapter.
    expect(fake.rendition.location).toEqual({
      start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
    });
    handle.resize(420, 900);
    expect(fake.state.resizes.at(-1)).toEqual([420, 900, 'epubcfi(/6/2!/4/2/1:0)']);
    expect(fake.state.displays).toEqual(['epubcfi(/6/2!/4/2/1:0)', 'epubcfi(/6/2!/4/2/1:0)']);
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await jump;
    expect(fake.rendition.location?.start.href).toBe('chapter1.xhtml');
  });

  it('restores a jump inside one chapter on resize', async () => {
    const handle = await open();
    fake.rendition.location = { start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' } };
    const jump = handle.display('epubcfi(/6/2!/4/4/1:4)');
    // The href does not change here, so seeding `location.start.cfi` and passing the
    // target to `resize` keep epub.js from re-displaying the position the jump left.
    expect(fake.rendition.location).toEqual({
      start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/4/1:4)' },
    });
    handle.resize(420, 900);
    expect(fake.state.resizes.at(-1)).toEqual([420, 900, 'epubcfi(/6/2!/4/4/1:4)']);
    expect(fake.state.displays).toEqual(['epubcfi(/6/2!/4/4/1:4)', 'epubcfi(/6/2!/4/4/1:4)']);
    fake.settle('epubcfi(/6/2!/4/4/1:4)');
    await jump;
  });

  it('preserves an in-flight href jump when setColumns or setPreferences runs', async () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { value: 640 });
    Object.defineProperty(host, 'clientHeight', { value: 900 });
    fake.rendition.location = { start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' } };
    const handle = await openEpubDocument(
      { kind: 'bytes', bytes: new Uint8Array() },
      host,
      'spread',
    );
    const jump = handle.display('chapter1.xhtml');
    handle.setColumns(1);
    expect(fake.state.resizes.at(-1)).toEqual([640, 900, 'chapter1.xhtml']);
    expect(fake.state.displays.at(-1)).toBe('chapter1.xhtml');
    fake.settle('chapter1.xhtml');
    await jump;
    expect(fake.rendition.location?.start.href).toBe('chapter1.xhtml');
  });

  it('forwards a right click in a chapter frame, once per document', async () => {
    const handle = await open();
    const rightClick = vi.fn();
    handle.onContextMenu(rightClick);
    const chapterDoc = document.implementation.createHTMLDocument('');
    chapterDoc.body.innerHTML = '<p id="text">A paragraph</p>';
    const hook = fake.state.renditionHooks[0];
    const contents = {
      document: chapterDoc,
      window,
      expand: vi.fn<() => void>(),
      sectionIndex: 0,
    } as unknown as Parameters<NonNullable<typeof hook>>[0];
    // A re-rendered view runs the hook again on the same document.
    hook?.(contents);
    hook?.(contents);
    const click = () => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      chapterDoc.getElementById('text')?.dispatchEvent(event);
      return event;
    };
    click();
    expect(rightClick).toHaveBeenCalledTimes(1);
  });

  it('stops listening to a chapter once the reader is destroyed', async () => {
    const handle = await open();
    const rightClick = vi.fn();
    handle.onContextMenu(rightClick);
    const jump = handle.display('chapter1.xhtml');
    fake.settle('chapter1.xhtml');
    await jump;
    const chapterDoc = fake.state.contents[0]?.document;
    const click = () => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      chapterDoc?.body.dispatchEvent(event);
    };
    click();
    expect(rightClick).toHaveBeenCalledTimes(1);

    handle.destroy();
    click();
    expect(rightClick).toHaveBeenCalledTimes(1);
  });

  it('resolves a link against its chapter, not the frame, and says if it is a noteref', async () => {
    const handle = await open();
    const links: [string, boolean][] = [];
    handle.onInternalLink((href, link) => links.push([href, link.noteref]));
    const chapterDoc = document.implementation.createHTMLDocument('');
    // A `srcdoc` frame inherits its parent page's URL as its base.
    const base = chapterDoc.createElement('base');
    base.href = 'http://127.0.0.1:1420/';
    chapterDoc.head.append(base);
    chapterDoc.body.innerHTML = `
      <a id="same" href="#aside">*</a>
      <a id="note" epub:type="noteref" href="chapter1.xhtml#fn1">1</a>
      <a id="away" href="https://example.com/">out</a>`;
    // A `srcdoc` chapter's base is the app's page, so only its spine index places it.
    for (const hook of fake.state.renditionHooks) {
      hook({
        document: chapterDoc,
        window,
        expand: vi.fn<() => void>(),
        sectionIndex: 1,
      } as unknown as Parameters<(typeof fake.state.renditionHooks)[number]>[0]);
    }
    const click = (id: string) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      chapterDoc.getElementById(id)?.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(click('same')).toBe(true);
    expect(click('note')).toBe(true);
    // An absolute link keeps epub.js' own handling.
    expect(click('away')).toBe(false);
    expect(links).toEqual([
      ['/chapter2.xhtml#aside', false],
      ['/chapter1.xhtml#fn1', true],
    ]);
    expect(handle.spineIndexOf(links[0]?.[0] ?? '')).toBe(1);
  });

  it('resolves links the same way under a packaged app, whose origin is "null"', async () => {
    // `tauri://localhost` is not a special scheme, so its origin serializes as "null".
    expect(new URL('tauri://localhost/index.html').origin).toBe('null');
    const handle = await open();
    const links: string[] = [];
    handle.onInternalLink((href) => links.push(href));
    const chapterDoc = document.implementation.createHTMLDocument('');
    const base = chapterDoc.createElement('base');
    base.href = 'tauri://localhost/';
    chapterDoc.head.append(base);
    chapterDoc.body.innerHTML = `<a id="same" href="#aside">*</a>`;
    for (const hook of fake.state.renditionHooks) {
      hook({
        document: chapterDoc,
        window,
        expand: vi.fn<() => void>(),
        sectionIndex: 0,
      } as unknown as Parameters<(typeof fake.state.renditionHooks)[number]>[0]);
    }
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    chapterDoc.getElementById('same')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(links).toEqual(['/chapter1.xhtml#aside']);
    expect(handle.spineIndexOf(links[0] ?? '')).toBe(0);
  });

  it('finds a chapter whose manifest href is encoded, or not, from a decoded link', async () => {
    fake.spineItems.push(
      { href: 'OEBPS/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml' },
      { href: 'my notes.xhtml' },
    );
    try {
      const handle = await open();
      expect(handle.spineIndexOf('/OEBPS/第一章.xhtml#fn1')).toBe(2);
      expect(handle.spineIndexOf('/OEBPS/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml')).toBe(2);
      expect(handle.spineIndexOf(resolveChapterLink('#n', 'my notes.xhtml') ?? '')).toBe(3);
      expect(handle.spineIndexOf('/my%20notes.xhtml')).toBe(3);
      expect(handle.spineIndexOf('/missing.xhtml')).toBe(-1);
    } finally {
      fake.spineItems.splice(2);
    }
  });

  it('tags a mark with its annotation id only, noted or not', async () => {
    const handle = await open();
    fake.rendition.annotations.add.mockClear();
    handle.highlight('a', 'epubcfi(/6/4!/4/2/1:0,/1:0,/1:4)', '#fde047', 'highlight', {
      hasNote: true,
    });
    handle.highlight('b', 'epubcfi(/6/4!/4/2/1:0,/1:4,/1:8)', '#fde047', 'underline');
    expect(fake.rendition.annotations.add.mock.calls.map((call) => call[2])).toEqual([
      { annotationId: 'a' },
      { annotationId: 'b' },
    ]);
  });

  it('re-issues a jump whose views a resize cleared', async () => {
    const handle = await open();
    const jump = handle.display('epubcfi(/6/2!/4/2/1:0)');
    // The chapter reports, but its view was destroyed: the href alone looks landed.
    fake.settle('epubcfi(/6/2!/4/2/1:0)', 0);
    await vi.waitFor(() =>
      expect(fake.state.displays).toEqual(['epubcfi(/6/2!/4/2/1:0)', 'epubcfi(/6/2!/4/2/1:0)']),
    );
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await jump;
    expect(fake.rendition.location?.start.href).toBe('chapter1.xhtml');
  });

  it('preserves font size across cached chapter re-renders on resize and expands live views', async () => {
    const handle = await open();
    const initial = handle.display('epubcfi(/6/2!/4/2/1:0)');
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await initial;

    const preferenceStyle = (doc: Document | undefined) =>
      doc?.querySelector('style[data-synapse-preferences="true"]')?.textContent ?? '';

    expect(preferenceStyle(fake.state.contents[0]?.document)).toContain(
      'font-size: 1.050rem !important;',
    );

    const liveContents = fake.state.contents[0];
    const liveView = fake.state.views[0];
    handle.setPreferences({ ...DEFAULT_READING_PREFERENCES, fontSize: 160 });

    expect(preferenceStyle(liveContents?.document)).toContain('font-size: 1.680rem !important;');
    expect(preferenceStyle(fake.spineItems[0]?.document)).toContain(
      'font-size: 1.680rem !important;',
    );
    expect(liveView?._needsReframe).toBe(true);
    expect(liveContents?.expand).toHaveBeenCalledTimes(1);

    // Changing page width or margins resizes the host, clearing live views and
    // re-mounting the cached chapter without re-running `book.spine.hooks.content`.
    handle.resize(694, 900);
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    expect(fake.state.contents[0]).not.toBe(liveContents);
    expect(preferenceStyle(fake.state.contents[0]?.document)).toContain(
      'font-size: 1.680rem !important;',
    );
  });

  it('resizes the rendition stage to the host dimensions when switching reading modes', async () => {
    const host = document.createElement('div');
    let hostWidth = 1163;
    Object.defineProperty(host, 'clientWidth', { get: () => hostWidth, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 900, configurable: true });
    fake.rendition.location = { start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' } };
    const handle = await openEpubDocument(
      { kind: 'bytes', bytes: new Uint8Array() },
      host,
      'spread',
    );
    const initial = handle.display('epubcfi(/6/2!/4/2/1:0)');
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await initial;
    fake.state.displays = [];
    fake.state.resizes = [];

    // Switching Two pages -> Single page shrinks the host from 1163 to 581 before
    // `setReadingMode('paged')` runs, while `setColumns(1)` no-ops because spread is already 'none'.
    hostWidth = 581;
    const modeSwitch = handle.setReadingMode('paged');
    handle.setColumns(1);
    expect(fake.state.resizes).toEqual([[581, 900, 'epubcfi(/6/2!/4/2/1:0)']]);
    expect(fake.state.displays).toEqual(['epubcfi(/6/2!/4/2/1:0)']);
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await modeSwitch;
    handle.destroy();
  });
});

describe('decorateWithNoteMarker', () => {
  const SVG = 'http://www.w3.org/2000/svg';

  /** Stands in for a marks-pane highlight: `render` clears and redraws its rects. */
  function fakeMark(lines: { x: number; y: number; width: number }[]): PaneMark {
    const group = document.createElementNS(SVG, 'g');
    return {
      element: group,
      render() {
        while (group.firstChild) group.removeChild(group.firstChild);
        for (const line of lines) {
          const rect = document.createElementNS(SVG, 'rect');
          rect.setAttribute('x', String(line.x));
          rect.setAttribute('y', String(line.y));
          rect.setAttribute('width', String(line.width));
          rect.setAttribute('height', '18');
          group.appendChild(rect);
        }
      },
    };
  }

  function fakeAnnotation(mark: PaneMark | undefined) {
    let onAttach: ((mark: PaneMark | undefined) => void) | null = null;
    const annotation: RenditionAnnotation = {
      mark,
      on: (_type, listener) => {
        onAttach = listener;
      },
    };
    return { annotation, attach: (next: PaneMark) => onAttach?.(next) };
  }

  const dots = (mark: PaneMark) => mark.element?.querySelectorAll('circle[data-note-marker]') ?? [];

  it('draws one dot at the end of the last line, and keeps it through redraws', () => {
    const mark = fakeMark([
      { x: 10, y: 100, width: 300 },
      { x: 10, y: 120, width: 80 },
    ]);
    mark.render();
    decorateWithNoteMarker(fakeAnnotation(mark).annotation, '#86efac');
    expect(dots(mark)).toHaveLength(1);
    const dot = dots(mark)[0];
    expect(Number(dot?.getAttribute('cx'))).toBeGreaterThan(90);
    expect(Number(dot?.getAttribute('cy'))).toBeGreaterThan(120);
    expect(dot?.getAttribute('fill')).toBe('#86efac');
    expect(dot?.getAttribute('fill-opacity')).toBe('1');

    // marks-pane redraws on every resize.
    mark.render();
    mark.render();
    expect(dots(mark)).toHaveLength(1);
  });

  it('decorates the new mark epub.js makes each time the chapter renders', () => {
    const { annotation, attach } = fakeAnnotation(undefined);
    decorateWithNoteMarker(annotation, '#fde047');
    const next = fakeMark([{ x: 0, y: 0, width: 50 }]);
    next.render();
    attach(next);
    expect(dots(next)).toHaveLength(1);
    // Attaching the same mark again does not wrap it twice.
    attach(next);
    next.render();
    expect(dots(next)).toHaveLength(1);
  });
});

describe('resolveChapterLink', () => {
  it('resolves against the chapter, whatever the frame is served from', () => {
    expect(resolveChapterLink('#fn1', 'OEBPS/ch1.xhtml')).toBe('/OEBPS/ch1.xhtml#fn1');
    expect(resolveChapterLink('../notes.xhtml#n?', 'OEBPS/text/ch1.xhtml')).toBe(
      '/OEBPS/notes.xhtml#n?',
    );
    expect(resolveChapterLink('notes.xhtml?x=1#n', 'ch1.xhtml')).toBe('/notes.xhtml?x=1#n');
    expect(resolveChapterLink('#fn1', undefined)).toBe('/#fn1');
  });

  it('keeps spaces and non-ASCII in the path as the manifest writes them', () => {
    expect(resolveChapterLink('#fn1', 'OEBPS/第一章.xhtml')).toBe('/OEBPS/第一章.xhtml#fn1');
    expect(resolveChapterLink('notes%20and%20refs.xhtml#n', 'OEBPS/my chapter.xhtml')).toBe(
      '/OEBPS/notes and refs.xhtml#n',
    );
    // A malformed escape is kept as written rather than dropping the link.
    expect(resolveChapterLink('bad%E0.xhtml', 'ch1.xhtml')).toBe('/bad%E0.xhtml');
  });

  it('leaves links out of the book to epub.js', () => {
    for (const raw of ['', 'https://example.com/', 'HTTP://x', 'mailto:a@b', '//cdn/x.js']) {
      expect(resolveChapterLink(raw, 'ch1.xhtml'), raw).toBeNull();
    }
  });
});

describe('EPUB paper curl engine', () => {
  it('captures an inert curl stage, drives [data-curl-part], and empties curlHost on settle', async () => {
    const frames: FrameRequestCallback[] = [];
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const nextSpy = vi.spyOn(fake.rendition, 'next');

    try {
      const container = document.createElement('div');
      Object.defineProperty(container, 'clientWidth', { value: 640, configurable: true });
      Object.defineProperty(container, 'offsetWidth', { value: 640, configurable: true });
      Object.defineProperty(container, 'scrollWidth', { value: 1920, configurable: true });
      Object.defineProperty(container, 'scrollLeft', {
        value: 0,
        writable: true,
        configurable: true,
      });
      Reflect.set(fake.rendition, 'manager', { container, layout: { delta: 640 } });

      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const host = document.createElement('div');
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      const chapterDoc = document.implementation.createHTMLDocument('');
      chapterDoc.body.innerHTML = '<p id="dup" data-annotation-id="a1">Outgoing page</p>';
      fake.state.contents = [
        { document: chapterDoc, window, cfiFromRange: () => '', expand: vi.fn() },
      ];

      const curlHost = document.createElement('div');
      const shadow = document.createElement('div');
      const leaf = document.createElement('div');
      leaf.dataset.curlPart = 'leaf';
      const spine = document.createElement('div');
      spine.dataset.curlPart = 'spine';
      shadow.append(leaf, spine);

      handle.setCurlElements?.({ curlHost, shadow });

      const turnPromise = handle.turnPage(1, {
        animate: false,
        transition: 'curl',
        spread: true,
      });

      // Wait a microtask for `rendition.next()` to resolve and enter `runCurlAnimation`.
      await Promise.resolve();
      expect(curlHost.childElementCount).toBeGreaterThan(0);
      expect(curlHost.querySelector('#dup')).toBeNull();
      expect(curlHost.querySelector('[data-annotation-id]')).toBeNull();

      clock = 40;
      frames.shift()?.(clock);
      expect(curlHost.style.clipPath).toContain('polygon(');
      expect(Number(leaf.style.opacity)).toBeGreaterThan(0.5);
      expect(Number(spine.style.opacity)).toBeGreaterThan(0.2);

      clock = 500;
      frames.shift()?.(clock);
      await turnPromise;
      expect(container.scrollLeft).toBe(640);
      expect(curlHost.childElementCount).toBe(0);
      expect(curlHost.style.clipPath).toBe('');
      expect(leaf.style.opacity).toBe('0');

      // Live scrub updates curl progress 1:1 and springs back cleanly on cancel.
      handle.beginScrub({ transition: 'curl', spread: true });
      handle.scrubTo(192);
      expect(Number(leaf.style.opacity)).toBeGreaterThan(0.4);
      expect(container.scrollLeft).toBe(1280);

      const scrubEndPromise = handle.endScrub(null);
      expect(container.scrollLeft).toBe(640);
      clock = 1000;
      frames.shift()?.(clock);
      await scrubEndPromise;
      expect(curlHost.childElementCount).toBe(0);
      expect(leaf.style.opacity).toBe('0');

      // Cross-chapter seam fallback when `!canTurnInPlace`: invokes `rendition.next()`.
      container.scrollLeft = 1280;
      nextSpy.mockClear();
      const seamPromise = handle.turnPage(1, {
        animate: false,
        transition: 'curl',
        spread: true,
      });
      await Promise.resolve();
      expect(nextSpy).toHaveBeenCalledTimes(1);
      expect(curlHost.childElementCount).toBeGreaterThan(0);

      clock = 2000;
      frames.shift()?.(clock);
      await seamPromise;
      expect(curlHost.childElementCount).toBe(0);

      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      nextSpy.mockRestore();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });
});

describe('EPUB slide seam scrubbing', () => {
  it('uses scrubBase for seam detection and restores visibility + scroll across held views', async () => {
    const frames: FrameRequestCallback[] = [];
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);

    const container = document.createElement('div');
    let containerScrollWidth = 1280;
    let containerScrollLeft = 0;
    Object.defineProperty(container, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'scrollWidth', {
      get: () => containerScrollWidth,
      configurable: true,
    });
    Object.defineProperty(container, 'scrollLeft', {
      get: () => containerScrollLeft,
      set: (value: number) => {
        containerScrollLeft = value;
      },
      configurable: true,
    });

    const heldView = document.createElement('div');
    heldView.className = 'epub-view';
    Object.defineProperty(heldView, 'offsetWidth', { value: 1280, configurable: true });
    const heldFrame = document.createElement('iframe');
    heldView.appendChild(heldFrame);
    container.appendChild(heldView);

    const originalClear = vi.fn();
    const viewsCollection = {
      _views: [{ element: heldView }],
      length: 1,
      clear: originalClear,
    };
    const reportLocation = vi.fn();
    Reflect.set(fake.rendition, 'manager', {
      container,
      layout: { delta: 640 },
      views: viewsCollection,
    });
    Reflect.set(fake.rendition, 'reportLocation', reportLocation);

    const prevSpy = vi.spyOn(fake.rendition, 'prev').mockImplementation(async () => {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
    });
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(async () => {
      // Simulate epub.js `manager.clear()` hiding the outgoing view before `views.clear()`.
      heldView.style.visibility = 'hidden';
      heldFrame.style.visibility = 'hidden';
      viewsCollection.clear();
      containerScrollLeft = 0;
      const incomingView = document.createElement('div');
      incomingView.className = 'epub-view';
      Object.defineProperty(incomingView, 'offsetWidth', { value: 640, configurable: true });
      container.appendChild(incomingView);
      containerScrollWidth = 1920;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
    });

    try {
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      const host = document.createElement('div');
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);

      // 1. Backward seam scrub from page 1 of chapter 2 (`scrubBase = 0`) still sees
      // `!canTurnInPlace(-1)` even after `scrubTo` moves `scrollLeft > 1`.
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(80);
      expect(container.scrollLeft).toBe(80);
      expect(handle.canTurnInPlace(-1)).toBe(false);
      const prevPromise = handle.endScrub(-1);
      // Spring-back from 80 -> 0 completes when rAF advances.
      clock = 500;
      frames.shift()?.(clock);
      await Promise.resolve();
      await prevPromise;
      expect(prevSpy).toHaveBeenCalledTimes(1);

      // 2. Forward seam scrub from the last page (`scrollLeft = 640`) of a 2-page chapter
      // holds the outgoing view visibly, slides past it, removes it, and resets to 0.
      containerScrollLeft = 640;
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(160);
      containerScrollLeft = 640;
      expect(handle.canTurnInPlace(1)).toBe(false);
      const nextPromise = handle.endScrub(1);
      for (let tick = 0; tick < 4; tick += 1) {
        await Promise.resolve();
      }
      expect(nextSpy).toHaveBeenCalledTimes(1);
      expect(heldView.style.visibility).toBe('visible');
      expect(heldFrame.style.visibility).toBe('visible');
      expect(containerScrollLeft).toBe(640);

      clock = 1500;
      frames.shift()?.(clock);
      await nextPromise;
      expect(heldView.isConnected).toBe(false);
      expect(containerScrollLeft).toBe(0);
      expect(reportLocation).toHaveBeenCalled();

      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      Reflect.set(fake.rendition, 'reportLocation', undefined);
      prevSpy.mockRestore();
      nextSpy.mockRestore();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  /** A strip one page wide, laid out as epub.js lays a two-page chapter out. */
  const stripHarness = () => {
    const container = document.createElement('div');
    let scrollWidth = 1280;
    let scrollLeft = 0;
    Object.defineProperty(container, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'clientHeight', { value: 480, configurable: true });
    Object.defineProperty(container, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'scrollWidth', {
      get: () => scrollWidth,
      configurable: true,
    });
    Object.defineProperty(container, 'scrollLeft', {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
      configurable: true,
    });
    return {
      container,
      get scrollLeft() {
        return scrollLeft;
      },
      set scrollLeft(value: number) {
        scrollLeft = value;
      },
      setScrollWidth(value: number) {
        scrollWidth = value;
      },
    };
  };

  it('runs epub.js own teardown for the views a seam turn held', async () => {
    const frames: FrameRequestCallback[] = [];
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);

    const strip = stripHarness();
    const heldView = document.createElement('div');
    heldView.className = 'epub-view';
    Object.defineProperty(heldView, 'offsetWidth', { value: 1280, configurable: true });
    strip.container.appendChild(heldView);

    const viewDestroy = vi.fn();
    const held = { element: heldView, displayed: true, destroy: viewDestroy };
    // Stands in for `Views.destroy`: epub.js runs `IframeView.destroy` and then takes
    // the element out of the strip.
    const destroyView = vi.fn((view: typeof held) => {
      view.destroy();
      view.element.remove();
    });
    const views = {
      _views: [held],
      length: 1,
      container: strip.container,
      clear: vi.fn(),
      destroy: destroyView,
    };
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
      views,
    });
    Reflect.set(fake.rendition, 'reportLocation', vi.fn());
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(async () => {
      views.clear();
      strip.scrollLeft = 0;
      strip.setScrollWidth(1920);
    });

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument(
        { kind: 'bytes', bytes: new Uint8Array() },
        document.createElement('div'),
      );

      strip.scrollLeft = 640;
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(160);
      strip.scrollLeft = 640;
      const done = handle.endScrub(1);
      for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
      expect(heldView.parentElement).toBe(strip.container);

      clock = 1500;
      frames.shift()?.(clock);
      await done;
      // Removing only the element would leave the chapter's ResizeObserver,
      // listeners and blob URL behind on every seam turn.
      expect(heldView.parentElement).toBeNull();
      expect(destroyView).toHaveBeenCalledTimes(1);
      expect(viewDestroy).toHaveBeenCalledTimes(1);
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      Reflect.set(fake.rendition, 'reportLocation', undefined);
      nextSpy.mockRestore();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('stages a seam turn across the page area', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    const heldView = document.createElement('div');
    heldView.className = 'epub-view';
    Object.defineProperty(heldView, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(heldView, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(heldView, 'offsetWidth', { value: 1280, configurable: true });
    Object.defineProperty(heldView, 'offsetHeight', { value: 480, configurable: true });
    strip.container.appendChild(heldView);
    const viewDestroy = vi.fn();
    const held = { element: heldView, displayed: true, destroy: viewDestroy };
    const destroyView = vi.fn((view: typeof held) => {
      view.destroy();
      view.element.remove();
    });
    const views = {
      _views: [held],
      length: 1,
      container: strip.container,
      clear: vi.fn(() => {
        heldView.remove();
      }),
      destroy: destroyView,
    };
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
      views,
    });
    Reflect.set(fake.rendition, 'reportLocation', vi.fn());
    let resolveNext!: () => void;
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNext = () => {
            views.clear();
            strip.scrollLeft = 0;
            strip.setScrollWidth(1920);
            resolve();
          };
        }),
    );

    const host = document.createElement('div');
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow: null });

      strip.scrollLeft = 640;
      const turn = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      // Outgoing page is frozen in `curlHost` before `rendition.next()` touches
      // the strip, so `views.clear()` / `scrollTo(0, 0)` never flashes page 1.
      expect(curlHost.style.visibility).toBe('visible');
      expect(curlHost.style.transform).toBe('translateX(0px)');

      resolveNext();
      for (let step = 0; step < 4; step += 1) await Promise.resolve();
      expect(host.style.transform).toBe('translateX(900px)');
      expect(host.style.zIndex).toBe('15');
      expect(curlHost.style.visibility).toBe('visible');
      expect(strip.scrollLeft).toBe(0);

      tick(130);
      expect(host.style.transform).not.toBe('');
      expect(host.style.boxShadow).not.toBe('');
      tick(300);
      await turn;
      expect(host.style.transform).toBe('');
      expect(host.style.zIndex).toBe('');
      expect(host.style.boxShadow).toBe('');
      expect(curlHost.style.visibility).toBe('hidden');
      expect(heldView.parentElement).toBeNull();
      expect(strip.scrollLeft).toBe(0);
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      Reflect.set(fake.rendition, 'reportLocation', undefined);
      nextSpy.mockRestore();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('stops a running slide when a newer relayout replaces its chapter', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument(
        { kind: 'bytes', bytes: new Uint8Array() },
        document.createElement('div'),
      );

      const turn = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      expect(frames.size).toBe(1);
      tick(130);
      expect(strip.scrollLeft).toBeGreaterThan(0);
      expect(strip.scrollLeft).toBeLessThan(640);

      // A relayout re-displays the chapter: the frame loop must not keep writing its
      // old page offset into the strip afterwards.
      handle.resize(640, 480);
      expect(frames.size).toBe(0);
      tick(500);
      expect(strip.scrollLeft).toBe(640);
      await turn;
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('slides the whole page area instead of the reading measure', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    document.body.append(strip.container);
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });

    const host = document.createElement('div');
    const pane = document.createElement('div');
    pane.dataset.testid = 'epub-slide-pane';
    pane.append(host);
    const spine = document.createElement('div');
    spine.dataset.testid = 'epub-spine';
    spine.style.background =
      'linear-gradient(to right, transparent, rgba(0, 0, 0, 0.16) 50%, transparent)';
    vi.spyOn(spine, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 12, 48, 456));
    pane.append(spine);
    document.body.append(pane);
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    // The page area is wider than the reading measure: a slide confined to the
    // measure would leave the margins of the same paper standing still.
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    const translateX = (element: HTMLElement) =>
      Number(element.style.transform.match(/-?[\d.]+/)?.[0] ?? 0);

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow: null });

      const turn = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      // The strip is already on the incoming page; the pane carries the motion.
      expect(strip.scrollLeft).toBe(640);
      expect(translateX(pane)).toBe(900);
      expect(host.style.transform).toBe('');
      expect(translateX(curlHost)).toBe(0);
      expect(curlHost.style.visibility).toBe('visible');
      expect(curlHost.childElementCount).toBeGreaterThan(0);
      // The chapter clone is clipped to the live reading viewport, not the page
      // area, so neighbouring columns cannot show in the paper margins.
      const mirrorViewport = curlHost.querySelector('[data-testid="epub-mirror-viewport"]');
      expect(mirrorViewport).not.toBeNull();
      expect((mirrorViewport as HTMLElement).style.left).toBe('130px');
      expect((mirrorViewport as HTMLElement).style.top).toBe('0px');
      expect((mirrorViewport as HTMLElement).style.width).toBe('640px');
      expect((mirrorViewport as HTMLElement).style.height).toBe('480px');
      expect((mirrorViewport?.firstElementChild as HTMLElement).style.left).toBe('0px');
      expect((mirrorViewport?.firstElementChild as HTMLElement).style.top).toBe('0px');
      // The outgoing spread keeps its spine: the live spine is a sibling of the
      // host, so the mirror has to carry a copy of it.
      const mirrorSpine = mirrorViewport?.querySelector('[data-testid="epub-mirror-spine"]');
      expect(mirrorSpine).not.toBeNull();
      expect((mirrorSpine as HTMLElement).style.left).toBe('270px');
      expect((mirrorSpine as HTMLElement).style.top).toBe('12px');
      expect((mirrorSpine as HTMLElement).style.width).toBe('48px');
      expect((mirrorSpine as HTMLElement).style.height).toBe('456px');

      tick(130);
      // Half-way: the outgoing page has left and the incoming one is arriving.
      expect(translateX(pane)).toBeLessThan(900);
      expect(translateX(pane)).toBeGreaterThan(0);
      expect(translateX(curlHost)).toBeLessThan(0);
      expect(translateX(curlHost)).toBeGreaterThan(-900);

      tick(300);
      await turn;
      expect(pane.style.transform).toBe('');
      expect(curlHost.style.transform).toBe('');
      expect(curlHost.style.visibility).toBe('hidden');
      expect(curlHost.childElementCount).toBe(0);

      // A forward scrub follows the fingers across the page area too: the strip
      // lands on the incoming page at once, and the page itself carries the drag.
      strip.scrollLeft = 0;
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(120);
      expect(strip.scrollLeft).toBe(640);
      expect(translateX(pane)).toBe(780);
      expect(translateX(curlHost)).toBe(-120);
      handle.scrubTo(0);
      expect(pane.style.transform).toBe('');
      expect(curlHost.style.transform).toBe('');
      expect(strip.scrollLeft).toBe(0);

      // A reversal restages the same mirror instead of cloning the chapter again.
      strip.scrollLeft = 640;
      // Three pages, so the scrub has a page in either direction from page two.
      strip.setScrollWidth(1920);
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(120);
      const scrubViewport = curlHost.querySelector('[data-testid="epub-mirror-viewport"]');
      const mirrorChild = scrubViewport?.firstElementChild;
      handle.scrubTo(-120);
      expect(scrubViewport?.firstElementChild).toBe(mirrorChild);
      expect(translateX(pane)).toBe(-780);
      expect(translateX(curlHost)).toBe(120);
      expect(strip.scrollLeft).toBe(0);
      handle.scrubTo(0);
      expect(strip.scrollLeft).toBe(640);
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      strip.container.remove();
      pane.remove();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('restores a cancelled scrub when a turn interrupts the spring-back', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    strip.setScrollWidth(1920);
    document.body.append(strip.container);
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });

    const host = document.createElement('div');
    const pane = document.createElement('div');
    pane.dataset.testid = 'epub-slide-pane';
    pane.append(host);
    document.body.append(pane);
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow: null });

      strip.scrollLeft = 0;
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(120);
      expect(strip.scrollLeft).toBe(640);

      const springBack = handle.endScrub(null);
      // The spring-back is still in flight when the turn arrives.
      const turn = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      // The cancelled scrub must land on its original page before the turn starts,
      // or the turn would advance from the page the scrub never committed.
      expect(strip.scrollLeft).toBe(640);
      expect(pane.style.transform).toBe('translateX(900px)');

      tick(300);
      await Promise.all([springBack, turn]);
      expect(strip.scrollLeft).toBe(640);
      expect(pane.style.transform).toBe('');
      expect(curlHost.style.visibility).toBe('hidden');
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      strip.container.remove();
      pane.remove();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('keeps the newer stage when two turns overlap', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    // Three pages, so both turns can be made in place.
    strip.setScrollWidth(1920);
    document.body.append(strip.container);
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });

    const host = document.createElement('div');
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow: null });

      const first = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      expect(strip.scrollLeft).toBe(640);
      expect(host.style.transform).toBe('translateX(900px)');

      // The second turn settles the first stage and starts its own from page two.
      const second = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      expect(strip.scrollLeft).toBe(1280);
      expect(host.style.transform).toBe('translateX(900px)');

      // Let the first turn's cancelled continuation run while the second stage is
      // still animating: it must not clear the stage it no longer owns.
      await Promise.resolve();
      expect(host.style.transform).toBe('translateX(900px)');

      tick(130);
      // The first turn's continuation must not clear the stage the second one owns.
      expect(host.style.transform).not.toBe('');
      tick(300);
      await Promise.all([first, second]);
      expect(strip.scrollLeft).toBe(1280);
      expect(host.style.transform).toBe('');
      expect(curlHost.style.transform).toBe('');
      expect(curlHost.style.visibility).toBe('hidden');
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      strip.container.remove();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('carries a two-page spread across the page area while the strip advances one spread', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    // A spread is two pages: the strip advances by the spread, while the page
    // itself travels the page area, which is wider than the spread.
    Object.defineProperty(strip.container, 'clientWidth', { value: 1163, configurable: true });
    Object.defineProperty(strip.container, 'offsetWidth', { value: 1163, configurable: true });
    strip.setScrollWidth(2326);
    document.body.append(strip.container);
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 1163, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 862, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 1163 },
    });

    const host = document.createElement('div');
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1726, 1000));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(281, 0, 1163, 862));

    const translateX = (element: HTMLElement) =>
      Number(element.style.transform.match(/-?[\d.]+/)?.[0] ?? 0);

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow: null });

      const turn = handle.turnPage(1, { animate: true, transition: 'slide', spread: true });
      expect(strip.scrollLeft).toBe(1163);
      expect(translateX(host)).toBe(1726);

      tick(130);
      expect(translateX(host)).toBeLessThan(1726);
      expect(translateX(host)).toBeGreaterThan(0);
      expect(translateX(curlHost)).toBeLessThan(0);
      expect(translateX(curlHost)).toBeGreaterThan(-1726);

      tick(300);
      await turn;
      expect(strip.scrollLeft).toBe(1163);
      expect(host.style.transform).toBe('');
      expect(curlHost.style.transform).toBe('');
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      strip.container.remove();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('follows the fingers at a chapter seam in slide mode, cancels cleanly, and commits across the seam', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(async () => {
      strip.scrollLeft = 0;
    });

    const host = document.createElement('div');
    const pane = document.createElement('div');
    pane.dataset.testid = 'epub-slide-pane';
    pane.append(host);
    document.body.append(pane);
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow: null });

      // Last page of chapter 1: forward scrub follows across the page area over
      // clean paper while keeping the old chapter hidden until commit.
      strip.scrollLeft = 640;
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(150);
      expect(curlHost.style.visibility).toBe('visible');
      expect(curlHost.style.transform).toBe('translateX(-150px)');
      expect(pane.style.transform).toBe('translateX(750px)');
      expect(strip.container.style.visibility).toBe('hidden');
      expect(nextSpy).not.toHaveBeenCalled();

      // Cancelling springs back without loading the next chapter.
      const cancelPromise = handle.endScrub(null);
      tick(250);
      await cancelPromise;
      expect(nextSpy).not.toHaveBeenCalled();
      expect(strip.container.style.visibility).toBe('');
      expect(strip.scrollLeft).toBe(640);
      expect(pane.style.transform).toBe('');

      // Committing with a slow chapter load keeps the outgoing page visible until
      // the next chapter is ready, rather than sliding off onto blank paper.
      let resolveSlowNext!: () => void;
      nextSpy.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSlowNext = () => {
              strip.scrollLeft = 0;
              resolve();
            };
          }),
      );
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(200);
      const commitPromise = handle.endScrub(1);
      await Promise.resolve();
      expect(nextSpy).toHaveBeenCalledTimes(1);
      clock = 800;
      expect(curlHost.style.visibility).toBe('visible');
      expect(curlHost.style.transform).toBe('translateX(-200px)');
      expect(strip.container.style.visibility).toBe('hidden');

      resolveSlowNext();
      await Promise.resolve();
      await Promise.resolve();
      expect(strip.container.style.visibility).toBe('');
      tick(1200);
      await commitPromise;
      expect(strip.scrollLeft).toBe(0);
      expect(pane.style.transform).toBe('');
      expect(curlHost.style.visibility).toBe('hidden');
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      nextSpy.mockRestore();
      pane.remove();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('restores the starting CFI on resize during a cancelled scrub spring-back', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);

    const strip = stripHarness();
    strip.setScrollWidth(1920);
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });

    const host = document.createElement('div');
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    try {
      const page1Cfi = 'epubcfi(/6/2!/4/2/1:0)';
      const page2Cfi = 'epubcfi(/6/2!/4/4/1:4)';
      fake.rendition.location = { start: { href: 'chapter1.xhtml', cfi: page1Cfi } };
      const locationEvents: string[] = [];
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.onLocation((loc) => locationEvents.push(loc.cfi));
      handle.setCurlElements?.({ curlHost, shadow: null });
      fake.state.listeners.relocated?.({
        start: { cfi: page1Cfi, href: 'chapter1.xhtml', index: 0 },
        end: { cfi: page1Cfi },
      });

      // Scrub forward briefly: epub.js firing relocated for the peeked next page
      // must not overwrite currentCfi while uncommitted or springing back.
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(80);
      fake.state.listeners.relocated?.({
        start: { cfi: page2Cfi, href: 'chapter1.xhtml', index: 0 },
        end: { cfi: page2Cfi },
      });
      expect(locationEvents).toEqual([page1Cfi]);

      const springBack = handle.endScrub(null);
      fake.state.resizes = [];
      handle.resize(640, 480);
      expect(strip.scrollLeft).toBe(0);
      expect(fake.state.resizes[0]?.[2]).toBe(page1Cfi);

      clock = 300;
      for (const cb of [...frames.values()]) cb(clock);
      await springBack;
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('resets curl on scrubTo(0), restores scrubBase on mid-drag interrupt, and ignores stale seam curls', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);

    const strip = stripHarness();
    strip.setScrollWidth(1920);
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });

    const host = document.createElement('div');
    const curlHost = document.createElement('div');
    const shadow = document.createElement('div');
    const leaf = document.createElement('div');
    leaf.dataset.curlPart = 'leaf';
    shadow.appendChild(leaf);
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 600));

    let resolveSeamNext!: () => void;
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSeamNext = resolve;
        }),
    );

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow });

      // 1. Progress normalizes across page-area curlHost (1280) and scrubTo(0) resets cleanly.
      handle.beginScrub({ transition: 'curl', spread: false });
      handle.scrubTo(320);
      expect(strip.scrollLeft).toBe(640);
      expect(Number(leaf.style.opacity)).toBeGreaterThan(0.5);
      handle.scrubTo(0);
      expect(strip.scrollLeft).toBe(0);
      expect(leaf.style.opacity).toBe('0');
      expect(curlHost.style.visibility).toBe('hidden');
      expect(curlHost.childElementCount).toBe(0);
      await handle.endScrub(null);

      // 2. Interrupting an active curl scrub mid-drag restores scrubBase before turning.
      strip.scrollLeft = 0;
      handle.beginScrub({ transition: 'curl', spread: false });
      handle.scrubTo(160);
      expect(strip.scrollLeft).toBe(640);
      const interruptedTurn = handle.turnPage(1, {
        animate: true,
        transition: 'slide',
        spread: false,
      });
      // Must advance from page 1 (0 -> 640), not from the uncommitted page 2 (640 -> 1280).
      expect(strip.scrollLeft).toBe(640);
      clock = 400;
      const pendingFrames = [...frames.values()];
      frames.clear();
      for (const cb of pendingFrames) cb(clock);
      await interruptedTurn;

      // 3. Interrupting an in-flight curl seam turn with display() prevents stale curl animation.
      strip.scrollLeft = 1280;
      const staleSeamCurl = handle.turnPage(1, {
        animate: false,
        transition: 'curl',
        spread: false,
      });
      const jump = handle.display('chapter2.xhtml');
      resolveSeamNext();
      await staleSeamCurl;
      expect(frames.size).toBe(0);
      expect(curlHost.style.visibility).toBe('hidden');
      fake.settle('chapter2.xhtml');
      await Promise.resolve();
      await Promise.resolve();
      for (const cb of [...frames.values()]) cb(clock);
      frames.clear();
      await jump;

      // 4. Interrupting a curl spring-back with display() must not restore the old CFI.
      const ch1Cfi = 'epubcfi(/6/2!/4/2/1:0)';
      const ch2Cfi = 'epubcfi(/6/4!/4/2/1:0)';
      fake.rendition.location = { start: { href: 'chapter1.xhtml', cfi: ch1Cfi } };
      fake.state.listeners.relocated?.({
        start: { cfi: ch1Cfi, href: 'chapter1.xhtml', index: 0 },
        end: { cfi: ch1Cfi },
      });
      strip.scrollLeft = 0;
      handle.beginScrub({ transition: 'curl', spread: false });
      handle.scrubTo(200);
      const cancelledSpring = handle.endScrub(null);
      const tocJump = handle.display(ch2Cfi);
      await cancelledSpring;
      fake.settle(ch2Cfi);
      await Promise.resolve();
      await Promise.resolve();
      for (const cb of [...frames.values()]) cb(clock);
      frames.clear();
      await tocJump;
      fake.state.resizes = [];
      handle.resize(640, 480);
      expect(fake.state.resizes[0]?.[2]).toBe(ch2Cfi);
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      nextSpy.mockRestore();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('ignores a stale seam turn load when a new scrub gesture begins first', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const strip = stripHarness();
    strip.setScrollWidth(1920);
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    strip.container.appendChild(view);
    Reflect.set(fake.rendition, 'manager', {
      container: strip.container,
      layout: { delta: 640 },
    });

    const host = document.createElement('div');
    const pane = document.createElement('div');
    pane.dataset.testid = 'epub-slide-pane';
    pane.append(host);
    document.body.append(pane);
    const curlHost = document.createElement('div');
    const shadow = document.createElement('div');
    const leaf = document.createElement('div');
    leaf.dataset.curlPart = 'leaf';
    shadow.appendChild(leaf);
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    let resolveNext!: () => void;
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNext = resolve;
        }),
    );

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow });

      // 1. Delayed slide seam turn overridden by beginScrub().
      strip.scrollLeft = 1280;
      const staleSlideSeam = handle.turnPage(1, {
        animate: true,
        transition: 'slide',
        spread: false,
      });
      strip.scrollLeft = 0;
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(150);
      expect(curlHost.style.transform).toBe('translateX(-150px)');
      expect(pane.style.transform).toBe('translateX(750px)');

      resolveNext();
      await staleSlideSeam;
      expect(frames.size).toBe(0);
      expect(curlHost.style.visibility).toBe('visible');
      expect(curlHost.style.transform).toBe('translateX(-150px)');
      expect(pane.style.transform).toBe('translateX(750px)');
      const cancelSlide = handle.endScrub(null);
      tick(400);
      await cancelSlide;

      // 2. Delayed curl seam turn overridden by beginScrub().
      strip.scrollLeft = 1280;
      const staleCurlSeam = handle.turnPage(1, {
        animate: false,
        transition: 'curl',
        spread: false,
      });
      strip.scrollLeft = 0;
      handle.beginScrub({ transition: 'curl', spread: false });
      handle.scrubTo(225);
      const scrubClip = curlHost.style.clipPath;
      expect(scrubClip).toContain('polygon(');

      resolveNext();
      await staleCurlSeam;
      expect(frames.size).toBe(0);
      expect(curlHost.style.visibility).toBe('visible');
      expect(curlHost.style.clipPath).toBe(scrubClip);
      const cancelCurl = handle.endScrub(null);
      tick(800);
      await cancelCurl;

      // 3. Starting a scrub during an in-flight display() clears pendingTarget so
      // a subsequent resize keeps the scrubbed location instead of snapping back.
      const page1Cfi = 'epubcfi(/6/2!/4/2/1:0)';
      const page2Cfi = 'epubcfi(/6/2!/4/4/1:4)';
      const ch2Cfi = 'epubcfi(/6/4!/4/2/1:0)';
      strip.scrollLeft = 0;
      fake.rendition.location = { start: { href: 'chapter1.xhtml', cfi: page1Cfi } };
      fake.state.listeners.relocated?.({
        start: { cfi: page1Cfi, href: 'chapter1.xhtml', index: 0 },
        end: { cfi: page1Cfi },
      });
      const pendingJump = handle.display(ch2Cfi);
      handle.beginScrub({ transition: 'slide', spread: false });
      handle.scrubTo(200);
      const commitScrub = handle.endScrub(1);
      tick(1200);
      await commitScrub;
      fake.state.listeners.relocated?.({
        start: { cfi: page2Cfi, href: 'chapter1.xhtml', index: 0 },
        end: { cfi: page2Cfi },
      });
      fake.settle(ch2Cfi);
      await pendingJump;
      fake.state.resizes = [];
      handle.resize(640, 480);
      expect(fake.state.resizes[0]?.[2]).toBe(page2Cfi);
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      nextSpy.mockRestore();
      pane.remove();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });
});

describe('EPUB code blocks', () => {
  beforeEach(() => {
    fake.state.displays = [];
    fake.state.resizes = [];
    fake.state.pending = [];
    fake.state.contents = [];
    fake.state.views = [];
    fake.state.spineHooks = [];
    fake.state.renditionHooks = [];
    fake.state.listeners = {};
    for (const item of fake.spineItems) {
      delete item.document;
    }
    fake.rendition.location = undefined;
  });

  const openRendered = async () => {
    const host = document.createElement('div');
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 800, 600));
    fake.rendition.location = { start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' } };
    const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
    const jump = handle.display('epubcfi(/6/2!/4/2/1:0)');
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await jump;
    const contents = fake.state.contents[0];
    if (!contents) throw new Error('no rendered chapter');
    return { host, handle, contents };
  };

  it('ignores Pandoc aria-hidden line anchors inside pre while keeping callout and regular links', async () => {
    const { handle, contents } = await openRendered();
    Reflect.set(contents, 'sectionIndex', 0);
    const links: string[] = [];
    handle.onInternalLink((href) => links.push(href));

    contents.document.body.innerHTML = `
      <pre id="cb1"><code><span id="cb1-1"><a id="pandoc-anchor" href="#cb1-1" aria-hidden="true" tabindex="-1"></a>let x = 1;</span><a id="callout-link" href="#co1">(1)</a></code></pre>
      <a id="outside-hidden" href="#fn1" aria-hidden="true">*</a>
    `;
    const epubjsOnClick = vi.fn();
    (contents.document.getElementById('pandoc-anchor') as HTMLElement).onclick = epubjsOnClick;

    const click = (id: string) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      contents.document.getElementById(id)?.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(click('pandoc-anchor')).toBe(true);
    expect(links).toEqual([]);
    expect(epubjsOnClick).not.toHaveBeenCalled();

    expect(click('callout-link')).toBe(true);
    expect(click('outside-hidden')).toBe(true);
    expect(links).toEqual(['/chapter1.xhtml#co1', '/chapter1.xhtml#fn1']);
    handle.destroy();
  });

  it('injects reflowable code-block typography and theme styles across light, sepia, and dark', async () => {
    const { handle, contents } = await openRendered();

    const typographyCss =
      contents.document.querySelector('style[data-synapse-typography="true"]')?.textContent ?? '';
    expect(typographyCss).toContain('overflow-wrap: anywhere');
    expect(typographyCss).toContain('word-break: normal');
    expect(typographyCss).toContain('text-indent: 2ch hanging each-line');
    expect(typographyCss).toContain('margin: 0.9em 0;');
    expect(typographyCss).not.toContain('margin: 0.9em 0 !important');
    expect(typographyCss).not.toContain('figure, table, pre, blockquote');
    expect(typographyCss).toContain('pre code {');

    const prefCss = () =>
      contents.document.querySelector('style[data-synapse-preferences="true"]')?.textContent ?? '';

    expect(prefCss()).toContain('overflow: visible !important');
    expect(prefCss()).toContain('break-inside: auto !important');
    expect(prefCss()).toContain('div:has(> pre), figure:has(> pre), blockquote:has(> pre)');
    expect(prefCss()).not.toContain('#ebe1c8');
    expect(prefCss()).not.toContain('#202024');

    handle.setPreferences({ ...DEFAULT_READING_PREFERENCES, theme: 'sepia' });
    expect(prefCss()).toContain('#ebe1c8 !important');
    expect(prefCss()).toContain('#433422 !important');
    expect(prefCss()).toContain('div.sourceCode, .code-area-container');

    handle.setPreferences({ ...DEFAULT_READING_PREFERENCES, theme: 'dark' });
    expect(prefCss()).toContain('#202024 !important');
    expect(prefCss()).toContain('#e4e4e7 !important');
    expect(prefCss()).toContain('div.sourceCode, .code-area-container');

    handle.destroy();
  });

  it('tracks hovered/focused copyable pre blocks, deduplicates rects, and clears on navigation/reset', async () => {
    const { host, handle, contents } = await openRendered();
    const seen: (EpubCodeBlockHover | null)[] = [];
    handle.onCodeBlockHover?.((block) => seen.push(block));

    contents.document.body.innerHTML = `
      <p id="prose">Prose</p>
      <pre id="code"><code id="inner">  const x = 1;\n</code></pre>
      <table><tr><td class="linenos"><pre id="gutter">1</pre></td><td class="code"><pre id="paired"><code>const p = 1;</code></pre></td></tr></table>
    `;
    const prose = contents.document.getElementById('prose') as Element;
    const pre = contents.document.getElementById('code') as Element;
    const inner = contents.document.getElementById('inner') as Element;
    const gutter = contents.document.getElementById('gutter') as Element;
    const hostRectSpy = vi.spyOn(host, 'getBoundingClientRect');
    let fragRect = new DOMRect(120, 100, 400, 80);
    const clientRectsSpy = vi
      .spyOn(pre, 'getClientRects')
      .mockImplementation(() => [fragRect] as unknown as DOMRectList);

    // Moving over prose does not trigger hover or layout reads.
    prose.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 0 }));
    expect(seen).toEqual([]);
    expect(hostRectSpy).not.toHaveBeenCalled();
    expect(clientRectsSpy).not.toHaveBeenCalled();

    // Dragging (buttons !== 0) over code does not emit hover.
    inner.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 1 }));
    expect(seen).toEqual([]);

    // Hovering over copyable pre emits stable id, clipped rect, and exact text getter.
    inner.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: 180, clientY: 120 }),
    );
    expect(seen).toHaveLength(1);
    const first = seen[0];
    expect(first?.id).toBe('code-1');
    expect(first?.rect).toEqual({ left: 120, top: 100, right: 520, bottom: 180 });
    expect(first?.getText()).toBe('  const x = 1;\n');

    // Sub-pixel jitter that rounds to the same rect is deduplicated.
    fragRect = new DOMRect(120.2, 100.3, 400, 80);
    inner.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: 185, clientY: 125 }),
    );
    expect(seen).toHaveLength(1);

    // Moving to a gutter clears hover.
    gutter.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 0 }));
    expect(seen.at(-1)).toBeNull();

    // Click when selection is collapsed emits hover with the same stable id.
    fragRect = new DOMRect(120, 100, 400, 80);
    const collapsed = { isCollapsed: true, rangeCount: 0 } as unknown as Selection;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue(collapsed);
    try {
      inner.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 150,
          clientY: 110,
        }),
      );
      expect(seen.at(-1)?.id).toBe('code-1');

      // Non-collapsed selection ignores click.
      seen.length = 0;
      contents.document.documentElement.dispatchEvent(new MouseEvent('pointerleave'));
      expect(seen).toEqual([null]);
      getSelectionSpy.mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => 'const x = 1;',
      } as unknown as Selection);
      inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      expect(seen).toEqual([null]);
    } finally {
      getSelectionSpy.mockRestore();
    }

    // focusin triggers hover, and lifecycle events clear it.
    const focusAndClear = (clear: () => void) => {
      seen.length = 0;
      inner.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.id).toBe('code-1');
      clear();
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBeNull();
    };

    focusAndClear(() =>
      contents.document.dispatchEvent(new MouseEvent('pointerdown', { button: 0 })),
    );
    focusAndClear(() =>
      fake.state.listeners.relocated?.({
        start: { cfi: 'epubcfi(/6/2!/4/2/1:0)', href: 'chapter1.xhtml' },
        end: { cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      }),
    );
    focusAndClear(() => void handle.next());
    focusAndClear(() => handle.beginScrub());
    focusAndClear(() => handle.resize(640, 480));
    focusAndClear(() => void handle.setReadingMode('scroll'));
    focusAndClear(() => handle.setPreferences({ ...DEFAULT_READING_PREFERENCES, theme: 'dark' }));

    // destroy clears active hover and ignores subsequent events.
    seen.length = 0;
    inner.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(seen).toHaveLength(1);
    handle.destroy();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeNull();

    inner.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 0 }));
    expect(seen).toHaveLength(2);
  });

  it('hovers and click-activates HTML5-misparsed Pandoc sourceCode blocks without opening LinkPeek', async () => {
    const { handle, contents } = await openRendered();
    Reflect.set(contents, 'sectionIndex', 0);
    const links: string[] = [];
    const seen: (EpubCodeBlockHover | null)[] = [];
    handle.onInternalLink((href) => links.push(href));
    handle.onCodeBlockHover?.((block) => seen.push(block));

    // HTML5 (`text/html`) parses self-closing `<a .../>` as wrapping the line's tokens.
    const parsed = new DOMParser().parseFromString(
      `<div class="sourceCode" id="cb1"><pre class="sourceCode bash"><code class="sourceCode bash"><span id="cb1-1"><a href="#cb1-1" aria-hidden="true" tabindex="-1"/><span class="ex">cmd</span> arg</span></code></pre></div>`,
      'text/html',
    );
    contents.document.body.innerHTML = parsed.body.innerHTML;
    const pre = contents.document.querySelector('pre') as Element;
    const token = contents.document.querySelector('span.ex') as Element;
    vi.spyOn(pre, 'getClientRects').mockReturnValue([
      new DOMRect(120, 100, 400, 40),
    ] as unknown as DOMRectList);

    token.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: 140, clientY: 115 }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.getText()).toBe('cmd arg');

    // pointerdown clears hover, then clicking inside the wrapped `<a aria-hidden="true">`
    // must suppress LinkPeek while still restoring code-block hover when selection is collapsed.
    const collapsed = { isCollapsed: true, rangeCount: 0 } as unknown as Selection;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue(collapsed);
    try {
      token.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      expect(seen.at(-1)).toBeNull();
      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 140,
        clientY: 115,
      });
      token.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(links).toEqual([]);
      expect(seen.at(-1)?.getText()).toBe('cmd arg');
    } finally {
      getSelectionSpy.mockRestore();
      handle.destroy();
    }
  });

  it('clears stuck hover via parent-document pointer events outside the pill and 24px top bridge', async () => {
    const { host, handle, contents } = await openRendered();
    document.body.appendChild(host);
    const pill = document.createElement('div');
    pill.dataset.testid = 'epub-code-action-pill';
    const copyBtn = document.createElement('button');
    copyBtn.dataset.testid = 'epub-code-copy';
    pill.appendChild(copyBtn);
    document.body.appendChild(pill);

    const hostChild = document.createElement('div');
    host.appendChild(hostChild);

    try {
      const seen: (EpubCodeBlockHover | null)[] = [];
      handle.onCodeBlockHover?.((block) => seen.push(block));
      contents.document.body.innerHTML = '<pre id="code"><code>let x = 1;</code></pre>';
      const pre = contents.document.getElementById('code') as Element;
      vi.spyOn(pre, 'getClientRects').mockReturnValue([
        new DOMRect(200, 120, 400, 80),
      ] as unknown as DOMRectList);

      // Open hover via focusin (without chapterDoc pointer entry).
      pre.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.rect).toEqual({ left: 200, top: 120, right: 600, bottom: 200 });

      // Hovering inside the pill keeps it open.
      copyBtn.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 0 }));
      expect(seen).toHaveLength(1);

      // Moving inside host within the block's rect + 24px top bridge keeps it open.
      hostChild.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: 350, clientY: 100 }),
      );
      expect(seen).toHaveLength(1);

      // Pressing inside the pill keeps it open.
      copyBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      expect(seen).toHaveLength(1);

      // Moving pointer onto outer chrome (e.g. (1, 1)) clears hover immediately.
      document.body.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: 1, clientY: 1 }),
      );
      expect(seen).toHaveLength(2);
      expect(seen[1]).toBeNull();

      // Re-open via focusin and verify pointerdown on outer chrome also clears hover.
      pre.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(seen).toHaveLength(3);
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      expect(seen).toHaveLength(4);
      expect(seen[3]).toBeNull();
    } finally {
      handle.destroy();
      host.remove();
      pill.remove();
    }
  });

  it('disables native link drag on pre a[aria-hidden="true"] via CSS and dragstart', async () => {
    const { handle, contents } = await openRendered();
    const typographyCss =
      contents.document.querySelector('style[data-synapse-typography="true"]')?.textContent ?? '';
    const prefCss =
      contents.document.querySelector('style[data-synapse-preferences="true"]')?.textContent ?? '';

    expect(typographyCss).toContain('pre a[aria-hidden="true"],\npre a[aria-hidden="true"] *');
    expect(typographyCss).toContain('-webkit-user-drag: none;');
    expect(typographyCss).toContain('-webkit-user-select: text;');
    expect(typographyCss).toContain('user-select: text;');
    expect(prefCss).toContain('pre a[aria-hidden="true"],\npre a[aria-hidden="true"] *');
    expect(prefCss).toContain('-webkit-user-drag: none !important;');
    expect(prefCss).toContain('-webkit-user-select: text !important;');
    expect(prefCss).toContain('user-select: text !important;');
    expect(prefCss).toContain('cursor: text !important;');

    const parsed = new DOMParser().parseFromString(
      `<pre class="sourceCode"><code><a id="a-hidden" href="#cb1-1" aria-hidden="true"><span id="tok">word</span></a></code></pre><a id="regular-link" href="#other">other</a>`,
      'text/html',
    );
    contents.document.body.innerHTML = parsed.body.innerHTML;

    const dragHidden = new Event('dragstart', { bubbles: true, cancelable: true });
    contents.document.getElementById('tok')?.dispatchEvent(dragHidden);
    expect(dragHidden.defaultPrevented).toBe(true);

    const dragRegular = new Event('dragstart', { bubbles: true, cancelable: true });
    contents.document.getElementById('regular-link')?.dispatchEvent(dragRegular);
    expect(dragRegular.defaultPrevented).toBe(false);

    handle.destroy();
  });

  it('adds focus-visible ring and manages tabindex on visible copyable pre blocks across mutations and relocations', async () => {
    const { host, handle, contents } = await openRendered();
    try {
      const typographyCss =
        contents.document.querySelector('style[data-synapse-typography="true"]')?.textContent ?? '';
      const prefCss =
        contents.document.querySelector('style[data-synapse-preferences="true"]')?.textContent ??
        '';
      expect(typographyCss).toContain('pre:focus-visible');
      expect(prefCss).toContain('pre:focus-visible');

      const iframe = document.createElement('iframe');
      host.appendChild(iframe);
      document.body.appendChild(host);
      const frameDoc = iframe.contentDocument as Document;
      const frameWin = iframe.contentWindow as Window;
      vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 2000, 600));
      frameDoc.body.innerHTML = `
        <pre id="plain"><code>const x = 1;</code></pre>
        <pre id="offscreen"><code>const z = 3;</code></pre>
        <table><tr><td class="linenos"><pre id="gutter">1</pre></td><td class="code"><pre id="paired"><code>const p = 1;</code></pre></td></tr></table>
        <pre id="authored" tabindex="2"><code>const y = 2;</code></pre>
      `;
      const plain = frameDoc.getElementById('plain') as Element;
      const offscreen = frameDoc.getElementById('offscreen') as Element;
      const gutter = frameDoc.getElementById('gutter') as Element;
      const paired = frameDoc.getElementById('paired') as Element;
      const authored = frameDoc.getElementById('authored') as Element;

      let offscreenRect = new DOMRect(1500, 100, 300, 40);
      vi.spyOn(plain, 'getClientRects').mockReturnValue([
        new DOMRect(150, 100, 300, 40),
      ] as unknown as DOMRectList);
      vi.spyOn(offscreen, 'getClientRects').mockImplementation(
        () => [offscreenRect] as unknown as DOMRectList,
      );
      vi.spyOn(gutter, 'getClientRects').mockReturnValue([
        new DOMRect(110, 150, 30, 40),
      ] as unknown as DOMRectList);
      vi.spyOn(paired, 'getClientRects').mockReturnValue([
        new DOMRect(150, 150, 300, 40),
      ] as unknown as DOMRectList);
      vi.spyOn(authored, 'getClientRects').mockReturnValue([
        new DOMRect(150, 200, 300, 40),
      ] as unknown as DOMRectList);

      const frameContents = {
        document: frameDoc,
        window: frameWin,
        cfiFromRange: () => 'epubcfi(/6/2!/4/2/1:0)',
        expand: vi.fn(),
      };
      fake.state.contents.push(frameContents as unknown as (typeof fake.state.contents)[number]);
      for (const hook of fake.state.renditionHooks) {
        hook(frameContents as unknown as (typeof fake.state.contents)[number]);
      }

      expect(plain.getAttribute('tabindex')).toBe('0');
      expect(plain.getAttribute('data-synapse-tabindex')).toBe('true');
      expect(offscreen.hasAttribute('tabindex')).toBe(false);
      expect(gutter.hasAttribute('tabindex')).toBe(false);
      expect(paired.getAttribute('tabindex')).toBe('0');
      expect(authored.getAttribute('tabindex')).toBe('2');
      expect(authored.hasAttribute('data-synapse-tabindex')).toBe(false);

      // Moving offscreen block into visible viewport on relocate restores its managed tabindex.
      offscreenRect = new DOMRect(150, 300, 300, 40);
      fake.state.listeners.relocated?.({
        start: { cfi: 'epubcfi(/6/2!/4/2/1:0)', href: 'chapter1.xhtml' },
        end: { cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      });
      expect(offscreen.getAttribute('tabindex')).toBe('0');
      expect(offscreen.getAttribute('data-synapse-tabindex')).toBe('true');

      // DOM mutation adding a new visible <pre> updates tab stops via MutationObserver.
      const added = frameDoc.createElement('pre');
      added.innerHTML = '<code>const added = true;</code>';
      vi.spyOn(added, 'getClientRects').mockReturnValue([
        new DOMRect(150, 400, 300, 40),
      ] as unknown as DOMRectList);
      frameDoc.body.appendChild(added);
      await Promise.resolve();
      expect(added.getAttribute('tabindex')).toBe('0');
      expect(added.getAttribute('data-synapse-tabindex')).toBe('true');
    } finally {
      handle.destroy();
      host.remove();
    }
  });

  it('bridges Tab from focused <pre> to the action pill, returns or advances focus, and clears on outside focusin', async () => {
    const { host, handle } = await openRendered();
    document.body.appendChild(host);

    const pill = document.createElement('div');
    pill.dataset.testid = 'epub-code-action-pill';
    const copyBtn = document.createElement('button');
    copyBtn.dataset.testid = 'epub-code-copy';
    const expandBtn = document.createElement('button');
    expandBtn.dataset.testid = 'epub-code-expand';
    pill.append(copyBtn, expandBtn);
    document.body.appendChild(pill);

    const afterHost = document.createElement('button');
    afterHost.id = 'after-host';
    document.body.appendChild(afterHost);

    const copyBuffer = document.createElement('textarea');
    copyBuffer.setAttribute('data-synapse-copy-buffer', 'true');
    document.body.appendChild(copyBuffer);

    try {
      const seen: (EpubCodeBlockHover | null)[] = [];
      handle.onCodeBlockHover?.((block) => seen.push(block));

      const iframe = document.createElement('iframe');
      host.appendChild(iframe);
      const frameDoc = iframe.contentDocument as Document;
      const frameWin = iframe.contentWindow as Window;
      const frameFocusSpy = vi.spyOn(frameWin, 'focus').mockImplementation(() => undefined);
      vi.spyOn(iframe, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 40, 800, 600));
      frameDoc.body.innerHTML = `
        <pre id="code1"><code><a href="#hidden-line" aria-hidden="true">1</a>let a = 1;</code></pre>
        <a id="chapter-link" href="#next">Next</a>
      `;
      const code1 = frameDoc.getElementById('code1') as HTMLElement;
      const chapterLink = frameDoc.getElementById('chapter-link') as HTMLElement;
      vi.spyOn(code1, 'getClientRects').mockReturnValue([
        new DOMRect(20, 40, 400, 60),
      ] as unknown as DOMRectList);
      vi.spyOn(chapterLink, 'getClientRects').mockReturnValue([
        new DOMRect(20, 120, 80, 20),
      ] as unknown as DOMRectList);

      const frameContents = {
        document: frameDoc,
        window: frameWin,
        cfiFromRange: () => 'epubcfi(/6/2!/4/2/1:0)',
        expand: vi.fn(),
      };
      fake.state.contents.push(frameContents as unknown as (typeof fake.state.contents)[number]);
      for (const hook of fake.state.renditionHooks) {
        hook(frameContents as unknown as (typeof fake.state.contents)[number]);
      }

      // Focus on <pre> emits hover with focusBlock and focusAfterBlock helpers.
      code1.focus();
      code1.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(seen).toHaveLength(1);
      const hovered = seen[0];
      expect(hovered).not.toBeNull();

      // Bare Tab on focused <pre> hands focus to epub-code-copy.
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      code1.dispatchEvent(tabEvent);
      expect(tabEvent.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(copyBtn);

      // focusBlock moves focus back onto <pre> inside the chapter frame.
      expect(hovered?.focusBlock?.()).toBe(true);
      expect(frameFocusSpy).toHaveBeenCalledTimes(1);
      expect(frameDoc.activeElement).toBe(code1);

      // focusAfterBlock skips internal aria-hidden links and lands on the next tabbable chapter link.
      expect(hovered?.focusAfterBlock?.()).toBe(true);
      expect(frameFocusSpy).toHaveBeenCalledTimes(2);
      expect(frameDoc.activeElement).toBe(chapterLink);

      // Without further chapter tabbables, focusAfterBlock clears hover and moves to ownerDoc after host.
      chapterLink.remove();
      code1.focus();
      code1.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      const rehovered = seen.at(-1);
      expect(rehovered?.focusAfterBlock?.()).toBe(true);
      expect(seen.at(-1)).toBeNull();
      expect(document.activeElement).toBe(afterHost);

      // focusin on copy-buffer does not dismiss; focusin on outside chrome dismisses hover.
      code1.focus();
      code1.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(seen.at(-1)).not.toBeNull();
      copyBuffer.focus();
      copyBuffer.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(seen.at(-1)).not.toBeNull();
      afterHost.focus();
      afterHost.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      expect(seen.at(-1)).toBeNull();
    } finally {
      handle.destroy();
      host.remove();
      pill.remove();
      afterHost.remove();
      copyBuffer.remove();
    }
  });
});

describe('EPUB continuous scroll paging (#103)', () => {
  beforeEach(() => {
    fake.state.displays = [];
    fake.state.resizes = [];
    fake.state.pending = [];
    fake.state.contents = [];
    fake.state.views = [];
    fake.state.spineHooks = [];
    fake.state.renditionHooks = [];
    fake.state.listeners = {};
    for (const item of fake.spineItems) {
      delete item.document;
    }
    fake.rendition.location = undefined;
  });

  const setupScrolledHost = () => {
    const host = document.createElement('div');
    const scroller = document.createElement('div');
    scroller.className = 'epub-container';
    let scrollTop = 0;
    let scrollHeight = 2000;
    const clientHeight = 400;
    Object.defineProperty(scroller, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    });
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(Math.max(value, 0), Math.max(0, scrollHeight - clientHeight));
      },
      configurable: true,
    });
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(0, 0, 600, clientHeight),
    );
    host.appendChild(scroller);
    return {
      host,
      scroller,
      get scrollTop() {
        return scrollTop;
      },
      set scrollTop(value: number) {
        scrollTop = value;
      },
      setScrollHeight(value: number) {
        scrollHeight = value;
      },
    };
  };

  it('uses computeScrollPageStep with iframe body lines and enforces chapter seam boundaries', async () => {
    const scrollState = setupScrolledHost();
    const { host, scroller } = scrollState;
    const reportLocation = vi.fn();
    Reflect.set(fake.rendition, 'manager', { container: scroller, layout: {} });
    Reflect.set(fake.rendition, 'reportLocation', reportLocation);

    const ch1Doc = document.implementation.createHTMLDocument('');
    ch1Doc.body.innerHTML = '<p id="p1">First</p><p id="p2">Straddling bottom line</p>';
    const ch2Doc = document.implementation.createHTMLDocument('');
    ch2Doc.body.innerHTML = '<p>Chapter two start</p>';

    // Provide deterministic line rects inside chapter 1 so a line straddling y=388..412
    // causes computeScrollPageStep to stop cleanly above it (~364) rather than blind 340.
    const createRangeOrig = ch1Doc.createRange.bind(ch1Doc);
    vi.spyOn(ch1Doc, 'createRange').mockImplementation(() => {
      const range = createRangeOrig();
      let selected: Node | null = null;
      range.selectNodeContents = (node: Node) => {
        selected = node;
      };
      range.getClientRects = () => {
        const text = selected?.nodeValue ?? '';
        if (text.includes('First')) return [new DOMRect(20, 20, 200, 24)] as unknown as DOMRectList;
        if (text.includes('Straddling')) {
          return [new DOMRect(20, 388, 220, 24)] as unknown as DOMRectList;
        }
        return [] as unknown as DOMRectList;
      };
      return range;
    });

    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(async () => {
      scrollState.scrollTop = 0;
      scrollState.setScrollHeight(1200);
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      fake.state.contents = [{ document: ch2Doc, window, cfiFromRange: () => '', expand: vi.fn() }];
    });
    const prevExpand = vi.fn();
    const prevSpy = vi.spyOn(fake.rendition, 'prev').mockImplementation(async () => {
      // Simulate epubjs DefaultViewManager.prev() landing at scrollTop = 0 while loading ch1.
      scrollState.scrollTop = 0;
      scrollState.setScrollHeight(1650);
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      fake.state.contents = [
        { document: ch1Doc, window, cfiFromRange: () => '', expand: prevExpand },
      ];
    });

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      fake.state.contents = [{ document: ch1Doc, window, cfiFromRange: () => '', expand: vi.fn() }];
      const handle = await openEpubDocument(
        { kind: 'bytes', bytes: new Uint8Array() },
        host,
        'scroll',
      );

      // At start of chapter 1 (book start): backward returns false without calling prev().
      expect(await handle.turnPage(-1, { animate: false, transition: 'fade' })).toBe(false);
      expect(prevSpy).not.toHaveBeenCalled();

      // Forward within chapter 1: places straddling line (top=388, lineHeight=24 -> pad=24) at 364.
      expect(await handle.turnPage(1, { animate: false, transition: 'fade' })).toBe(true);
      expect(scrollState.scrollTop).toBe(364);
      expect(nextSpy).not.toHaveBeenCalled();

      // Still before bottom (2000 - 400 = 1600): does not cross chapter yet.
      scrollState.scrollTop = 1500;
      expect(await handle.turnPage(1, { animate: false, transition: 'fade' })).toBe(true);
      expect(scrollState.scrollTop).toBe(1600);
      expect(nextSpy).not.toHaveBeenCalled();

      // Now at scroll bottom (>= 1599): crosses into chapter 2.
      expect(await handle.turnPage(1, { animate: false, transition: 'fade' })).toBe(true);
      expect(nextSpy).toHaveBeenCalledTimes(1);
      expect(scrollState.scrollTop).toBe(0);

      // At bottom of last chapter (chapter 2, scrollHeight=1200 -> maxTop=800): returns false.
      scrollState.scrollTop = 800;
      expect(await handle.turnPage(1, { animate: false, transition: 'fade' })).toBe(false);
      expect(nextSpy).toHaveBeenCalledTimes(1);

      // Back to top of chapter 2 (scrollTop=0): crosses backward into chapter 1 and lands at bottom!
      scrollState.scrollTop = 0;
      reportLocation.mockClear();
      expect(await handle.turnPage(-1, { animate: false, transition: 'fade' })).toBe(true);
      expect(prevSpy).toHaveBeenCalledTimes(1);
      expect(prevExpand).toHaveBeenCalledTimes(1);
      expect(scrollState.scrollTop).toBe(1250); // 1650 - 400
      expect(reportLocation).toHaveBeenCalled();

      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      Reflect.set(fake.rendition, 'reportLocation', undefined);
      nextSpy.mockRestore();
      prevSpy.mockRestore();
    }
  });
});

describe('EPUB chapter wheel, consecutive click, selection, and seam queue (#106, #107)', () => {
  beforeEach(() => {
    fake.state.displays = [];
    fake.state.resizes = [];
    fake.state.pending = [];
    fake.state.contents = [];
    fake.state.views = [];
    fake.state.spineHooks = [];
    fake.state.renditionHooks = [];
    fake.state.listeners = {};
    for (const item of fake.spineItems) {
      delete item.document;
    }
    fake.rendition.location = undefined;
  });

  it('forwards full WheelSample fields, prevents default only when handled, and wires docs once', async () => {
    const handle = await openEpubDocument(
      { kind: 'bytes', bytes: new Uint8Array() },
      document.createElement('div'),
    );
    const jump = handle.display('chapter1.xhtml');
    fake.settle('chapter1.xhtml');
    await jump;
    const contents = fake.state.contents[0];
    if (!contents) throw new Error('missing contents');

    contents.document.body.innerHTML =
      '<div id="scrollable" style="overflow-y:auto"><p id="p">Text</p></div>';
    const target = contents.document.getElementById('p') as Element;

    const received: WheelSample[] = [];
    let shouldHandle = true;
    handle.onWheel((wheel) => {
      received.push(wheel);
      return shouldHandle;
    });

    // Re-running rendition hook on the same document must not attach duplicate listeners.
    for (const hook of fake.state.renditionHooks) {
      hook(contents as unknown as Parameters<typeof hook>[0]);
    }

    const handledEvent = new WheelEvent('wheel', {
      deltaX: 2,
      deltaY: 40,
      deltaMode: 1,
      ctrlKey: false,
      metaKey: true,
      altKey: true,
      shiftKey: true,
      buttons: 1,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(handledEvent);
    expect(handledEvent.defaultPrevented).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      deltaX: 2,
      deltaY: 40,
      deltaMode: 1,
      ctrlKey: false,
      metaKey: true,
      altKey: true,
      shiftKey: true,
      buttons: 1,
      defaultPrevented: false,
      target,
    });

    shouldHandle = false;
    const unhandledEvent = new WheelEvent('wheel', {
      deltaX: 0,
      deltaY: 40,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(unhandledEvent);
    expect(unhandledEvent.defaultPrevented).toBe(false);
    expect(received).toHaveLength(2);
    handle.destroy();
  });

  it('allows multi-detail blank clicks, exposes hasSelection(), and emits cross-frame pointerup', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
    const jump = handle.display('chapter1.xhtml');
    fake.settle('chapter1.xhtml');
    await jump;
    const contents = fake.state.contents[0];
    if (!contents) throw new Error('missing contents');

    contents.document.body.innerHTML =
      '<div id="blank" style="height:200px"></div><pre id="code"><code>let x = 1;</code></pre>';
    const blank = contents.document.getElementById('blank') as Element;
    const code = contents.document.getElementById('code') as Element;

    const gestures: PageGestureSample[] = [];
    const crossUps: EpubFramePointerUp[] = [];
    const hoverSeen: (EpubCodeBlockHover | null)[] = [];
    handle.onGesture((sample) => gestures.push(sample));
    handle.onFramePointerUp?.((sample) => crossUps.push(sample));
    handle.onCodeBlockHover?.((block) => hoverSeen.push(block));

    const collapsed = { isCollapsed: true, rangeCount: 0 } as unknown as Selection;
    const getSelectionSpy = vi.spyOn(window, 'getSelection').mockReturnValue(collapsed);
    try {
      expect(handle.hasSelection()).toBe(false);

      // Consecutive blank clicks (detail 1, 2, 3) all forward gesture click samples.
      blank.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 1,
          clientX: 90,
          clientY: 80,
        }),
      );
      blank.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 2,
          clientX: 90,
          clientY: 80,
        }),
      );
      blank.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          button: 0,
          detail: 3,
          clientX: 90,
          clientY: 80,
        }),
      );
      expect(gestures.filter((g) => g.kind === 'click')).toHaveLength(3);
      expect(
        gestures.filter((g) => g.kind === 'click').every((g) => g.hasSelection === false),
      ).toBe(true);

      // Double-click selecting code sets hasSelection()=true and suppresses inspectCodeBlock.
      getSelectionSpy.mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => 'const',
      } as unknown as Selection);
      expect(handle.hasSelection()).toBe(true);
      hoverSeen.length = 0;
      code.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 2 }),
      );
      expect(hoverSeen).toEqual([]);
      const lastClick = gestures.at(-1);
      expect(lastClick?.kind === 'click' && lastClick.hasSelection).toBe(true);

      // Cross-frame pointerup: pointerdown outside frame -> pointerup inside frame emits onFramePointerUp.
      getSelectionSpy.mockReturnValue(collapsed);
      blank.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 92, clientY: 81 }),
      );
      expect(crossUps).toEqual([{ x: 92, y: 81, overContent: false, hasSelection: false }]);

      // In-frame pointerdown -> pointerup is a same-document press (browser synthesizes click).
      crossUps.length = 0;
      blank.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 92, clientY: 81 }),
      );
      blank.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 92, clientY: 81 }),
      );
      expect(crossUps).toEqual([]);

      // In-frame pointerdown followed by ownerDoc pointerup clears framePointerDown cleanly.
      blank.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 92, clientY: 81 }),
      );
      document.body.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
      blank.dispatchEvent(
        new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 95, clientY: 82 }),
      );
      expect(crossUps).toEqual([{ x: 95, y: 82, overContent: false, hasSelection: false }]);
    } finally {
      getSelectionSpy.mockRestore();
      handle.destroy();
      host.remove();
    }
  });

  it('ignores whitespace-only selections in hasSelection() and prevents native multi-click selection only on blank paginated turn margins', async () => {
    const area = document.createElement('div');
    area.dataset.testid = 'epub-page-area';
    const pageFrame = document.createElement('div');
    pageFrame.dataset.testid = 'epub-page-frame';
    const host = document.createElement('div');
    area.append(pageFrame, host);
    document.body.append(area);
    vi.spyOn(pageFrame, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 1000, 600));
    // Simulate epub-host translated during a slide while pageFrame stays stationary.
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 0, 1000, 600));

    const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
    const jump = handle.display('chapter1.xhtml');
    fake.settle('chapter1.xhtml');
    await jump;
    const contents = fake.state.contents[0];
    if (!contents) throw new Error('missing contents');

    const fakeFrame = {
      getBoundingClientRect: () => new DOMRect(300, 0, 1000, 600),
    } as unknown as Element;
    Object.defineProperty(contents.window, 'frameElement', {
      value: fakeFrame,
      configurable: true,
    });

    contents.document.body.innerHTML =
      '<div id="blank" style="height:200px"></div><p id="prose">Filler</p><pre id="code"><code id="inline">let x = 1;</code></pre><a id="link" href="#ch2">Link</a>';
    const blank = contents.document.getElementById('blank') as Element;
    const prose = contents.document.getElementById('prose') as Element;
    const pre = contents.document.getElementById('code') as Element;
    const code = contents.document.getElementById('inline') as Element;
    const link = contents.document.getElementById('link') as Element;

    const gestures: PageGestureSample[] = [];
    handle.onGesture((sample) => gestures.push(sample));

    const dispatchMouseDown = (
      target: Element,
      init: { button?: number; detail?: number; clientX: number; clientY?: number },
    ) => {
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: init.button ?? 0,
        detail: init.detail ?? 1,
        clientX: init.clientX,
        clientY: init.clientY ?? 120,
      });
      target.dispatchEvent(event);
      return event;
    };

    const getSelectionSpy = vi.spyOn(window, 'getSelection');
    try {
      // Whitespace-only and empty non-collapsed selections are ignored by hasSelection() and gesture samples.
      for (const text of ['', ' \n\t ']) {
        getSelectionSpy.mockReturnValue({
          isCollapsed: false,
          rangeCount: 1,
          toString: () => text,
        } as unknown as Selection);
        expect(handle.hasSelection()).toBe(false);
        blank.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            button: 0,
            detail: 2,
            clientX: 750,
            clientY: 120,
          }),
        );
        const last = gestures.at(-1);
        expect(last?.kind === 'click' && last.hasSelection).toBe(false);
        // top-window x = frameRect.left(300) + clientX(750) = 1050 -> inside pageFrame[100..1100] right 12%.
        expect(dispatchMouseDown(blank, { detail: 2, clientX: 750 }).defaultPrevented).toBe(true);
      }

      // Clear selection to collapsed state.
      getSelectionSpy.mockReturnValue({ isCollapsed: true, rangeCount: 0 } as unknown as Selection);

      // detail: 1 on blank turn margin does NOT preventDefault.
      expect(dispatchMouseDown(blank, { detail: 1, clientX: 750 }).defaultPrevented).toBe(false);
      // Non-primary button does NOT preventDefault.
      expect(
        dispatchMouseDown(blank, { button: 2, detail: 2, clientX: 750 }).defaultPrevented,
      ).toBe(false);

      // Left and right stationary turn margins (topWindowX=150, 1050) DO preventDefault on detail >= 2.
      expect(dispatchMouseDown(blank, { detail: 2, clientX: -150 }).defaultPrevented).toBe(true);
      expect(dispatchMouseDown(blank, { detail: 3, clientX: 750 }).defaultPrevented).toBe(true);

      // Center non-turn zone (topWindowX = 300 + 300 = 600 inside pageFrame[100..1100]) does NOT preventDefault.
      expect(dispatchMouseDown(blank, { detail: 2, clientX: 300 }).defaultPrevented).toBe(false);

      // <pre>, <code>, and <a> inside turn zone do NOT preventDefault.
      expect(dispatchMouseDown(pre, { detail: 2, clientX: 750 }).defaultPrevented).toBe(false);
      expect(dispatchMouseDown(code, { detail: 2, clientX: 750 }).defaultPrevented).toBe(false);
      expect(dispatchMouseDown(link, { detail: 2, clientX: 750 }).defaultPrevented).toBe(false);

      // Glyph text inside turn zone does NOT preventDefault.
      const textNode = prose.firstChild as Text;
      const origCaretRange = contents.document.caretRangeFromPoint;
      const origGetClientRects = Range.prototype.getClientRects;
      contents.document.caretRangeFromPoint = () => {
        const range = contents.document.createRange();
        range.setStart(textNode, 2);
        range.setEnd(textNode, 2);
        return range;
      };
      Range.prototype.getClientRects = () =>
        [new DOMRect(740, 110, 30, 20)] as unknown as DOMRectList;
      try {
        expect(dispatchMouseDown(prose, { detail: 2, clientX: 750 }).defaultPrevented).toBe(false);
      } finally {
        contents.document.caretRangeFromPoint = origCaretRange;
        Range.prototype.getClientRects = origGetClientRects;
      }

      // Real non-whitespace selection blocks preventDefault and sets hasSelection() = true.
      getSelectionSpy.mockReturnValue({
        isCollapsed: false,
        rangeCount: 1,
        toString: () => 'Filler',
      } as unknown as Selection);
      expect(handle.hasSelection()).toBe(true);
      expect(dispatchMouseDown(blank, { detail: 2, clientX: 750 }).defaultPrevented).toBe(false);

      // Scroll mode never prevents native multi-click selection on margins (both mid-switch and after settle).
      getSelectionSpy.mockReturnValue({ isCollapsed: true, rangeCount: 0 } as unknown as Selection);
      const modeSwitch = handle.setReadingMode('scroll');
      expect(dispatchMouseDown(blank, { detail: 2, clientX: 750 }).defaultPrevented).toBe(false);
      fake.settle('chapter1.xhtml');
      await modeSwitch;
      const scrollContents = fake.state.contents[0];
      if (!scrollContents) throw new Error('missing scroll contents');
      Object.defineProperty(scrollContents.window, 'frameElement', {
        value: fakeFrame,
        configurable: true,
      });
      scrollContents.document.body.innerHTML = '<div id="scroll-blank" style="height:200px"></div>';
      const scrollBlank = scrollContents.document.getElementById('scroll-blank') as Element;
      expect(dispatchMouseDown(scrollBlank, { detail: 2, clientX: 750 }).defaultPrevented).toBe(
        false,
      );
      Object.defineProperty(scrollContents.window, 'frameElement', {
        value: null,
        configurable: true,
      });
    } finally {
      Object.defineProperty(contents.window, 'frameElement', {
        value: null,
        configurable: true,
      });
      getSelectionSpy.mockRestore();
      handle.destroy();
      area.remove();
    }
  });

  it('serializes rapid turns across a chapter seam, respects boundaries, and clears on cancellation', async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    let clock = 0;
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, cb);
      return id;
    });
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const tick = (at: number) => {
      clock = at;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(at);
    };

    const container = document.createElement('div');
    let scrollWidth = 1280;
    let scrollLeft = 640;
    Object.defineProperty(container, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'scrollWidth', {
      get: () => scrollWidth,
      configurable: true,
    });
    Object.defineProperty(container, 'scrollLeft', {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
      configurable: true,
    });
    const view = document.createElement('div');
    view.className = 'epub-view';
    Object.defineProperty(view, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetTop', { value: 0, configurable: true });
    Object.defineProperty(view, 'offsetWidth', { value: 1280, configurable: true });
    Object.defineProperty(view, 'offsetHeight', { value: 480, configurable: true });
    view.appendChild(document.createElement('iframe'));
    container.appendChild(view);

    Reflect.set(fake.rendition, 'manager', { container, layout: { delta: 640 } });
    const host = document.createElement('div');
    const curlHost = document.createElement('div');
    document.body.append(curlHost);
    vi.spyOn(curlHost, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 600));
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(new DOMRect(130, 0, 640, 600));

    let resolveNext!: () => void;
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNext = resolve;
        }),
    );
    let resolvePrev!: () => void;
    const prevSpy = vi.spyOn(fake.rendition, 'prev').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePrev = resolve;
        }),
    );

    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);
      handle.setCurlElements?.({ curlHost, shadow: null });

      // 1. Book start boundary returns false without calling rendition.prev() or capturing curlHost.
      scrollLeft = 0;
      expect(await handle.turnPage(-1, { animate: true, transition: 'slide', spread: false })).toBe(
        false,
      );
      expect(prevSpy).not.toHaveBeenCalled();
      expect(curlHost.style.visibility).not.toBe('visible');

      // 2. Rapid +1, +1 across Ch1 -> Ch2 seam: second turn queues without wiping curlHost,
      // skips Turn 1 post-load slide, and animates Turn 2 inside Ch2.
      scrollLeft = 640;
      const t1 = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      const t2 = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      expect(nextSpy).toHaveBeenCalledTimes(1);
      expect(curlHost.style.visibility).toBe('visible');
      const frozenMirror = curlHost.firstElementChild;
      expect(frozenMirror).not.toBeNull();

      // Resolve Ch1 -> Ch2 seam (Ch2 has 2 pages: scrollWidth=1280, scrollLeft=0).
      scrollLeft = 0;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      // Turn 2 now slides Ch2 from page 1 -> page 2 (scrollLeft=640).
      expect(scrollLeft).toBe(640);
      expect(host.style.transform).toBe('translateX(900px)');
      tick(300);
      const [r1, r2] = await Promise.all([t1, t2]);
      expect(r1).toBe(false);
      expect(r2).toBe(true);
      expect(scrollLeft).toBe(640);

      // 3. Book end boundary on Ch2 page 2 returns false without calling rendition.next().
      expect(await handle.turnPage(1, { animate: true, transition: 'slide', spread: false })).toBe(
        false,
      );
      expect(nextSpy).toHaveBeenCalledTimes(1);

      // 4. Rapid +1, -1 reversal across seam: Ch1 -> Ch2 seam in flight, -1 waits and crosses back!
      scrollLeft = 640;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const fwd = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      const rev = handle.turnPage(-1, { animate: true, transition: 'slide', spread: false });
      // Must NOT step backward inside old Chapter 1 while seam is in flight.
      expect(scrollLeft).toBe(640);
      expect(prevSpy).not.toHaveBeenCalled();

      scrollLeft = 0;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      // Reversal drains on Ch2 (at scrollLeft=0) by crossing backward via rendition.prev()!
      expect(prevSpy).toHaveBeenCalledTimes(1);
      scrollLeft = 640;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      resolvePrev();
      await Promise.resolve();
      await Promise.resolve();
      tick(600);
      const [fwdRes, revRes] = await Promise.all([fwd, rev]);
      expect(fwdRes).toBe(false);
      expect(revRes).toBe(true);

      // 5. Cancellation (beginScrub) clears pendingTurns as false. (display / setColumns / resize / destroy
      //    cancellations and scroll-mode seam queue are covered in dedicated tests below.)
      scrollLeft = 640;
      const seamTurn = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      const queuedTurn = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      handle.beginScrub({ transition: 'slide', spread: false });
      expect(await queuedTurn).toBe(false);
      resolveNext();
      expect(await seamTurn).toBe(false);

      // 6. Curl seam preserves curlHost mirror while queued and animates only the final step.
      const shadow = document.createElement('div');
      const leaf = document.createElement('div');
      leaf.dataset.curlPart = 'leaf';
      shadow.appendChild(leaf);
      handle.setCurlElements?.({ curlHost, shadow });

      scrollLeft = 640;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const curlSeam = handle.turnPage(1, { animate: false, transition: 'curl', spread: false });
      const curlQueued = handle.turnPage(1, { animate: false, transition: 'curl', spread: false });
      expect(curlHost.style.visibility).toBe('visible');
      expect(curlHost.childElementCount).toBeGreaterThan(0);

      // Chapter 2 has 2 pages -> queued turn advances from 0 to 640 with curl animation.
      scrollLeft = 0;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      await Promise.resolve();
      await Promise.resolve();
      expect(scrollLeft).toBe(640);
      tick(900);
      tick(1400);
      expect(await curlSeam).toBe(false);
      expect(await curlQueued).toBe(true);

      // 7. When Ch2 has only 1 page (book end), queued +1 is blocked at boundary and Ch1->Ch2 reports true.
      scrollLeft = 640;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const endSeam = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      const blockedNext = handle.turnPage(1, { animate: true, transition: 'slide', spread: false });
      scrollLeft = 0;
      scrollWidth = 640;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      expect(await endSeam).toBe(true);
      expect(await blockedNext).toBe(false);

      // 8. Multi-item [move, boundary-blocked] batch resolves the final moving turn as true.
      scrollLeft = 640;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const batchSeam = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const batchMove = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const batchBlocked = handle.turnPage(1, {
        animate: false,
        transition: 'fade',
        spread: false,
      });
      scrollLeft = 0;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      expect(await Promise.all([batchSeam, batchMove, batchBlocked])).toEqual([false, true, false]);
      expect(scrollLeft).toBe(640);

      // 9. Throw inside drainPendingTurns rejects only the failing queued item, resolves remaining
      //    queued turns false, and leaves the original seam turn resolved true.
      scrollLeft = 640;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      prevSpy.mockRejectedValueOnce(new Error('seam failed'));
      const errSeam = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const errQueued1 = handle.turnPage(-1, { animate: false, transition: 'fade', spread: false });
      const errQueued2 = handle.turnPage(-1, { animate: false, transition: 'fade', spread: false });
      scrollLeft = 0;
      scrollWidth = 640;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      await expect(errQueued1).rejects.toThrow('seam failed');
      expect(await errSeam).toBe(true);
      expect(await errQueued2).toBe(false);

      // 10. canCrossChapter falls back to currentChapterIndex when view.section lacks .next/.prev.
      Reflect.set(fake.rendition, 'manager', {
        container,
        layout: { delta: 640 },
        views: { _views: [{ section: { index: 0 } }] },
      });
      scrollLeft = 0;
      scrollWidth = 640;
      expect(await handle.turnPage(-1, { animate: false, transition: 'fade', spread: false })).toBe(
        false,
      );
      const fallbackTurn = handle.turnPage(1, {
        animate: false,
        transition: 'fade',
        spread: false,
      });
      resolveNext();
      expect(await fallbackTurn).toBe(true);

      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      nextSpy.mockRestore();
      prevSpy.mockRestore();
      curlHost.remove();
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('resolves queued seam turns with false on display, setColumns, resize, and destroy, and keeps resize from reopening the seam queue', async () => {
    const container = document.createElement('div');
    let scrollWidth = 1280;
    let scrollLeft = 640;
    Object.defineProperty(container, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'offsetWidth', { value: 640, configurable: true });
    Object.defineProperty(container, 'scrollWidth', {
      get: () => scrollWidth,
      configurable: true,
    });
    Object.defineProperty(container, 'scrollLeft', {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
      configurable: true,
    });
    Reflect.set(fake.rendition, 'manager', { container, layout: { delta: 640 } });

    let resolveNext!: () => void;
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNext = resolve;
        }),
    );

    const host = document.createElement('div');
    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument({ kind: 'bytes', bytes: new Uint8Array() }, host);

      // 1. display() resolves queued turns with false.
      const displaySeam = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const displayQueued = handle.turnPage(1, {
        animate: false,
        transition: 'fade',
        spread: false,
      });
      const displayDone = handle.display('chapter1.xhtml');
      expect(await displayQueued).toBe(false);
      resolveNext();
      expect(await displaySeam).toBe(false);
      fake.settle('chapter1.xhtml');
      await displayDone;

      // 2. setColumns() resolves queued turns with false.
      scrollLeft = 640;
      const colSeam = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const colQueued = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      handle.setColumns(1);
      expect(await colQueued).toBe(false);
      resolveNext();
      expect(await colSeam).toBe(false);
      handle.setColumns(2);

      // 3. resize() resolves pre-resize queued turns with false while keeping the seam queue
      //    closed so post-resize turns still queue until rendition.next() finishes.
      scrollLeft = 640;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const callsBeforeResize = nextSpy.mock.calls.length;
      const resizeSeam = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const resizeQueuedBefore = handle.turnPage(1, {
        animate: false,
        transition: 'fade',
        spread: false,
      });
      handle.resize(640, 600);
      expect(await resizeQueuedBefore).toBe(false);
      const resizeQueuedAfter = handle.turnPage(1, {
        animate: false,
        transition: 'fade',
        spread: false,
      });
      expect(nextSpy).toHaveBeenCalledTimes(callsBeforeResize + 1);
      scrollLeft = 0;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      expect(await resizeSeam).toBe(false);
      expect(await resizeQueuedAfter).toBe(true);
      expect(scrollLeft).toBe(640);

      // 4. destroy() resolves queued turns with false.
      scrollLeft = 640;
      scrollWidth = 1280;
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const destroySeam = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const destroyQueued = handle.turnPage(1, {
        animate: false,
        transition: 'fade',
        spread: false,
      });
      handle.destroy();
      expect(await destroyQueued).toBe(false);
      resolveNext();
      expect(await destroySeam).toBe(false);
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      nextSpy.mockRestore();
    }
  });

  it('queues and drains turns issued during a scroll-mode chapter seam', async () => {
    const epubContainer = document.createElement('div');
    epubContainer.className = 'epub-container';
    let scrollTop = 600;
    let scrollHeight = 1200;
    Object.defineProperty(epubContainer, 'clientHeight', { value: 600, configurable: true });
    Object.defineProperty(epubContainer, 'scrollHeight', {
      get: () => scrollHeight,
      configurable: true,
    });
    Object.defineProperty(epubContainer, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
      configurable: true,
    });
    Reflect.set(fake.rendition, 'manager', {
      container: epubContainer,
      views: { _views: [{ section: { index: 0 } }] },
    });

    let resolveNext!: () => void;
    const nextSpy = vi.spyOn(fake.rendition, 'next').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveNext = resolve;
        }),
    );

    const host = document.createElement('div');
    host.appendChild(epubContainer);
    try {
      fake.rendition.location = {
        start: { href: 'chapter1.xhtml', cfi: 'epubcfi(/6/2!/4/2/1:0)' },
      };
      const handle = await openEpubDocument(
        { kind: 'bytes', bytes: new Uint8Array() },
        host,
        'scroll',
      );
      const seam = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      const queued = handle.turnPage(1, { animate: false, transition: 'fade', spread: false });
      expect(nextSpy).toHaveBeenCalledTimes(1);

      scrollTop = 0;
      scrollHeight = 1800;
      Reflect.set(fake.rendition, 'manager', {
        container: epubContainer,
        views: { _views: [{ section: { index: 1 } }] },
      });
      fake.rendition.location = {
        start: { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
      };
      resolveNext();
      expect(await seam).toBe(false);
      expect(await queued).toBe(true);
      expect(scrollTop).toBeGreaterThan(0);
      handle.destroy();
    } finally {
      Reflect.set(fake.rendition, 'manager', undefined);
      nextSpy.mockRestore();
    }
  });
});
