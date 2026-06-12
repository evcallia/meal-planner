import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exitEditAnchored } from '../exitEditAnchored';

describe('exitEditAnchored', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('blurs the focused element before exiting', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const blurSpy = vi.spyOn(input, 'blur');
    const exit = vi.fn();

    exitEditAnchored(null, exit);

    expect(blurSpy).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('scrolls by the anchor displacement so the row stays put', () => {
    const anchor = document.createElement('div');
    const tops = [300, 120]; // before exit, after exit (form collapsed above)
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(
      () => ({ top: tops.shift() ?? 0 } as DOMRect)
    );
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});

    exitEditAnchored(anchor, () => {});

    expect(scrollBy).toHaveBeenCalledWith(0, 120 - 300);
  });

  it('does not scroll when the anchor did not move', () => {
    const anchor = document.createElement('div');
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ top: 250 } as DOMRect);
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});

    exitEditAnchored(anchor, () => {});

    expect(scrollBy).not.toHaveBeenCalled();
  });
});
