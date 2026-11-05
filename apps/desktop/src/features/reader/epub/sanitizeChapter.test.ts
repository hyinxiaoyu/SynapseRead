import { describe, expect, it } from 'vitest';

import { sanitizeChapter } from './sanitizeChapter';

const clean = (body: string) => {
  const chapter = new DOMParser().parseFromString(
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`,
    'application/xhtml+xml',
  );
  sanitizeChapter(chapter);
  return chapter;
};

describe('sanitizeChapter', () => {
  it.each([
    ['a script', '<script>alert(1)</script>', 'script'],
    ['a frame', '<iframe src="x.html"></iframe>', 'iframe'],
    ['an object', '<object data="x.swf"></object>', 'object'],
    ['an embed', '<embed src="x.swf"/>', 'embed'],
    ['a base', '<base href="https://example.com/"/>', 'base'],
  ])('removes %s', (_name, markup, tag) => {
    expect(clean(markup).getElementsByTagName(tag)).toHaveLength(0);
  });

  it('removes a script inside inline SVG', () => {
    const chapter = clean(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><circle r="1"/></svg>',
    );
    expect(chapter.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'script')).toHaveLength(0);
    expect(chapter.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'circle')).toHaveLength(1);
  });

  it('removes a refresh tag, and leaves other meta tags alone', () => {
    const chapter = clean(
      '<meta http-equiv="REFRESH" content="0;url=https://example.com"/><meta name="a" content="b"/>',
    );
    expect(chapter.querySelectorAll('meta')).toHaveLength(1);
    expect(chapter.querySelector('meta')?.getAttribute('name')).toBe('a');
  });

  it('removes event handlers, in any case', () => {
    const chapter = clean('<img src="a.png" onerror="alert(1)" ONCLICK="alert(2)" alt="kept"/>');
    const image = chapter.querySelector('img') as Element;
    expect([...image.attributes].map((attribute) => attribute.name).sort()).toEqual(['alt', 'src']);
  });

  it.each(['javascript:alert(1)', '  JavaScript:alert(1)', 'data:text/html,<script>x</script>'])(
    'removes the script URL %s',
    (url) => {
      const chapter = clean(
        `<a href="${url.replace(/</g, '&lt;').replace(/>/g, '&gt;')}">link</a>`,
      );
      expect(chapter.querySelector('a')?.hasAttribute('href')).toBe(false);
      expect(chapter.querySelector('a')?.textContent).toBe('link');
    },
  );

  it('keeps ordinary content', () => {
    const chapter = clean(
      '<h1 class="a">Title</h1><p>Text <a href="other.xhtml#x">link</a></p><img src="data:image/png;base64,AA" alt=""/>',
    );
    expect(chapter.querySelector('h1')?.className).toBe('a');
    expect(chapter.querySelector('a')?.getAttribute('href')).toBe('other.xhtml#x');
    expect(chapter.querySelector('img')?.getAttribute('src')).toMatch(/^data:image/);
  });
});
