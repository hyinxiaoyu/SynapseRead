/**
 * What a footnote reference points at, as plain text (#49). Book markup is untrusted
 * and never enters the app's DOM (ADR 0005): this reads only text nodes out of the
 * chapter's own document, and the card renders the string as text.
 */

const OPS_NS = 'http://www.idpf.org/2007/ops';

/** The longest target a link without `noteref` may have and still be peeked at. */
export const SHORT_TARGET_CHARS = 400;
/** The most text a card shows; longer notes end in an ellipsis. */
export const PEEK_MAX_CHARS = 800;

const NOTE_TYPES = ['footnote', 'endnote', 'rearnote', 'note'];
const NOTE_ROLES = ['doc-footnote', 'doc-endnote'];
/** Never part of a note's text: code, styling, embedded content, and the way back. */
const SKIPPED = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'head']);
/** Targets that start a part of the book, not a note, so a link to one jumps. */
const STRUCTURAL = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'body', 'html', 'nav']);
/** An empty anchor (`<a id="fn1"/>`) stands for the block it sits in. */
const BLOCKS = new Set(['p', 'li', 'dd', 'dt', 'aside', 'div', 'blockquote', 'td', 'footer']);

function epubTypes(element: Element): string[] {
  const value = element.getAttributeNS(OPS_NS, 'type') ?? element.getAttribute('epub:type') ?? '';
  return value.split(/\s+/).filter(Boolean);
}

const tagOf = (element: Element) => element.localName.toLowerCase();

/** Whether a link says it is a note reference (`epub:type="noteref"` or ARIA's role). */
export function isNoteRef(anchor: Element): boolean {
  return epubTypes(anchor).includes('noteref') || anchor.getAttribute('role') === 'doc-noteref';
}

function isNote(element: Element): boolean {
  return (
    epubTypes(element).some((type) => NOTE_TYPES.includes(type)) ||
    NOTE_ROLES.includes(element.getAttribute('role') ?? '')
  );
}

function isBacklink(element: Element): boolean {
  return epubTypes(element).includes('backlink') || element.getAttribute('role') === 'doc-backlink';
}

/** Text content, minus the parts listed in `SKIPPED` and links back to the reference. */
export function plainText(root: Node): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3 || node.nodeType === 4) {
      parts.push((node as CharacterData).data);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (SKIPPED.has(tagOf(element)) || isBacklink(element)) return;
    // Blocks and breaks separate words that markup alone kept apart.
    const block = BLOCKS.has(tagOf(element)) || tagOf(element) === 'br';
    if (block) parts.push(' ');
    for (const child of Array.from(element.childNodes)) walk(child);
    if (block) parts.push(' ');
  };
  walk(root);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function findTarget(chapterDoc: Document, fragment: string): Element | null {
  let id = fragment;
  try {
    id = decodeURIComponent(fragment);
  } catch {
    // A malformed escape is looked up as written.
  }
  if (!id) return null;
  const byId = chapterDoc.getElementById(id);
  if (byId) return byId;
  // Older books mark notes with `<a name>`.
  for (const named of Array.from(chapterDoc.getElementsByTagName('a'))) {
    if (named.getAttribute('name') === id) return named;
  }
  return null;
}

/** The element whose text is the note: an empty marker stands for its block. */
function noteElement(target: Element): Element {
  const note = findNoteAncestor(target);
  if (note) return note;
  if (plainText(target) !== '' || BLOCKS.has(tagOf(target))) return target;
  let block: Element | null = target.parentElement;
  while (block && !BLOCKS.has(tagOf(block)) && !STRUCTURAL.has(tagOf(block))) {
    block = block.parentElement;
  }
  return block && !STRUCTURAL.has(tagOf(block)) ? block : target;
}

function findNoteAncestor(target: Element): Element | null {
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (isNote(element)) return element;
    if (STRUCTURAL.has(tagOf(element))) return null;
  }
  return null;
}

function clip(text: string): string {
  if (text.length <= PEEK_MAX_CHARS) return text;
  const cut = text.slice(0, PEEK_MAX_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > PEEK_MAX_CHARS * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The text a link to `#fragment` in `chapterDoc` should show in a card, or null when
 * the link should jump instead: there is no such element, it starts a part of the
 * book, or, for a link that does not say it is a note reference, the target is long.
 */
export function noteTextAt(
  chapterDoc: Document,
  fragment: string,
  { noteref }: { noteref: boolean },
): string | null {
  const target = findTarget(chapterDoc, fragment);
  if (!target) return null;
  const note = noteElement(target);
  const marked = noteref || isNote(note);
  if (!marked && STRUCTURAL.has(tagOf(note))) return null;
  const text = plainText(note);
  if (text === '') return null;
  if (!marked && text.length > SHORT_TARGET_CHARS) return null;
  return clip(text);
}
