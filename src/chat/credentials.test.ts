import { describe, expect, it } from 'vitest';
import { selectCodexCredential } from './credentials';

describe('selectCodexCredential', () => {
  it('prefers a fresh OpenAI OAuth profile over an expired one', () => {
    const now = Date.parse('2026-10-12T17:00:00.000Z');
    const credential = selectCodexCredential({
      profiles: {
        expired: {
          provider: 'openai',
          type: 'oauth',
          access: 'expired-token',
          accountId: 'expired-account',
          expires: Date.parse('2026-10-01T21:16:14.773Z'),
          chatgptPlanType: 'pro',
        },
        fresh: {
          provider: 'openai',
          type: 'oauth',
          access: 'fresh-token',
          accountId: 'fresh-account',
          expires: Date.parse('2026-10-16T03:45:49.366Z'),
          chatgptPlanType: 'pro',
        },
      },
    }, now);

    expect(credential).toMatchObject({
      accessToken: 'fresh-token',
      accountId: 'fresh-account',
      expiresAt: Date.parse('2026-10-16T03:45:49.366Z'),
      planType: 'pro',
    });
  });

  it('falls back to the newest expired credential when no fresh profile exists', () => {
    const now = Date.parse('2026-10-12T17:00:00.000Z');
    const credential = selectCodexCredential({
      profiles: {
        older: {
          provider: 'openai',
          type: 'oauth',
          access: 'older-token',
          accountId: 'older-account',
          expires: Date.parse('2026-10-01T00:00:00.000Z'),
        },
        newer: {
          provider: 'openai',
          type: 'oauth',
          access: 'newer-token',
          accountId: 'newer-account',
          expires: Date.parse('2026-10-02T00:00:00.000Z'),
        },
      },
    }, now);

    expect(credential).toMatchObject({
      accessToken: 'newer-token',
      accountId: 'newer-account',
    });
  });
});
