// Whether a list/group is specially muted, shared by the Lists and Tasks tabs.
//
// Both tabs mute through the same `settings.listNotifyOverrides[id]` namespace,
// but the notification hierarchy is a narrow-only cascade: an override can only
// ever MUTE within its global toggle, never re-enable one. So with the global
// off nothing notifies regardless, and calling that list "muted" would be
// noise — the indicator is for lists singled out against a global that is on.

export interface NotifyFlags {
  edits?: boolean;
  /** Omit entirely for a feature with no due reminders (the Lists tab). */
  due?: boolean;
}

export interface MuteState {
  muted: boolean;
  /** Names what is muted, for the tooltip / accessible label. */
  label: string;
}

export function muteState(override: NotifyFlags | undefined, globals: NotifyFlags): MuteState {
  // `?? true` mirrors the defaults-on override semantics used everywhere else.
  const editsMuted = !!globals.edits && (override?.edits ?? true) === false;
  const dueMuted = globals.due !== undefined
    && !!globals.due && (override?.due ?? true) === false;

  if (editsMuted && dueMuted) return { muted: true, label: 'Edits and due reminders muted' };
  if (editsMuted) return { muted: true, label: 'Edit notifications muted' };
  if (dueMuted) return { muted: true, label: 'Due reminders muted' };
  return { muted: false, label: '' };
}

/** Bell-with-slash mark for a muted list/group tab. */
export function MutedIcon({ label }: { label: string }) {
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid="muted-icon"
      className="w-3 h-3 shrink-0 pointer-events-none opacity-80"
      fill="none" stroke="currentColor" viewBox="0 0 24 24"
    >
      <title>{label}</title>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
        d="M13.73 21a2 2 0 01-3.46 0M18.63 13A17.9 17.9 0 0118 8M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14M18 8a6 6 0 00-9.33-5M1 1l22 22" />
    </svg>
  );
}
