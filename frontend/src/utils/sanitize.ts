// Allowlisted tags and attributes for HTML sanitization.
// Strips everything else (script, iframe, event handlers, etc.).

const ALLOWED_TAGS = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'span',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote',
  'sub', 'sup', 'del', 's', 'hr',
]);

// Tags whose content should be removed entirely (not just unwrapped)
const REMOVE_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript']);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  '*': new Set(['class']),
};

export function sanitizeHtml(html: string): string {
  // Fast path: no HTML tags at all
  if (!html.includes('<')) return html;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  function cleanNode(node: Node): void {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const tag = el.tagName.toLowerCase();

        if (!ALLOWED_TAGS.has(tag)) {
          if (REMOVE_WITH_CONTENT.has(tag)) {
            // Dangerous elements: remove entirely including content
            node.removeChild(child);
          } else {
            // Other disallowed elements: unwrap (keep text content)
            const text = document.createTextNode(el.textContent ?? '');
            node.replaceChild(text, child);
          }
          continue;
        }

        // Strip disallowed attributes
        const allowedForTag = ALLOWED_ATTRS[tag];
        const allowedGlobal = ALLOWED_ATTRS['*'];
        const attrs = Array.from(el.attributes);
        for (const attr of attrs) {
          const name = attr.name.toLowerCase();
          // Block all event handlers
          if (name.startsWith('on')) {
            el.removeAttribute(attr.name);
            continue;
          }
          const allowed = allowedForTag?.has(name) || allowedGlobal?.has(name);
          if (!allowed) {
            el.removeAttribute(attr.name);
          }
        }

        // Sanitize href to prevent javascript: URLs
        if (tag === 'a') {
          const href = el.getAttribute('href') ?? '';
          if (href.replace(/\s/g, '').toLowerCase().startsWith('javascript:')) {
            el.setAttribute('href', '#');
          }
        }

        cleanNode(el);
      }
    }
  }

  cleanNode(doc.body);
  return doc.body.innerHTML;
}
