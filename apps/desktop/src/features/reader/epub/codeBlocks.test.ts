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
      '\n    def greet(name):\n\treturn f"hi {name}"\u00a0# (1)\n$ deploy-tool --env staging\n>>> 1 + 1\n',
    );
  });

  it('normalizes CRLF/CR while preserving source leading and trailing newlines', () => {
    const doc = parseXhtml(
      `<pre id="a">\r\n\r\n  line 1\r  line 2\r\n\r\n</pre><pre id="b">\n  indented\n\n</pre><pre id="c">  exact</pre>`,
    );
    expect(extractCodeBlockText(doc.getElementById('a') as Element)).toBe(
      '\n\n  line 1\n  line 2\n\n',
    );
    expect(extractCodeBlockText(doc.getElementById('b') as Element)).toBe('\n  indented\n\n');
    expect(extractCodeBlockText(doc.getElementById('c') as Element)).toBe('  exact');
  });

  it('ignores CSS line-number placeholders and unsafe/hidden/UI nodes while keeping code', () => {
    const doc = parseXhtml(`
      <div class="sourceCode" id="cb1">
        <pre class="sourceCode yaml"><code class="sourceCode yaml"><span id="cb1-1"><a href="#cb1-1" aria-hidden="true" tabindex="-1"></a><span class="lineno"></span><span>service:</span> synthetic-worker</span>
<span id="cb1-2"><a href="#cb1-2" aria-hidden="true" tabindex="-1"></a><span data-line-number="2"></span>  <span>endpoint:</span> <a href="#callout-1">(1)</a></span><span class="line-numbers-rows"><span></span><span></span></span><span hidden="hidden">ignored</span><span data-synapse-ui="true">Copy</span><script>alert(1)</script><style>.x{}</style><template>hidden</template><noscript>off</noscript></code></pre>
      </div>
    `);
    const pre = doc.querySelector('pre') as Element;
    expect(extractCodeBlockText(pre)).toBe('service: synthetic-worker\n  endpoint: (1)');
  });

  it('strips unambiguous Chroma .line > (.ln + .cl) and paired hljs-ln table line numbers while keeping ambiguous markup', () => {
    const doc = parseXhtml(`
      <pre id="chroma-basic" class="chroma"><code><span class="line"><span class="ln">1</span><span class="cl">print(1)</span></span>
<span class="line"><span class="ln">2</span><span class="cl">print(2)</span></span></code></pre>
      <pre id="chroma-hl" class="chroma"><code><span class="line hl"><span class="ln"> 10 </span><span class="cl">const a = 1;</span></span><span class="line"><span class="ln"> 11 </span><span class="cl"></span></span><span class="line"><span class="ln"> 12 </span><span class="cl">const b = 2;</span></span></code></pre>
      <pre id="chroma-adjacent-empty" class="chroma"><code><span class="line"><span class="ln">1</span><span class="cl">alpha</span></span><span class="line"><span class="ln">2</span><span class="cl"></span></span><span class="line"><span class="ln">3</span><span class="cl">beta</span></span></code></pre>
      <pre id="chroma-separated-empty" class="chroma"><code><span class="line"><span class="ln">1</span><span class="cl">alpha</span></span>\n<span class="line"><span class="ln">2</span><span class="cl"></span></span>\n<span class="line"><span class="ln">3</span><span class="cl">beta</span></span></code></pre>
      <pre id="chroma-leading-empty" class="chroma"><code><span class="line"><span class="ln">1</span><span class="cl"></span></span><span class="line"><span class="ln">2</span><span class="cl">beta</span></span></code></pre>
      <pre id="chroma-blank-newline" class="chroma"><code><span class="line"><span class="ln">1</span><span class="cl">const a = 1;\n</span></span><span class="line"><span class="ln">2</span><span class="cl">\n</span></span><span class="line"><span class="ln">3</span><span class="cl">const b = 2;\n</span></span></code></pre>
      <pre id="chroma-anchor" class="chroma"><code><span class="line"><span class="ln"><a href="#l1">1</a></span><span class="cl">alpha</span></span>\n<span class="line"><span class="ln"><a href="#l2">2</a></span><span class="cl">beta</span></span></code></pre>
      <pre id="chroma-nested-ln" class="chroma"><code><span class="line"><span class="cl"><span class="ln">1</span> + 2</span></span>\n<span class="line"><span class="cl"><span class="ln">2</span> + 3</span></span></code></pre>
      <pre id="chroma-expr-between" class="chroma"><code><span class="line"><span class="ln">1</span> + <span class="cl">2</span></span>\n<span class="line"><span class="ln">2</span> + <span class="cl">3</span></span></code></pre>
      <pre id="chroma-nonseq" class="chroma"><code><span class="line"><span class="ln">123</span><span class="cl"> + a</span></span>\n<span class="line"><span class="ln">456</span><span class="cl"> + b</span></span></code></pre>
      <pre id="hljs-table"><table><tbody><tr><td class="hljs-ln-numbers">1</td><td class="hljs-ln-code">alpha</td></tr><tr><td class="hljs-ln-numbers">2</td><td class="hljs-ln-code">beta</td></tr></tbody></table></pre>
    `);
    expect(extractCodeBlockText(doc.getElementById('chroma-basic') as Element)).toBe(
      'print(1)\nprint(2)',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-hl') as Element)).toBe(
      'const a = 1;\n\nconst b = 2;',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-adjacent-empty') as Element)).toBe(
      'alpha\n\nbeta',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-separated-empty') as Element)).toBe(
      'alpha\n\nbeta',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-leading-empty') as Element)).toBe(
      '\nbeta',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-blank-newline') as Element)).toBe(
      'const a = 1;\n\nconst b = 2;\n',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-anchor') as Element)).toBe(
      'alpha\nbeta',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-nested-ln') as Element)).toBe(
      '1 + 2\n2 + 3',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-expr-between') as Element)).toBe(
      '1 + 2\n2 + 3',
    );
    expect(extractCodeBlockText(doc.getElementById('chroma-nonseq') as Element)).toBe(
      '123 + a\n456 + b',
    );
    expect(extractCodeBlockText(doc.getElementById('hljs-table') as Element)).toBe('alpha\nbeta');
  });

  it('preserves code wrapped by HTML5-misparsed self-closing Pandoc anchors in text/html chapters', () => {
    const doc = new DOMParser().parseFromString(
      `<div class="sourceCode" id="cb1"><pre class="sourceCode bash"><code class="sourceCode bash"><span id="cb1-1"><a href="#cb1-1" aria-hidden="true" tabindex="-1"/><span class="ex">cmd</span> arg</span>\n<span id="cb1-2"><a href="#cb1-2" aria-hidden="true" tabindex="-1"/>  # plain comment</span></code></pre></div>`,
      'text/html',
    );
    const pre = doc.querySelector('pre') as Element;
    expect(isCopyableCodeBlock(pre)).toBe(true);
    expect(extractCodeBlockText(pre)).toBe('cmd arg\n  # plain comment');
  });

  it('handles br, img alt text, CDATA, and block child newline separation without duplicating newlines', () => {
    const doc = parseXhtml(`
      <pre id="blocks"><div>line 1</div><div>line 2</div>\n<div><br/></div><div>line 4 <img src="1.png" alt="(1)"/></div></pre>
      <pre id="table"><table><tbody><tr><td>alpha</td></tr><tr><td>beta</td></tr></tbody></table></pre>
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

  it('preserves visible source tokens inside line-number classes, data-line-number, and aria-hidden nodes', () => {
    const doc = parseXhtml(`
      <pre id="code-ln"><code><span class="ln">print(1)</span></code></pre>
      <pre id="code-gutter"><code><span class="gutter">x = 1</span></code></pre>
      <pre id="code-lineno"><code><span class="lineno">foo()</span></code></pre>
      <pre id="wrapped-ln"><code><span class="ln">x = [</span>\n<span class="ln">  2</span>\n<span class="ln">]</span></code></pre>
      <pre id="mid-ln"><code>const sum = <span class="ln">1</span> + <span class="ln">2</span>;</code></pre>
      <pre id="expr-lineno"><code><span class="lineno">1</span> + 2\n<span class="lineno">2</span> + 3</code></pre>
      <pre id="expr-data"><code><span data-line-number="1">1</span> + 2\n<span data-line-number="2">2</span> + 3</code></pre>
      <pre id="expr-ln-space"><code><span class="ln">1 </span>+ 2\n<span class="ln">2 </span>+ 3</code></pre>
      <pre id="expr-aria-anchor"><code><a href="#cb1-1" aria-hidden="true">1</a> + 2\n<a href="#cb1-2" aria-hidden="true">2</a> + 3</code></pre>
      <pre id="expr-aria-span"><code><span aria-hidden="true">1</span> + 2\n<span aria-hidden="true">2</span> + 3</code></pre>
      <pre id="mid-data-line"><code>const x = <span data-line-number="2">2</span>;</code></pre>
      <pre id="aria-mid-num"><code>x = <span aria-hidden="true">99</span></code></pre>
      <pre id="css-counter-lines" data-line-numbers="true"><code><span class="line" data-line-number="1">const a = 1;</span>\n<span class="line" data-line-number="2">const b = 2;</span></code></pre>
    `);
    expect(extractCodeBlockText(doc.getElementById('code-ln') as Element)).toBe('print(1)');
    expect(extractCodeBlockText(doc.getElementById('code-gutter') as Element)).toBe('x = 1');
    expect(extractCodeBlockText(doc.getElementById('code-lineno') as Element)).toBe('foo()');
    expect(extractCodeBlockText(doc.getElementById('wrapped-ln') as Element)).toBe('x = [\n  2\n]');
    expect(extractCodeBlockText(doc.getElementById('mid-ln') as Element)).toBe(
      'const sum = 1 + 2;',
    );
    expect(extractCodeBlockText(doc.getElementById('expr-lineno') as Element)).toBe('1 + 2\n2 + 3');
    expect(extractCodeBlockText(doc.getElementById('expr-data') as Element)).toBe('1 + 2\n2 + 3');
    expect(extractCodeBlockText(doc.getElementById('expr-ln-space') as Element)).toBe(
      '1 + 2\n2 + 3',
    );
    expect(extractCodeBlockText(doc.getElementById('expr-aria-anchor') as Element)).toBe(
      '1 + 2\n2 + 3',
    );
    expect(extractCodeBlockText(doc.getElementById('expr-aria-span') as Element)).toBe(
      '1 + 2\n2 + 3',
    );
    expect(extractCodeBlockText(doc.getElementById('mid-data-line') as Element)).toBe(
      'const x = 2;',
    );
    expect(extractCodeBlockText(doc.getElementById('aria-mid-num') as Element)).toBe('x = 99');
    expect(extractCodeBlockText(doc.getElementById('css-counter-lines') as Element)).toBe(
      'const a = 1;\nconst b = 2;',
    );
  });

  it('preserves pure-numeric code blocks, REPL outputs, and non-consecutive numbers even with line-number attributes', () => {
    const doc = parseXhtml(`
      <pre id="num-ln"><code><span class="ln">123</span>\n<span class="ln">456</span></code></pre>
      <pre id="seq-ln"><code><span class="ln">1</span>\n<span class="ln">2</span></code></pre>
      <pre id="seq-lineno"><code><span class="lineno">1</span>\n<span class="lineno">2</span></code></pre>
      <pre id="seq-data"><code><span data-line-number="1">1</span>\n<span data-line-number="2">2</span></code></pre>
      <pre id="repl-ln"><code>&gt;&gt;&gt; 6 * 7\n<span class="ln">42</span></code></pre>
      <pre id="lead-expr-ln"><code><span class="ln">1</span> + x</code></pre>
      <pre id="obj-keys-ln"><code><span class="ln">1</span>: "one",\n<span class="ln">2</span>: "two"</code></pre>
      <pre id="arr-ln"><code>[\n<span class="ln">1</span>,\n<span class="ln">2</span>\n]</code></pre>
      <pre id="num-data-attr" data-line-numbers="true"><code>123\n456</code></pre>
      <pre id="aria-pre" aria-hidden="true"><code aria-hidden="true" class="ln">  kept = true</code></pre>
    `);

    const numLn = doc.getElementById('num-ln') as Element;
    expect(isCopyableCodeBlock(numLn)).toBe(true);
    expect(extractCodeBlockText(numLn)).toBe('123\n456');

    const seqLn = doc.getElementById('seq-ln') as Element;
    expect(isCopyableCodeBlock(seqLn)).toBe(true);
    expect(extractCodeBlockText(seqLn)).toBe('1\n2');

    const seqLineno = doc.getElementById('seq-lineno') as Element;
    expect(isCopyableCodeBlock(seqLineno)).toBe(true);
    expect(extractCodeBlockText(seqLineno)).toBe('1\n2');

    const seqData = doc.getElementById('seq-data') as Element;
    expect(isCopyableCodeBlock(seqData)).toBe(true);
    expect(extractCodeBlockText(seqData)).toBe('1\n2');

    expect(extractCodeBlockText(doc.getElementById('repl-ln') as Element)).toBe('>>> 6 * 7\n42');
    expect(extractCodeBlockText(doc.getElementById('lead-expr-ln') as Element)).toBe('1 + x');
    expect(extractCodeBlockText(doc.getElementById('obj-keys-ln') as Element)).toBe(
      '1: "one",\n2: "two"',
    );
    expect(extractCodeBlockText(doc.getElementById('arr-ln') as Element)).toBe('[\n1,\n2\n]');

    const numDataAttr = doc.getElementById('num-data-attr') as Element;
    expect(isCopyableCodeBlock(numDataAttr)).toBe(true);
    expect(extractCodeBlockText(numDataAttr)).toBe('123\n456');

    expect(extractCodeBlockText(doc.getElementById('aria-pre') as Element)).toBe('  kept = true');
  });
});

describe('isCopyableCodeBlock', () => {
  it('accepts non-empty pre elements and rejects side-by-side table gutters, non-pre elements, and empty blocks', () => {
    const doc = parseXhtml(`
      <p id="prose">not pre</p>
      <pre id="ok"><code>  const x = 1;</code></pre>
      <pre id="blank">   \n\t  </pre>
      <pre id="hidden-only"><span hidden="hidden">123</span></pre>
      <table class="highlighttable"><tr><td class="linenos"><div class="linenodiv"><pre id="gutter-pygments">1\n2</pre></div></td><td class="code"><pre id="code-pygments"><code>a\nb</code></pre></td></tr></table>
      <table class="rouge-table"><tr><td class="rouge-gutter"><pre id="gutter-rouge" class="lineno">1\n2</pre></td><td class="rouge-code"><pre id="code-rouge"><code>x\ny</code></pre></td></tr></table>
      <table><tr><td class="gutter"><pre id="gutter-hexo">1</pre></td><td class="code"><pre id="code-hexo"><code>x</code></pre></td></tr></table>
      <table><tr><td class="hljs-ln-numbers"><pre id="gutter-hljs">1\n2</pre></td><td class="hljs-ln-code"><pre id="code-hljs"><code>a\nb</code></pre></td></tr></table>
      <table class="lntable"><tr><td class="lntd"><pre id="gutter-lntable" class="chroma"><code><span class="lnt">1\n</span><span class="lnt">2\n</span></code></pre></td><td class="lntd"><pre id="code-lntable" class="chroma"><code><span class="line"><span class="cl">print(1)</span></span></code></pre></td></tr></table>
      <pre id="chroma-empty-cl" class="chroma"><code><span class="line"><span class="ln">1</span><span class="cl"></span></span>\n<span class="line"><span class="ln">2</span><span class="cl"></span></span></code></pre>
      <div class="linenodiv"><pre id="standalone-div">1\n2</pre></div>
      <pre id="standalone-self" class="linenos">1\n2</pre>
      <div data-line-numbers="true"><pre id="standalone-attr">1\n2</pre></div>
      <div class="gutter"><pre id="standalone-code"><code>const x = 1;</code></pre></div>
      <table><tr><td class="linenos"><pre id="solo-td">1\n2</pre></td></tr></table>
      <table><tr><td class="gutter"><pre id="nonseq-td">123\n456</pre></td><td class="code"><pre id="nonseq-code"><code>data</code></pre></td></tr></table>
    `);
    expect(isCopyableCodeBlock(doc.getElementById('prose') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('ok') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('blank') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('hidden-only') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-pygments') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('code-pygments') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-rouge') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('code-rouge') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-hexo') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('code-hexo') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-hljs') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('code-hljs') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('gutter-lntable') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('code-lntable') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('chroma-empty-cl') as Element)).toBe(false);
    expect(isCopyableCodeBlock(doc.getElementById('standalone-div') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('standalone-self') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('standalone-attr') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('standalone-code') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('solo-td') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('nonseq-td') as Element)).toBe(true);
    expect(isCopyableCodeBlock(doc.getElementById('nonseq-code') as Element)).toBe(true);
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
