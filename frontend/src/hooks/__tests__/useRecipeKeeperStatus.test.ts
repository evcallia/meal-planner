import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

vi.mock('../../api/client', () => ({
  getRecipeKeeperStatus: vi.fn(),
}));
vi.mock('../useOnlineStatus', () => ({
  useOnlineStatus: vi.fn(() => true),
}));

import { useRecipeKeeperStatus } from '../useRecipeKeeperStatus';
import { getRecipeKeeperStatus } from '../../api/client';

const mockGetStatus = vi.mocked(getRecipeKeeperStatus);

describe('useRecipeKeeperStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches status on mount when enabled', async () => {
    mockGetStatus.mockResolvedValue({
      enabled: true, last_sync: null, last_error: '', auth_failed: false,
      selected_list_id: 'l1', selected_list_name: 'Groceries',
    });
    const { result } = renderHook(() => useRecipeKeeperStatus(true));
    await waitFor(() => expect(result.current.status?.selected_list_name).toBe('Groceries'));
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('does not fetch when not enabled (e.g. signed out)', () => {
    renderHook(() => useRecipeKeeperStatus(false));
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('polls on an interval', async () => {
    vi.useFakeTimers();
    mockGetStatus.mockResolvedValue({
      enabled: true, last_sync: null, last_error: '', auth_failed: false,
      selected_list_id: '', selected_list_name: '',
    });
    renderHook(() => useRecipeKeeperStatus(true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(2);
  });

  it('stops polling once the backend reports the integration is not configured', async () => {
    vi.useFakeTimers();
    mockGetStatus.mockResolvedValue({
      enabled: false, last_sync: null, last_error: '', auth_failed: false,
      selected_list_id: '', selected_list_name: '',
    });
    renderHook(() => useRecipeKeeperStatus(true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockGetStatus).toHaveBeenCalledTimes(1);

    // No credentials configured server-side — polling forever would be
    // pointless (only a server restart, which reloads the page, changes it).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
  });

  it('applyStatus lets a caller (e.g. a Settings mutation) push a fresh status immediately', async () => {
    mockGetStatus.mockResolvedValue({
      enabled: true, last_sync: null, last_error: '', auth_failed: false,
      selected_list_id: '', selected_list_name: '',
    });
    const { result } = renderHook(() => useRecipeKeeperStatus(true));
    await waitFor(() => expect(result.current.status).not.toBeNull());

    act(() => {
      result.current.applyStatus({
        enabled: true, last_sync: '2026-01-01T00:00:00Z', last_error: '', auth_failed: false,
        selected_list_id: 'l2', selected_list_name: 'Party Supplies',
      });
    });
    expect(result.current.status?.selected_list_name).toBe('Party Supplies');
  });
});
