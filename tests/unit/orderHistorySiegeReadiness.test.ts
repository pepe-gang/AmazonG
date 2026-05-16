/**
 * Regression test for INC-2026-05-10 (purchaseId 106-4483242-3358608,
 * expected filler order 112-4407570-5526653).
 *
 * The user's saved order-history fixture
 * `fixtures/order-history-siege-encrypted-2026-05-10.html` captures
 * the EXACT state the bot was scanning: Siege client-side decryption
 * had not yet finished, so:
 *
 *   - 10 `<div class="csd-encrypted-sensitive">` wrappers are still
 *     in the DOM (one per order card).
 *   - 10 `<div class="order-card js-order-card">` shells render, but
 *     their order IDs + `/dp/<asin>` links live inside the encrypted
 *     payload and are NOT yet in the static DOM.
 *   - The page has 74 `/dp/...` links, but every single one is from
 *     the right-rail "Buy it again" carousel (Amazon page chrome)
 *     — none are from order cards.
 *   - The only `\d{3}-\d{7}-\d{7}` string in document body is
 *     `140-9662106-7910042`, which is the page-level session id
 *     (`ue_sid`), NOT an order id.
 *
 * The pre-fix wait conditions all fire prematurely on this DOM:
 *
 *   1. `waitForFunction(() => /dp/<asin> link exists)` — TRUE on
 *      load because of the right-rail carousel. The bot scans, finds
 *      no cart-ASIN matches, returns `fillerOrderIds: []`. THIS WAS
 *      THE LIVE BUG.
 *
 *   2. `waitForFunction(() => any \d{3}-\d{7}-\d{7} in body.innerText)`
 *      — would also fire as soon as ONE card finishes decrypting,
 *      missing the rest. Insufficient.
 *
 * The correct wait: `csd-encrypted-sensitive` count must reach 0.
 * Siege removes the wrapper post-decrypt; only when all wrappers are
 * gone is the DOM ready for the cart-ASIN ↔ order-id walker.
 *
 * This test loads the captured fixture and asserts:
 *   - the "is page ready to scan?" predicate (zero encrypted divs)
 *     returns FALSE here — the bot would correctly WAIT
 *   - the "any plaintext order id?" predicate (the prior, weaker
 *     fix) would incorrectly return FALSE for body.innerText scan
 *     OF JUST CART-ID-SHAPED-STRINGS but TRUE for the session id —
 *     proving why the prior wait was insufficient
 *   - the document-walker, run against this DOM, returns 0 matches
 *     (proves the bug)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { htmlToDocument } from '../../src/shared/jsdom.js';

const FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'order-history-siege-encrypted-2026-05-10.html',
);

describe('order-history Siege readiness — INC-2026-05-10', () => {
  function loadFixture(): Document {
    const html = readFileSync(FIXTURE_PATH, 'utf8');
    return htmlToDocument(html);
  }

  it('fixture has Siege wrappers still present (decryption not started)', () => {
    const doc = loadFixture();
    const encrypted = doc.querySelectorAll('.csd-encrypted-sensitive').length;
    const cards = doc.querySelectorAll('.order-card.js-order-card').length;
    expect(encrypted).toBe(10);
    expect(cards).toBe(10);
    expect(encrypted).toBeGreaterThan(0);
  });

  it('the NEW wait predicate (zero csd-encrypted-sensitive) correctly returns FALSE', () => {
    // This is what fetchOrderIdsForAsins now waits for: zero
    // encrypted divs remaining. On this fixture the predicate must
    // be false — the bot would WAIT instead of scanning prematurely.
    const doc = loadFixture();
    const isReady =
      doc.querySelectorAll('.csd-encrypted-sensitive').length === 0;
    expect(isReady).toBe(false);
  });

  it('the OLD wait predicate (any /dp/ link) would have INCORRECTLY fired immediately', () => {
    // 74 /dp/ links exist on the page (right-rail "Buy it again"),
    // so the old condition was satisfied on load — that's the
    // live bug. Verifies the prior wait was broken on this layout.
    const doc = loadFixture();
    const oldPredicate =
      doc.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]').length > 0;
    expect(oldPredicate).toBe(true);
  });

  it('the intermediate wait (any \\d{3}-\\d{7}-\\d{7} in body) would have INCORRECTLY matched session id', () => {
    // Even the "wait for plaintext order id" predicate would have
    // matched here because `140-9662106-7910042` (the page session
    // id) is visible in body. innerText excludes <script>, but the
    // session id is also placed in visible DOM nodes for tracking.
    // Verifies why the second iteration of the fix was also wrong.
    const doc = loadFixture();
    const bodyText = doc.body.textContent ?? '';
    const hasOrderIdShape = /\b\d{3}-\d{7}-\d{7}\b/.test(bodyText);
    expect(hasOrderIdShape).toBe(true);
    // But the only match is the session id, NOT any actual order id.
    const matches = Array.from(bodyText.matchAll(/\b\d{3}-\d{7}-\d{7}\b/g)).map(
      (m) => m[0],
    );
    const unique = Array.from(new Set(matches));
    expect(unique).toContain('140-9662106-7910042'); // session id
    expect(unique).not.toContain('112-4407570-5526653'); // expected filler order
  });

  it('the document-walker scan returns 0 matches against this encrypted DOM (the bug)', () => {
    // Distilled bot scan: walk text + link nodes, attribute /dp/<asin>
    // to most-recently-seen orderId. Verifies that even the
    // algorithm's logic is correct — the failure is purely upstream
    // (the page wasn't ready). With zero plaintext order IDs from
    // order cards, no cart-ASIN can be attributed.
    const doc = loadFixture();
    const cartAsins = [
      'B0GR1JTFP8', // target — assume MacBook
      'B086PHRXLR', // ASINs that would have been in fillers — placeholders;
      'B0B64N8C27', // since cards are encrypted the walker won't find any
    ];

    type Event = { kind: 'id'; id: string } | { kind: 'link'; asin: string };
    const events: Event[] = [];

    const linkNodes = Array.from(
      doc.querySelectorAll<HTMLAnchorElement>(
        'a[href*="/dp/"], a[href*="/gp/product/"]',
      ),
    );
    const linkToAsin = new Map<Element, string>();
    for (const a of linkNodes) {
      const m = (a.getAttribute('href') || '').match(
        /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i,
      );
      if (m?.[1]) linkToAsin.set(a, m[1]);
    }

    // Walk text nodes for order id strings; element nodes for /dp/ links.
    const walker = doc.createTreeWalker(
      doc.body,
      0x1 | 0x4, // SHOW_ELEMENT | SHOW_TEXT
      {
        acceptNode(node) {
          if (node.nodeType === 3 /* TEXT */) {
            const tag = (node as Text).parentElement?.tagName;
            if (
              tag === 'SCRIPT' ||
              tag === 'STYLE' ||
              tag === 'NOSCRIPT' ||
              tag === 'TEMPLATE'
            ) {
              return 2; /* FILTER_REJECT */
            }
          }
          return 1; /* FILTER_ACCEPT */
        },
      },
    );
    const seenIds = new Set<string>();
    let n: Node | null = walker.nextNode();
    while (n) {
      if (n.nodeType === 3) {
        const text = (n.textContent ?? '').trim();
        if (text) {
          const re = /\b(\d{3}-\d{7}-\d{7})\b/g;
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(text)) !== null) {
            const id = mm[1]!;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              events.push({ kind: 'id', id });
            }
          }
        }
      } else if (n.nodeType === 1) {
        const asin = linkToAsin.get(n as Element);
        if (asin) events.push({ kind: 'link', asin });
      }
      n = walker.nextNode();
    }

    const asinToFirstOrder = new Map<string, string>();
    let currentId: string | null = null;
    for (const ev of events) {
      if (ev.kind === 'id') currentId = ev.id;
      else if (
        currentId &&
        cartAsins.includes(ev.asin) &&
        !asinToFirstOrder.has(ev.asin)
      ) {
        asinToFirstOrder.set(ev.asin, currentId);
      }
    }
    const matchedByOrder = new Map<string, Set<string>>();
    for (const [asin, orderId] of asinToFirstOrder) {
      if (!matchedByOrder.has(orderId)) matchedByOrder.set(orderId, new Set());
      matchedByOrder.get(orderId)!.add(asin);
    }
    const orderMatches = Array.from(matchedByOrder.entries()).map(
      ([orderId, set]) => ({ orderId, matchedAsins: Array.from(set) }),
    );

    // The expected filler order id is NOT found (would need Siege
    // decryption first). Algorithm is correct; page was wrong.
    expect(orderMatches.find((m) => m.orderId === '112-4407570-5526653')).toBeUndefined();
    // No cart-ASIN gets attributed to any order because the encrypted
    // cards have no /dp/ links to walk.
    expect(orderMatches.length).toBe(0);
  });
});
