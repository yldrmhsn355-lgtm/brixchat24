import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../lib/api', () => ({ apiJson: vi.fn() }));
import { signedMediaRefreshAt } from './use-media-urls';

describe('signed URL renewal schedule', () => {
  it('refreshes before expiry and bounds immediate retries', () => {
    const now=Date.parse('2026-09-12T10:00:00Z');
    expect(signedMediaRefreshAt({url:'https://example.test/media',expiresAt:new Date(now+300000).toISOString()},now)).toBe(now+270000);
    expect(signedMediaRefreshAt({url:'https://example.test/media',expiresAt:new Date(now-1).toISOString()},now)).toBe(now+15000);
    expect(signedMediaRefreshAt({url:'https://example.test/media',expiresAt:'invalid'},now)).toBe(now+120000);
  });
});
