import { describe, expect, it, vi } from 'vitest';

import { extractCodeBlockText, isCopyableCodeBlock, visibleCodeBlockRect } from './codeBlocks';

const parseXhtml = (body: string) =>
  new DOMParser().parseFromString(
    `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`,
    'application/xhtml+xml',
  );

describe('extractCodeBlockText', () => {
  it('preserves line-1 indentation, tabs, nbsp, prompts, comments, and callouts', () => {
    const doc = parseXhtml(
      `<pre id="p"><code>\n    def greet(name):\n\treturn f"hi {name}"\u00a0# (1)\n$ deploy-tool --env staging\n&gt;&gt;&gt; 1 + 1\n</code></pre>`,
    );
    const pre = doc.getElementById('p') as Element;
    expect(extractCodeBlockText(pre)).toBe(
      '    def greet(name):\n\treturn f"hi {name}"\u00a0# (1)\n$ deploy-tool --env staging\n>>> 1 + 1',
    );
  });

  it('normalizes CRLF/CR and strips at most one leading newline and all trailing newlines', () => {
    const doc = parseXhtml(
      `<pre id="a">\r\n\r\n  line 1\r  line 2\r\n\r\n</pre><pre id="b">\n  indented\n\n</pre>`,
    );
    expect(extractCodeBlockText(doc.getElementById('a') as Element)).toBe('\n  line 1\n  line 2');
    expect(extractCodeBlockText(doc.getElementById('b') as Element)).toBe('  indented');
  });

  it('strips Pandoc aria-hidden anchors, generated line numbers, and unsafe/UI nodes while keeping code', () => {
    const doc = parseXhtml(`
      <div class="sourceCode" id="cb1">
        <pre class="sourceCode yaml"><code class="sourceCode yaml"><span id="cb1-1"><a href="#cb1-1" aria-hidden="true" tabindex="-1"></a><span class="lineno">1 </span><span>service:</span> synthetic-worker</span>
<span id="cb1-2"><a href="#cb1-2" aria-hidden="true" tabindex="-1"></a><span data-line-number="2"></span>  <span>endpoint:</span> <a href="#callout-1">(1)</a></span><span class="line-numbers-rows"><span></span><span></span></span><span data-synapse-ui="true">Copy</span><script>alert(1)</script><style>.x{}</style><template>hidden</template><noscript>off</noscript></code></pre>
      </div>
    `);
    const pre = doc.querySelector('pre') as Element;
    expect(extractCodeBlockText(pre)).toBe('service: synthetic-worker\n  endpoint: (1)');
  });

  it('keeps code inside [data-line-number] line wrappers while skipping numeric/empty gutters', () => {
    const doc = parseXhtml(`
      <pre id="p"><code><span data-line-number="1">1</span><span class="line" data-line-number="1">const a = 1;</span>\n<span data-line-number="2">   </span><span class="line" data-line-number="2">const b = 2;</span></code></pre>
    `);
    expect(extractCodeBlockText(doc.getElementById('p') as Element)).toBe(
      'const a = 1;\nconst b = 2;',
    );
  });

  it('does not skip pre or code elements themselves if marked aria-hidden or line-numbered', () => {
    const doc = parseXhtml(
      `<pre id="p" aria-hidden="true"><code aria-hidden="true" class="ln">  kept = true</code></pre>`,
    );
    expect(extractCodeBlockText(doc.getElementById('p') as Element)).toBe('  kept = true');
  });

  it('handles br, img alt text, CDATA, and block child newline separation without duplicating newlines', () => {
    const doc = parseXhtml(`
      <pre id="blocks"><div>line 1</div><div>line 2</div>\n<div><br/></div><div>line 4 <img src="1.png" alt="(1)"/></div></pre>
      <pre id="table"><table><tbody><tr><td class="hljs-ln-numbers">1</td><td>alpha</td></tr><tr><td class="hljs-ln-numbers">2</td><td>beta</td></tr></tbody></table></pre>
      <pre id="cdata"><![CDATA[if (a < b && c > d) {}]]></pre>
      <pre id="list"><ul><li>first</li><li>second</li></ul></pre>
    `);
    expect(extractCodeBlockText(doc.getElementById('blocks') as Element)).toBe(
      'line 1\nline 2\n\nline 4 (1)',
    );
    expect(extractCodeBlockText(doc.getElementById('table') as Element)).toBe('alpha\nbeta');
    expect(extractCodeBlockText(doc.getElementById('cdata') as Element)).toBe(
      'if (a < b && c > d) {}',
    );
    expect(extractCodeBlockText(doc.getElementById('list') as Element)).toBe('first\nsecond');
  });
});

describe('isCopyableCodeBlock', () => {
  it('accepts non-empty pre elements and rejects gutters, non-pre elements, and empty blocks', () => {
    const doc = parseXhtml(`
      <p id="prose">not pre</p>
      <pre id="ok"><code>  const x = 1;</code></pre>
      <pre id="blank">   \n\t  </pre>
      <pre id="only-lines"><span class="lineno">1</span><span class="lineno">2</span></pre>
      <div class="linenodiv"><pre id="gutter-div">1\n2</pre></div>
      <pre id="gutter-self" class="linenos">1\n2</pre>
      <div data-line-numbers="true"><pre id="gutter-attr">1\n2</pre></div>
      <table><tr><td class="hljs-ln-numbers"><pre id="gutter-td">1</pre></td></tr></table>
    `);
    expect(isCopyableCodeBlock(doc.getElementById('prose') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('ok') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('blank') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('only-lines') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-div') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-self') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-attr') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-td') as Element)).toBe(false);
  });
});

describe('visibleCodeBlockRect', () => {
  const frameRect = new DOMRect(-600, 50, 2400, 600);
  const hostRect = new DOMRect(100, 50, 800, 600);

  it('clips multi-column fragments to hostRect and picks the pointer-matching or closest fragment', () => {
    const pre = document.createElement('pre');
    vi.spyOn(pre, 'getClientRects').mockReturnValue([
      new DOMRect(40, 200, 300, 200), // translated x: [-560, -260] -> offscreen left
      new DOMRect(740, 100, 320, 400), // translated x: [140, 460], y: [150, 550] -> left column
      new DOMRect(1120, 40, 320, 220), // translated x: [520, 840], y: [90, 310] -> right column
      new DOMRect(1485, 40, 200, 100), // translated x: [885, 1085] -> clipped to [885, 900] (w=15 < 24)
    ] as unknown as DOMRectList);

    // Without pointer: returns first visible fragment.
    expect(visibleCodeBlockRect(pre, frameRect, hostRect)).toEqual({
      left: 140,
      top: 150,
      right: 460,
      bottom: 550,
    });

    // Pointer inside right column fragment: returns right column fragment.
    expect(visibleCodeBlockRect(pre, frameRect, hostRect, { x: 600, y: 200 })).toEqual({
      left: 520,
      top: 90,
      right: 840,
      bottom: 310,
    });

    // Pointer slightly below right column fragment: closest horizontally picks right column.
    expect(visibleCodeBlockRect(pre, frameRect, hostRect, { x: 650, y: 340 })).toEqual({
      left: 520,
      top: 90,
      right: 840,
      bottom: 310,
    });
  });

  it('falls back to getBoundingClientRect when getClientRects is empty and filters tiny clips', () => {
    const pre = document.createElement('pre');
    vi.spyOn(pre, 'getClientRects').mockReturnValue([] as unknown as DOMRectList);
    vi.spyOn(pre, 'getBoundingClientRect').mockReturnValue(new DOMRect(720, 20, 120, 40));

    expect(visibleCodeBlockRect(pre, frameRect, hostRect)).toEqual({
      left: 120,
      top: 70,
      right: 240,
      bottom: 110,
    });

    vi.spyOn(pre, 'getBoundingClientRect').mockReturnValue(new DOMRect(720, 20, 20, 40));
    expect(visibleCodeBlockRect(pre, frameRect, hostRect)).toBeNull();
  });
});
