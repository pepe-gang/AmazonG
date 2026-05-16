import type { AutoGSyncBlob, SyncCard } from '../shared/types.js';
import type { FillerPool } from '../shared/ipc.js';

/**
 * The local actions a startup BG cross-device sync pull should take,
 * derived purely from the BG blob + the local card count.
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
  /** Push local state up to BG after applying — BG had no row yet, or
   *  BG's card list was empty while this machine has cards (so an
   *  empty remote can't wipe a populated local vault). */
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
): SyncPlan {
  // No row on BG yet — seed it from this machine, change nothing local.
  if (!blob.exists) {
    return { settingsPatch: {}, cards: null, pushLocal: true, applied: false };
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

  const applied = Object.keys(settingsPatch).length > 0 || cards !== null;
  return { settingsPatch, cards, pushLocal, applied };
}
