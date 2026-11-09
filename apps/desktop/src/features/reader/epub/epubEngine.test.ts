import { beforeEach, describe, expect, it, vi } from 'vitest';

import { openEpubDocument } from './epubEngine';

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
    { href: 'chapter2.xhtml', cfi: 'epubcfi(/6/4!/4/2/1:0)' },
  ];
  interface Pending {
    target: string | undefined;
    resolve: () => void;
  }
  interface LocationState {
    start: { href: string; cfi: string };
  }
  const state = {
    displays: [] as (string | undefined)[],
    resizes: [] as (number | string | undefined)[][],
    contents: [] as { document: Document }[],
    pending: [] as Pending[],
  };
  const hrefOf = (target: string | undefined) =>
    chapters.find((chapter) => chapter.href === target || chapter.cfi === target)?.href;
  const sectionOf = (target: string | undefined) => {
    const found = chapters.find((chapter) => chapter.href === target || chapter.cfi === target);
    return found ? { index: chapters.indexOf(found), href: found.href } : null;
  };
  /** Resolves the pending display for `target`, as a rendered chapter would. */
  const settle = (target: string | undefined, contents = 1) => {
    const index = state.pending.findIndex((entry) => entry.target === target);
    const entry = index === -1 ? undefined : state.pending.splice(index, 1)[0];
    if (!entry) throw new Error(`no pending display for ${String(target)}`);
    const href = hrefOf(target);
    if (href) rendition.location = { start: { href, cfi: target ?? '' } };
    state.contents = Array.from({ length: contents }, () => ({ document }));
    entry.resolve();
  };
  const rendition = {
    location: undefined as LocationState | undefined,
    hooks: { content: { register: () => undefined } },
    q: {
      enqueue: (task: () => unknown) =>
        Promise.resolve()
          .then(() => task())
          .then(() => undefined),
    },
    on: () => undefined,
    getContents: () => state.contents,
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
    clear: () => undefined,
    resize: (...args: (number | string | undefined)[]) => state.resizes.push(args),
    annotations: {
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
      hooks: { content: { register: () => undefined } },
      spineItems: chapters.map(({ href }) => ({ href })),
      get: sectionOf,
    },
    renderTo: () => rendition,
    load: () => Promise.resolve(),
    destroy: () => undefined,
  };
  return { state, settle, rendition, book };
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
    // The stale location is withheld, so epub.js' resize path cannot re-display it.
    expect(fake.rendition.location).toBeUndefined();
    handle.resize(420, 900);
    expect(fake.state.resizes.at(-1)).toEqual([420, 900, 'epubcfi(/6/2!/4/2/1:0)']);
    fake.settle('epubcfi(/6/2!/4/2/1:0)');
    await jump;
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
});
