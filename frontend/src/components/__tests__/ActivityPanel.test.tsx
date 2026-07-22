import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityPanel } from '../ActivityPanel';
import { ActivityEntry } from '../../api/client';

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString().replace('Z', '');

const entries: ActivityEntry[] = [
  { id: '1', at: iso(60_000), actor_name: 'Wife Callia', category: 'lists', detail: 'completed “Water plants”', list_name: 'Home' },
  { id: '2', at: iso(120_000), actor_name: 'Wife', category: 'grocery', detail: 'added “Milk”' },
  { id: '3', at: iso(86_400_000), actor_name: 'Wife', category: 'pantry', detail: 'updated “Flour”' },
];

describe('ActivityPanel', () => {
  it('renders entries with actor, detail and context', () => {
    render(
      <ActivityPanel entries={entries} lastSeen={null} loading={false} onClose={() => {}} onSeen={() => {}} />
    );
    expect(screen.getByText(/completed “Water plants”/)).toBeInTheDocument();
    // First name only, even though the stored actor name is the full name
    expect(screen.getAllByText('Wife').length).toBeGreaterThan(0);
    expect(screen.queryByText('Wife Callia')).not.toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText(/added “Milk”/)).toBeInTheDocument();
    expect(screen.getByText('Grocery')).toBeInTheDocument();
  });

  it('marks seen once on open', () => {
    const onSeen = vi.fn();
    render(
      <ActivityPanel entries={entries} lastSeen={null} loading={false} onClose={() => {}} onSeen={onSeen} />
    );
    expect(onSeen).toHaveBeenCalledTimes(1);
  });

  it('shows the "earlier" divider between new and previously seen entries', () => {
    // Seen 10 minutes ago: entries 1+2 are new, entry 3 is old.
    render(
      <ActivityPanel entries={entries} lastSeen={iso(600_000)} loading={false} onClose={() => {}} onSeen={() => {}} />
    );
    expect(screen.getByText('earlier')).toBeInTheDocument();
  });

  it('hides the divider when everything is new', () => {
    render(
      <ActivityPanel entries={entries} lastSeen={null} loading={false} onClose={() => {}} onSeen={() => {}} />
    );
    expect(screen.queryByText('earlier')).not.toBeInTheDocument();
  });

  it('shows an empty state', () => {
    render(
      <ActivityPanel entries={[]} lastSeen={null} loading={false} onClose={() => {}} onSeen={() => {}} />
    );
    expect(screen.getByText(/No recent activity/)).toBeInTheDocument();
  });

  it('closes on backdrop click', () => {
    const onClose = vi.fn();
    const { container } = render(
      <ActivityPanel entries={[]} lastSeen={null} loading={false} onClose={onClose} onSeen={() => {}} />
    );
    fireEvent.click(container.firstChild as Element);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ActivityPanel update row', () => {
  it('shows a pinned update row with an Update button', () => {
    const onApplyUpdate = vi.fn();
    render(
      <ActivityPanel entries={[]} lastSeen={null} loading={false} onClose={() => {}} onSeen={() => {}}
        updateAvailable onApplyUpdate={onApplyUpdate} />
    );
    expect(screen.getByText('Update available')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(onApplyUpdate).toHaveBeenCalled();
  });

  it('hides the row when no update is pending', () => {
    render(
      <ActivityPanel entries={[]} lastSeen={null} loading={false} onClose={() => {}} onSeen={() => {}} />
    );
    expect(screen.queryByText('Update available')).not.toBeInTheDocument();
  });

  it('disables the button while updating', () => {
    render(
      <ActivityPanel entries={[]} lastSeen={null} loading={false} onClose={() => {}} onSeen={() => {}}
        updateAvailable onApplyUpdate={() => {}} updating />
    );
    expect(screen.getByRole('button', { name: 'Updating…' })).toBeDisabled();
  });
});

describe('ActivityPanel live-viewing behavior', () => {
  it('re-marks seen when new entries arrive while open', () => {
    const onSeen = vi.fn();
    const { rerender } = render(
      <ActivityPanel entries={entries} lastSeen={null} loading={false} onClose={() => {}} onSeen={onSeen} />
    );
    expect(onSeen).toHaveBeenCalledTimes(1);

    const withNew: ActivityEntry[] = [
      { id: '0', at: iso(1_000), actor_name: 'Wife', category: 'grocery', detail: 'added “Butter”' },
      ...entries,
    ];
    rerender(
      <ActivityPanel entries={withNew} lastSeen={null} loading={false} onClose={() => {}} onSeen={onSeen} />
    );
    expect(onSeen).toHaveBeenCalledTimes(2);
  });

  it('keeps the divider anchored to the marker from when the panel opened', () => {
    // Opened with lastSeen 10 min ago → entries 1+2 new, entry 3 earlier.
    const { rerender } = render(
      <ActivityPanel entries={entries} lastSeen={iso(600_000)} loading={false} onClose={() => {}} onSeen={() => {}} />
    );
    expect(screen.getByText('earlier')).toBeInTheDocument();

    // The mark-seen response moves the live marker to "now" — the divider
    // must not vanish mid-viewing.
    rerender(
      <ActivityPanel entries={entries} lastSeen={iso(0)} loading={false} onClose={() => {}} onSeen={() => {}} />
    );
    expect(screen.getByText('earlier')).toBeInTheDocument();
  });
});
