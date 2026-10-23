import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pinScrollTo } from '../scrollPin';

describe('pinScrollTo', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('scrolls by the drift between the anchor\'s current position and `before`', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ top: 120 } as DOMRect);
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});

    pinScrollTo(anchor, 300);

    expect(scrollBy).toHaveBeenCalledWith(0, 120 - 300);
    anchor.remove();
  });

  it('does not scroll when the anchor is already at `before`', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ top: 250 } as DOMRect);
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});

    pinScrollTo(anchor, 250);

    expect(scrollBy).not.toHaveBeenCalled();
    anchor.remove();
  });
});
