import { describe, it, expect, beforeEach } from 'vitest';
import { scrollToElementWithOffset } from '../scroll';

describe('scrollToElementWithOffset', () => {
  beforeEach(() => {
    const scrollMock = window.scrollTo as unknown as { mockClear?: () => void };
    scrollMock.mockClear?.();
  });

  it('scrolls accounting for header height, sticky panels, and offset', () => {
    // Set --header-h CSS variable as PageHeader's ResizeObserver would
    document.documentElement.style.setProperty('--header-h', '50');

    const target = document.createElement('div');
    target.getBoundingClientRect = () => ({ top: 200 } as DOMRect);

    Object.defineProperty(window, 'scrollY', { value: 100, writable: true });

    // totalOffset = headerH(50) + gap(24) + stickyHeight(0) + extraOffset(12) = 86
    // targetTop = elementTop(300) - 86 = 214
    scrollToElementWithOffset(target, 'smooth', 12);

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 214, behavior: 'smooth' });

    document.documentElement.style.removeProperty('--header-h');
  });
});
