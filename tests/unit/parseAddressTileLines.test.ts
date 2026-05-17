import { describe, it, expect } from 'vitest';
import { parseAddressTileLines } from '../../src/actions/addAddress.js';

describe('parseAddressTileLines', () => {
  it('parses a real BG address-book tile (recon 2026-05-17)', () => {
    const addr = parseAddressTileLines([
      'Huyen Nguyen (BG1)',
      '13132 N.E., AIRP0RT WAY',
      'Portland, OR 97230',
      'United States',
      'Phone number: ‪6822405526‬',
    ]);
    expect(addr).toEqual({
      fullName: 'Huyen Nguyen (BG1)',
      phone: '6822405526',
      street1: '13132 N.E., AIRP0RT WAY',
      street2: null,
      city: 'Portland',
      state: 'OR',
      zip: '97230',
    });
  });

  it('parses a tile with a street2 line', () => {
    const addr = parseAddressTileLines([
      'Jane Doe',
      '123 Main St',
      'Apt 4B',
      'Sunnyvale, CA 94089',
      'United States',
      'Phone number: 4085551234',
    ]);
    expect(addr?.street1).toBe('123 Main St');
    expect(addr?.street2).toBe('Apt 4B');
    expect(addr?.city).toBe('Sunnyvale');
    expect(addr?.state).toBe('CA');
    expect(addr?.zip).toBe('94089');
  });

  it('takes the 5-digit zip from a ZIP+4', () => {
    const addr = parseAddressTileLines([
      'Jane Doe',
      '123 Main St',
      'Sunnyvale, CA 94089-2287',
      'United States',
    ]);
    expect(addr?.zip).toBe('94089');
  });

  it('drops a leading "Default:" marker line', () => {
    const addr = parseAddressTileLines([
      'Default:',
      'Jane Doe',
      '123 Main St',
      'Portland, OR 97230',
    ]);
    expect(addr?.fullName).toBe('Jane Doe');
    expect(addr?.street1).toBe('123 Main St');
  });

  it('returns empty phone when no phone line is present', () => {
    const addr = parseAddressTileLines([
      'Jane Doe',
      '123 Main St',
      'Portland, OR 97230',
    ]);
    expect(addr?.phone).toBe('');
  });

  it('returns null when there is no city/state/zip line', () => {
    expect(
      parseAddressTileLines(['Jane Doe', '123 Main St', 'United States']),
    ).toBeNull();
  });

  it('returns null when there is no street line before the city', () => {
    expect(parseAddressTileLines(['Jane Doe', 'Portland, OR 97230'])).toBeNull();
  });
});
