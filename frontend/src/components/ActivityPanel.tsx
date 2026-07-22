import { useEffect, useRef, useState } from 'react';
import { ActivityEntry } from '../api/client';
import { parseServerDate, formatAgo } from '../utils/recency';

interface ActivityPanelProps {
  entries: ActivityEntry[];
  lastSeen: string | null;
  loading: boolean;
  onClose: () => void;
  onSeen: () => void;
  // App update surfaced in the panel (pinned above the feed); the floating
  // banner remains the primary prompt — this is the persistent fallback.
  updateAvailable?: boolean;
  onApplyUpdate?: () => void;
  updating?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  meals: 'Meals',
  pantry: 'Pantry',
  grocery: 'Grocery',
  lists: 'Lists',
  'list-due': 'Due',
};

function contextLabel(entry: ActivityEntry): string {
  if (entry.list_name) return entry.list_name;
  return CATEGORY_LABELS[entry.category] || entry.category;
}

// First name only, matching the header; email fallbacks show their local part.
function firstName(actorName: string): string {
  const first = actorName.trim().split(/\s+/)[0] || actorName;
  return first.includes('@') ? first.split('@')[0] : first;
}

/**
 * "Since you were away" feed: other users' edits, newest first, with a
 * divider under the entries that are new since the viewer's last visit.
 * Opening the panel marks everything seen (the divider stays for this
 * viewing so the user can still tell what was new).
 */
export function ActivityPanel({ entries, lastSeen, loading, onClose, onSeen, updateAvailable, onApplyUpdate, updating }: ActivityPanelProps) {
  // The "earlier" divider anchors to the marker as it was when the panel
  // OPENED — marking seen moves the live marker immediately, and anchoring to
  // the prop would make the "new" grouping vanish mid-viewing.
  const [initialLastSeen] = useState(lastSeen);

  // Mark seen on open, and again whenever entries stream in while the panel
  // is open — the user is looking right at them, so they must never count
  // toward the badge (not even after closing).
  const onSeenRef = useRef(onSeen);
  onSeenRef.current = onSeen;
  useEffect(() => {
    onSeenRef.current();
  }, [entries]);

  const seenTime = initialLastSeen ? parseServerDate(initialLastSeen) : 0;
  const firstOldIndex = entries.findIndex(e => parseServerDate(e.at) <= seenTime);
  const newCount = firstOldIndex === -1 ? entries.length : firstOldIndex;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="glass rounded-lg max-w-sm w-full max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Activity</h2>
          <button
            onClick={onClose}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Entries */}
        <div className="p-4">
          {updateAvailable && onApplyUpdate && (
            <div className="flex items-center justify-between gap-3 mb-4 p-3 rounded-xl bg-blue-50 dark:bg-blue-900/30">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 bg-blue-500 rounded-full shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Update available</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">A new version is ready to install</p>
                </div>
              </div>
              <button
                onClick={onApplyUpdate}
                disabled={updating}
                className={`px-3 py-1.5 text-sm font-medium text-white rounded-lg transition-colors shrink-0 ${updating ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600'}`}
              >
                {updating ? 'Updating…' : 'Update'}
              </button>
            </div>
          )}
          {loading && entries.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No recent activity from others.
            </p>
          ) : (
            <div className="space-y-3">
              {entries.map((entry, i) => (
                <div key={entry.id}>
                  {i === newCount && newCount > 0 && (
                    <div className="flex items-center gap-2 mb-3" aria-label="Previously seen">
                      <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
                      <span className="text-xs text-gray-400 dark:text-gray-500">earlier</span>
                      <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
                    </div>
                  )}
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-gray-900 dark:text-gray-100 min-w-0">
                      {/* Due-reminder entries have no actor */}
                      {entry.actor_name && <span className="font-medium">{firstName(entry.actor_name)} </span>}
                      {entry.detail}
                    </p>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-gray-500 dark:text-gray-400">{formatAgo(entry.at)}</p>
                      <p className="text-xs text-gray-400 dark:text-gray-500">{contextLabel(entry)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
