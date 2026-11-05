const REMOVED_ELEMENTS = 'script, iframe, frame, frameset, object, embed, applet, base';
const SCRIPT_URL = /^\s*(javascript|vbscript|data:text\/html)/i;

/**
 * Strips active content from a chapter before it is rendered. This is one of two
 * independent layers, alongside the CSP: see `docs/adr/0005-epub-sandbox.md`.
 * The chapter was parsed as a detached document, so nothing has run yet.
 */
export function sanitizeChapter(chapter: Document): void {
  for (const element of chapter.querySelectorAll(REMOVED_ELEMENTS)) element.remove();

  // Matches the XHTML and SVG namespaces alike, unlike a tag-name selector with a prefix.
  for (const element of chapter.querySelectorAll('*')) {
    if (element.localName === 'script' || element.localName === 'base') {
      element.remove();
      continue;
    }
    if (
      element.localName === 'meta' &&
      element.getAttribute('http-equiv')?.toLowerCase() === 'refresh'
    ) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on') || SCRIPT_URL.test(attribute.value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
}
