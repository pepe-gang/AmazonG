import { describe, expect, it } from 'vitest';
import { sanitizeChaseProfileId } from '../../src/main/chaseProfiles.js';

describe('sanitizeChaseProfileId', () => {
  it('passes through a randomUUID-shape value unchanged', () => {
    const uuid = '64921028-5a0f-4b8b-a2b1-a81b8ba4b261';
    expect(sanitizeChaseProfileId(uuid)).toBe(uuid);
  });

  it('strips path-traversal characters', () => {
    expect(sanitizeChaseProfileId('../../../etc/passwd')).toBe('etcpasswd');
  });

  it('strips slashes and special characters but keeps dashes', () => {
    expect(sanitizeChaseProfileId('foo-bar/baz\\qux')).toBe('foo-barbazqux');
  });

  it('preserves alphanumerics across mixed case', () => {
    expect(sanitizeChaseProfileId('AbC123')).toBe('AbC123');
  });

  it('throws when the result would be empty', () => {
    // All-special-character input. Without the throw, the caller
    // would get "" and downstream `join(userData, "chase-profiles", "")`
    // would resolve to the parent directory — and the rm -rf in
    // removeChaseProfile would wipe every profile. Explicit failure
    // is the correct response.
    expect(() => sanitizeChaseProfileId('..')).toThrow(/unsafe chase profile id/);
    expect(() => sanitizeChaseProfileId('')).toThrow(/unsafe chase profile id/);
    expect(() => sanitizeChaseProfileId('!!!')).toThrow(/unsafe chase profile id/);
  });
});
