import { describe, it, expect } from 'vitest';
import { muteState } from '../notifyMute';

// A per-list mute only means anything while the matching GLOBAL toggle is on —
// with the global off nothing notifies anyway, so the indicator must not claim
// the list is specially muted.

describe('muteState', () => {
  describe('a feature with only edit notifications (the Lists tab)', () => {
    it('is muted when edits are overridden off and the global is on', () => {
      expect(muteState({ edits: false }, { edits: true })).toEqual({
        muted: true, label: 'Edit notifications muted',
      });
    });

    it('is not muted when the global is off, however the override reads', () => {
      expect(muteState({ edits: false }, { edits: false }).muted).toBe(false);
    });

    it('is not muted with no override, or with the override explicitly on', () => {
      expect(muteState(undefined, { edits: true }).muted).toBe(false);
      expect(muteState({}, { edits: true }).muted).toBe(false);
      expect(muteState({ edits: true }, { edits: true }).muted).toBe(false);
    });

    it('ignores a due override when the feature has no due notifications', () => {
      expect(muteState({ due: false }, { edits: true }).muted).toBe(false);
    });
  });

  describe('a feature with edits AND due reminders (the Tasks tab)', () => {
    it('is muted when only edits are off', () => {
      expect(muteState({ edits: false }, { edits: true, due: true })).toEqual({
        muted: true, label: 'Edit notifications muted',
      });
    });

    it('is muted when only due reminders are off', () => {
      expect(muteState({ due: false }, { edits: true, due: true })).toEqual({
        muted: true, label: 'Due reminders muted',
      });
    });

    it('names both when both are off', () => {
      expect(muteState({ edits: false, due: false }, { edits: true, due: true })).toEqual({
        muted: true, label: 'Edits and due reminders muted',
      });
    });

    it('counts only the halves whose global is on', () => {
      // Edits globally off: that mute is moot, so only the due mute counts.
      expect(muteState({ edits: false, due: false }, { edits: false, due: true })).toEqual({
        muted: true, label: 'Due reminders muted',
      });
      // Both globals off: nothing to mute.
      expect(muteState({ edits: false, due: false }, { edits: false, due: false }).muted).toBe(false);
    });

    it('is not muted when nothing is overridden off', () => {
      expect(muteState(undefined, { edits: true, due: true }).muted).toBe(false);
    });
  });
});
