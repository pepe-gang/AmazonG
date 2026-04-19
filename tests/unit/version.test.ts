import { describe, it, expect } from 'vitest';
import { compareSemver } from '@shared/version';

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('0.5.3', '0.5.3')).toBe(0);
  });

  it('returns > 0 when a is newer (patch)', () => {
    expect(compareSemver('0.5.4', '0.5.3')).toBeGreaterThan(0);
  });

  it('returns < 0 when a is older (patch)', () => {
    expect(compareSemver('0.5.2', '0.5.3')).toBeLessThan(0);
  });

  it('compares minor version before patch', () => {
    expect(compareSemver('0.6.0', '0.5.9')).toBeGreaterThan(0);
  });

  it('compares major version first', () => {
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('strips v prefix', () => {
    expect(compareSemver('v0.5.3', '0.5.3')).toBe(0);
    expect(compareSemver('v1.0.0', 'v0.9.0')).toBeGreaterThan(0);
  });

  it('handles missing parts as 0', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1', '1.0.0')).toBe(0);
  });
});
