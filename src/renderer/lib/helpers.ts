/**
 * Small render-time helpers shared by the Deals page. Ported from
 * Bestie so the two codebases stay visually in sync.
 */

/** `just now / Xm ago / Xh ago / Xd ago` from a ms timestamp. */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Render a dollar amount to `$X.YZ`. Accepts `number` already parsed. */
export function fmtDollars(dollars: number): string {
  return `$${dollars.toFixed(2)}`;
}

/** Clip a string at a word boundary near `maxChars`, append ellipsis. */
export function truncateAtWord(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const slice = s.slice(0, maxChars + 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut =
    lastSpace > maxChars / 2 ? slice.slice(0, lastSpace) : slice.slice(0, maxChars);
  return cut.replace(/[\s·\-–—]+$/, '') + '…';
}

export interface MarginDisplay {
  /** Arrow glyph — "▲" when payout > retail, "▼" when payout < retail, "" when equal / unknown. */
  indicator: string;
  /** `$|diff| | ±pct%` — or `$0.00 | 0.00%` when retail is missing (BG convention: missing retail ≡ retail equal to payout). */
  label: string;
  /** Tailwind color class matching the direction. */
  className: string;
}

/**
 * Payout-vs-retail margin display. `price` is what BG pays; `oldPrice`
 * is what Amazon charges. A positive margin means you keep the difference
 * — green. A negative margin means you're paying out of pocket — red.
 *
 * BG feed convention: when retail (oldPrice) is missing, it means retail
 * equals payout — so margin is $0.00 / 0.00% (rendered neutral), not
 * "unknown".
 */
export function computeMargin(
  price: number,
  oldPrice: number | null | undefined,
): MarginDisplay {
  const retail = oldPrice ?? price;
  if (retail === 0) {
    return { indicator: '', label: '—', className: 'text-muted-foreground' };
  }
  const dollars = price - retail;
  const pct = (dollars / retail) * 100;
  // Break-even is a win, not neutral — on a 0% deal BG still pays the
  // cashback on top of Amazon retail, so it goes to the user's pocket.
  // Render green so users stop skipping these by reflex.
  if (dollars === 0) {
    return {
      indicator: '▲',
      label: '$0.00 | 0.00%',
      className: 'text-emerald-300',
    };
  }
  const up = dollars > 0;
  const pctLabel = `${up ? '+' : '−'}${Math.abs(pct).toFixed(2)}%`;
  const dollarLabel = `$${Math.abs(dollars).toFixed(2)}`;
  return {
    indicator: up ? '▲' : '▼',
    label: `${dollarLabel} | ${pctLabel}`,
    className: up ? 'text-emerald-300' : 'text-red-300',
  };
}
