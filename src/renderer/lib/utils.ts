import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Canonical class-name helper used by every shadcn primitive in the
 * project. Merges conditional Tailwind strings + dedupes conflicting
 * utilities (e.g. `p-2` + `p-4` keeps `p-4`). Mirrors the helper Bestie
 * uses — shadcn's default — so copy-pasted components work verbatim.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
