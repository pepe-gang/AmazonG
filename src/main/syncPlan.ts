import type {
  AutoGSyncBlob,
  SyncCard,
  SyncChaseProfile,
} from '../shared/types.js';
import type { FillerPool } from '../shared/ipc.js';

/**
 * The local actions a startup BG cross-device sync pull should take,
 * derived purely from the BG blob + the local card / Chase-profile
 * counts.
 *
 * Kept electron-free so the merge decision is unit-testable in
 * isolation (tests/unit/syncPlan.test.ts) — `pullSyncFromBG` in
 * index.ts just fetches the blob, calls this, and executes the plan.
 */
export type SyncPlan = {
  /** Settings to merge into settings.json. Empty = no settings change. */
  settingsPatch: { buyWithFillers?: boolean; fillerAttempts?: FillerPool[] };
  /** Cards to replace the local vault with, or null to leave it alone. */
  cards: SyncCard[] | null;
  /** Account→card assignments (email → cardId) to apply to profiles,
   *  or null to leave local assignments alone. */
  cardAssignments: Record<string, string> | null;
  /** Chase profiles to replace the local list with, or null to leave
   *  the local list alone. */
  chaseProfiles: SyncChaseProfile[] | null;
  /** Push local state up to BG after applying — BG had no row yet, or
   *  BG's card / Chase list was empty while this machine has entries
   *  (so an empty remote can't wipe a populated local store). */
  pushLocal: boolean;
  /** Something changed locally — caller emits evt:sync-applied. */
  applied: boolean;
};

/**
 * Decide what a sync pull should apply. Pure: same inputs → same plan.
 */
export function planSync(
  blob: AutoGSyncBlob,
  localCardCount: number,
  localChaseProfileCount: number,
): SyncPlan {
  // No row on BG yet — seed it from this machine, change nothing local.
  if (!blob.exists) {
    return {
      settingsPatch: {},
      cards: null,
      cardAssignments: null,
      chaseProfiles: null,
      pushLocal: true,
      applied: false,
    };
  }

  const settingsPatch: SyncPlan['settingsPatch'] = {};
  if (typeof blob.buyWithFillers === 'boolean') {
    settingsPatch.buyWithFillers = blob.buyWithFillers;
  }
  if (Array.isArray(blob.fillerAttempts) && blob.fillerAttempts.length > 0) {
    settingsPatch.fillerAttempts = blob.fillerAttempts as FillerPool[];
  }

  let cards: SyncCard[] | null = null;
  let pushLocal = false;
  if (blob.cards.length > 0) {
    cards = blob.cards;
  } else if (localCardCount > 0) {
    // BG card list empty but this machine has cards — push local up
    // rather than wiping a configured vault from an empty remote.
    pushLocal = true;
  }

  // Chase profiles — same empty-remote guard as cards. `chaseProfiles`
  // may be absent on a BG that predates the field; treat that as [].
  const remoteChase = blob.chaseProfiles ?? [];
  let chaseProfiles: SyncChaseProfile[] | null = null;
  if (remoteChase.length > 0) {
    chaseProfiles = remoteChase;
  } else if (localChaseProfileCount > 0) {
    pushLocal = true;
  }

  // Apply account→card assignments unless we're pushing local up (an
  // empty remote shouldn't clear local assignments either). An empty
  // assignment map is treated as "nothing to apply".
  const cardAssignments =
    !pushLocal &&
    blob.cardAssignments &&
    Object.keys(blob.cardAssignments).length > 0
      ? blob.cardAssignments
      : null;

  const applied =
    Object.keys(settingsPatch).length > 0 ||
    cards !== null ||
    cardAssignments !== null ||
    chaseProfiles !== null;
  return { settingsPatch, cards, cardAssignments, chaseProfiles, pushLocal, applied };
}
