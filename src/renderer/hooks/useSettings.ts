import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../../shared/ipc.js';

/** In-process fan-out so every component that called `useSettings()`
 *  picks up an update made by another component. Each instance
 *  maintains its own copy of the settings object (local useState); the
 *  custom event keeps them in sync without adding another IPC channel. */
const SETTINGS_EVENT = 'autog:settings-changed';

/** Fetch settings once on mount + provide an updater. Used by the
 *  settings panels (LiveModePanel / HeadlessTogglePanel /
 *  AllowedPrefixesPanel) instead of each panel doing its own IPC dance.
 *  Subscribes to SETTINGS_EVENT so that when one component updates a
 *  setting, every other `useSettings()` copy in the tree re-fetches
 *  and re-renders (previously each instance cached the initial fetch
 *  and never refreshed — the Dashboard failed counter kept the stale
 *  value until the user hit reload). */
export function useSettings(): {
  settings: Settings | null;
  busy: boolean;
  update: (patch: Partial<Settings>) => Promise<void>;
} {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refresh = (next?: Settings) => {
      if (next) {
        if (!cancelled) setSettings(next);
        return;
      }
      void window.autog.settingsGet().then((s) => {
        if (!cancelled) setSettings(s);
      });
    };
    refresh();
    const onEvt = (e: Event) => {
      const detail = (e as CustomEvent<Settings>).detail;
      refresh(detail);
    };
    window.addEventListener(SETTINGS_EVENT, onEvt);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_EVENT, onEvt);
    };
  }, []);
  const update = useCallback(async (patch: Partial<Settings>) => {
    setBusy(true);
    try {
      const next = await window.autog.settingsSet(patch);
      setSettings(next);
      // Fan out to every other live useSettings() consumer. Passing
      // `next` as detail avoids a second IPC round-trip on each one.
      window.dispatchEvent(new CustomEvent<Settings>(SETTINGS_EVENT, { detail: next }));
    } finally {
      setBusy(false);
    }
  }, []);
  return { settings, busy, update };
}
