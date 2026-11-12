import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_READING_PREFERENCES } from '@/types/domain';
import {
  decorateWithNoteMarker,
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
    on: () => undefined,
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
