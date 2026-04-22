/**
 * Pure selection helper for the jobStore ring buffer. Lives in its own
 * module so tests can import it without dragging Electron in.
 *
 * Given a map of attempts and a cap, returns the ids of the oldest
 * rows (by `createdAt` ISO string) that should be evicted. Empty
 * array when size is at or below the cap.
 */
export function pickIdsToEvict(
  attempts: Record<string, { createdAt: string }>,
  cap: number,
): string[] {
  const ids = Object.keys(attempts);
  if (ids.length <= cap) return [];
  const sorted = ids
    .map((id) => ({ id, ts: attempts[id]!.createdAt }))
    .sort((a, b) => a.ts.localeCompare(b.ts));
  return sorted.slice(0, ids.length - cap).map((e) => e.id);
}
