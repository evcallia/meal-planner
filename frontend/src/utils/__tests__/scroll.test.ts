import { describe, it, expect, beforeEach } from 'vitest';
import { scrollToElementWithOffset } from '../scroll';

describe('scrollToElementWithOffset', () => {
  beforeEach(() => {
    const scrollMock = window.scrollTo as unknown as { mockClear?: () => void };
    scrollMock.mockClear?.();
  });

  it('scrolls accounting for header height and offset', () => {
    const header = document.createElement('header');
    header.getBoundingClientRect = () => ({ height: 50 } as DOMRect);
    document.body.appendChild(header);

    const target = document.createElement('div');
    target.getBoundingClientRect = () => ({ top: 200 } as DOMRect);

    Object.defineProperty(window, 'scrollY', { value: 100, writable: true });

    scrollToElementWithOffset(target, 'smooth', 12);

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 238, behavior: 'smooth' });

    header.remove();
  });
});
