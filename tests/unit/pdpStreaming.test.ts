import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractCartAddTokens } from '../../src/actions/amazonHttp';

const FIXTURES_DIR = join(__dirname, '../../fixtures/product');

/**
 * Replicates the cancel-point logic from `pdpHttpFetchStreaming`:
 * once `<form id="addToCart">` is open AND closed in the buffered
 * text, the stream is cancelled. Returns the truncated text — the
 * exact slice the parser would see in production.
 */
function truncateAtFormClose(html: string, safetyCapBytes: number): string {
  const formStart = html.indexOf('id="addToCart"');
  if (formStart < 0) {
    return html.slice(0, Math.min(html.length, safetyCapBytes));
  }
  const formEnd = html.indexOf('</form>', formStart);
  if (formEnd < 0) {
    return html.slice(0, Math.min(html.length, safetyCapBytes));
  }
  // Streaming reader cancels right after the chunk containing `</form>`,
  // so the buffered text in production contains AT LEAST through `</form>`
  // plus any trailing bytes from that same chunk. Simulate by truncating
  // at the end of `</form>` itself (worst case: minimum amount of text).
  return html.slice(0, formEnd + '</form>'.length);
}

describe('pdpHttpFetchStreaming cancel-point', () => {
  const fixtures = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.html'));

  it('truncates well before the full body', () => {
    // Sanity check the test premise: the form ends well within the safety
    // cap on real fixtures, so streaming would actually save bytes.
    let savedAtLeast = 0;
    for (const file of fixtures) {
      const html = readFileSync(join(FIXTURES_DIR, file), 'utf8');
      const truncated = truncateAtFormClose(html, 600 * 1024);
      const saved = html.length - truncated.length;
      if (saved > 0) savedAtLeast++;
    }
    // Most fixtures should have a meaningful savings (form is in first ~25% of body).
    expect(savedAtLeast).toBeGreaterThan(fixtures.length * 0.5);
  });

  // Per-fixture: if the fixture has a buyable form (extractCartAddTokens
  // succeeds on the full body), it MUST also succeed on the truncated body.
  // This proves the cancel point is safe: the parser sees identical tokens
  // either way.
  it.each(fixtures.map((f) => [f]))(
    'truncated %s parses identically to full body',
    (file) => {
      const fullHtml = readFileSync(join(FIXTURES_DIR, file as string), 'utf8');
      const fullDoc = new JSDOM(fullHtml).window.document;
      const fullTokens = extractCartAddTokens(fullDoc);

      const truncated = truncateAtFormClose(fullHtml, 600 * 1024);
      const truncatedDoc = new JSDOM(truncated).window.document;
      const truncatedTokens = extractCartAddTokens(truncatedDoc);

      // Truncated must produce the SAME result as full — null for
      // non-buyable fixtures, identical tokens for buyable ones.
      expect(truncatedTokens).toEqual(fullTokens);
    },
  );

  it('truncated buyable fixture stays under the safety cap', () => {
    // Spot-check on B0DZ751XN6 (the iPad fixture pass-5 measured): the
    // full body is ~2.3MB, the truncated text should be well under the
    // 600KB safety cap — proving the cancel fires before the cap, not
    // because of it.
    const html = readFileSync(join(FIXTURES_DIR, 'B0DZ751XN6.html'), 'utf8');
    const truncated = truncateAtFormClose(html, 600 * 1024);
    expect(html.length).toBeGreaterThan(2_000_000);
    expect(truncated.length).toBeLessThan(600 * 1024);
    // And the form is fully present
    expect(truncated).toContain('id="addToCart"');
    expect(truncated).toContain('</form>');
  });
});
