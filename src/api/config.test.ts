import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

beforeAll(() => {
  process.env.CONCIERGE_DB_DIR = mkdtempSync(join(tmpdir(), 'concierge-cfg-'));
});

const headers = { 'x-team-id': 'hmx-marketing-team' };

describe('config routes', () => {
  it('returns defaults before anything is saved', async () => {
    const { handleRequest } = await import('./handler');
    const res = await handleRequest({ path: '/config', method: 'GET', headers }, {});
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ model: 'gpt-5.5' });
    expect((res.data as any).persona.length).toBeGreaterThan(10);
  });

  it('round-trips a saved persona', async () => {
    const { handleRequest } = await import('./handler');
    await handleRequest(
      { path: '/config', method: 'POST', headers, body: { persona: 'Terse and factual.' } }, {},
    );
    const res = await handleRequest({ path: '/config', method: 'GET', headers }, {});
    expect((res.data as any).persona).toBe('Terse and factual.');
  });

  it('rejects an unknown model', async () => {
    const { handleRequest } = await import('./handler');
    const res = await handleRequest(
      { path: '/config', method: 'POST', headers, body: { model: 'definitely-not-a-model' } }, {},
    );
    expect(res.status).toBe(400);
  });

  it('rejects an oversized persona', async () => {
    const { handleRequest } = await import('./handler');
    const res = await handleRequest(
      { path: '/config', method: 'POST', headers, body: { persona: 'x'.repeat(4001) } }, {},
    );
    expect(res.status).toBe(400);
  });

  it('has no route that grants a capability — config cannot add a slice', async () => {
    const { handleRequest } = await import('./handler');
    const res = await handleRequest(
      { path: '/config', method: 'POST', headers, body: { slices: [{ id: 'evil', read: 'x' }] } }, {},
    );
    // Unknown keys are ignored; nothing to update means a 400, not a silent accept.
    expect(res.status).toBe(400);
    const after = await handleRequest({ path: '/config', method: 'GET', headers }, {});
    expect(Object.keys(after.data as object).sort()).toEqual(['enabledSlices', 'model', 'persona']);
  });

  it('accepts Kitchen\'s ?team= as well as the x-team-id header', async () => {
    const { handleRequest } = await import('./handler');
    const res = await handleRequest(
      { path: '/config', method: 'GET', query: { team: 'other-team' } }, {},
    );
    expect(res.status).toBe(200);
  });
});

describe('conversation read ownership', () => {
  it('will not return another user\'s transcript', async () => {
    const { handleRequest } = await import('./handler');
    const h = await import('../db/history');
    const TEAM = 'own-test';
    const mine = h.openConversation(TEAM, 'user-a');
    h.appendMessage(TEAM, mine, 'user', 'private');

    const asOwner = await handleRequest(
      { path: `/conversations/${mine}`, method: 'GET', query: { userId: 'user-a' }, headers: { 'x-team-id': TEAM } }, {},
    );
    expect(asOwner.status).toBe(200);
    expect((asOwner.data as any).turns).toHaveLength(1);

    const asOther = await handleRequest(
      { path: `/conversations/${mine}`, method: 'GET', query: { userId: 'user-b' }, headers: { 'x-team-id': TEAM } }, {},
    );
    expect(asOther.status).toBe(404);
  });
});
