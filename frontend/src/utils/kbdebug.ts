// TEMPORARY diagnostics for the iOS keyboard-dismiss bug. Two blind fixes
// have missed, because none of the three unknowns is observable from a
// desktop browser: which signal the dismiss key gives (blur, or a bare
// visual-viewport change), whether our handlers see it, and why the commit
// then declines to save. This records the sequence on the device itself so
// one reproduction answers all three.
//
// Off unless the page is opened with ?kbdebug=1 (remembered for the tab, so
// in-app navigation keeps it). Delete this file and its call sites once the
// bug is understood.

const KEY = 'kbdebug';

export const kbDebugOn: boolean = (() => {
  try {
    if (new URLSearchParams(window.location.search).get(KEY) === '1') {
      sessionStorage.setItem(KEY, '1');
    }
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

export type KbEntry = { t: number; what: string; detail: string };

const entries: KbEntry[] = [];
const listeners = new Set<() => void>();
let origin = 0;

function describe(el: Element | null): string {
  if (!el) return 'null';
  const tag = el.tagName.toLowerCase();
  if (tag === 'body' || tag === 'html') return tag;
  const value = el instanceof HTMLInputElement ? `="${el.value}"` : '';
  const label = el.getAttribute('placeholder') ?? el.className.split(' ')[0] ?? '';
  return `${tag}${value}${label ? `.${label}` : ''}`;
}

export function kbLog(what: string, detail: Record<string, unknown> = {}) {
  if (!kbDebugOn) return;
  const now = Date.now();
  if (!origin) origin = now;
  const parts = Object.entries(detail).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  entries.push({ t: now - origin, what, detail: parts.join(' ') });
  if (entries.length > 120) entries.shift();
  listeners.forEach(fn => fn());
}

/** Shorthand for the one value every entry wants: where focus is now. */
export function kbFocus(): string {
  return describe(document.activeElement);
}

export function kbHeights(): Record<string, unknown> {
  const vv = window.visualViewport;
  return {
    vv: vv ? Math.round(vv.height) : 'none',
    inner: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    mainTop: Math.round(document.querySelector('main')?.scrollTop ?? -1),
    kbClass: document.documentElement.classList.contains('keyboard-open'),
  };
}

export function kbEntries(): KbEntry[] {
  return entries;
}

export function kbText(): string {
  return entries.map(e => `+${e.t}ms ${e.what}${e.detail ? ` ${e.detail}` : ''}`).join('\n');
}

export function kbClear() {
  entries.length = 0;
  origin = 0;
  listeners.forEach(fn => fn());
}

/**
 * Records the raw browser signals, so the first unknown — whether the
 * dismiss key blurs the input or only shrinks the keyboard away — is
 * answered without any of our own handlers being involved.
 */
/**
 * Everything iOS could be keying off when it decides which fields its
 * previous/next arrows will visit. Two structural guesses (which element the
 * blur handler sat on, then form ownership) have both missed, so this reports
 * the whole control list as the browser sees it rather than as the JSX reads.
 */
function describeFormControls(el: Element): string {
  const form = (el as HTMLInputElement).form;
  if (!form) return 'no-form';
  return Array.from(form.elements).map(c => {
    const i = c as HTMLInputElement;
    const kind = `${i.tagName.toLowerCase()}${i.type ? `:${i.type}` : ''}`;
    const label = i.placeholder || i.name || i.getAttribute('aria-label') || '';
    const flags = [
      i.disabled ? 'disabled' : '',
      i.readOnly ? 'readonly' : '',
      i.tabIndex !== 0 ? `tab=${i.tabIndex}` : '',
      // offsetParent is null for display:none and for anything inside it —
      // iOS will not navigate to a field it considers unrendered.
      (i as HTMLElement).offsetParent === null ? 'unrendered' : '',
      i.hidden ? 'hidden' : '',
    ].filter(Boolean).join(',');
    return `${kind}"${label}"${flags ? `[${flags}]` : ''}`;
  }).join(' | ');
}

export function kbInstallGlobalListeners(): () => void {
  if (!kbDebugOn) return () => {};
  const onFocusIn = (e: Event) => {
    kbLog('focusin', { target: describe(e.target as Element), ...kbHeights() });
    kbLog('form:controls', { list: describeFormControls(e.target as Element) });
  };
  const onFocusOut = (e: Event) => kbLog('focusout', { from: describe(e.target as Element), nowFocused: kbFocus() });
  const onResize = () => kbLog('vv:resize', { focus: kbFocus(), ...kbHeights() });
  const onVvScroll = () => kbLog('vv:scroll', kbHeights());
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  window.visualViewport?.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('scroll', onVvScroll);
  kbLog('kbdebug:ready', kbHeights());
  return () => {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.visualViewport?.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('scroll', onVvScroll);
  };
}

export function kbSubscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
