import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScrollIntoViewOnEdit } from '../useScrollIntoViewOnEdit';

describe('useScrollIntoViewOnEdit', () => {
  const scrollIntoView = vi.fn();
  const ref = { current: { scrollIntoView } as unknown as HTMLElement };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('scrolls the element into view shortly after editing starts', () => {
    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: true },
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('does nothing when not editing', () => {
    renderHook(({ editing }) => useScrollIntoViewOnEdit(ref, editing), {
      initialProps: { editing: false },
    });
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('cancels the pending scroll when editing ends', () => {
    const { rerender } = renderHook(
      ({ editing }) => useScrollIntoViewOnEdit(ref, editing),
      { initialProps: { editing: true } },
    );
    rerender({ editing: false });
    vi.advanceTimersByTime(400);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
