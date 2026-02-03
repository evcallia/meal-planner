const ENTITY_MAP: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeOnce(input: string): string {
  return input.replace(/&(#\d+|#x[0-9a-fA-F]+|lt|gt|amp|quot|apos|nbsp);/g, (_match, code) => {
    if (typeof code !== 'string') return _match;
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const value = parseInt(code.slice(2), 16);
      return Number.isFinite(value) ? String.fromCharCode(value) : _match;
    }
    if (code.startsWith('#')) {
      const value = parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCharCode(value) : _match;
    }
    return ENTITY_MAP[code] ?? _match;
  });
}

export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) return input;
  const once = decodeOnce(input);
  if (once.includes('&') && once !== input) {
    return decodeOnce(once);
  }
  return once;
}
