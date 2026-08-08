import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

beforeAll(() => {
  process.env.CONCIERGE_DB_DIR = mkdtempSync(join(tmpdir(), 'concierge-test-'));
});

describe('handleRequest', () => {
  it('answers /health with ok and a reachable database', async () => {
    const { handleRequest } = await import('./handler');
    const res = await handleRequest(
      { path: '/health', method: 'GET', headers: { 'x-team-id': 'hmx-marketing-team' } },
      {},
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ ok: true, database: 'ready' });
  });

  it('404s an unknown path', async () => {
    const { handleRequest } = await import('./handler');
    const res = await handleRequest(
      { path: '/nope', method: 'GET', headers: { 'x-team-id': 'hmx-marketing-team' } },
      {},
    );
    expect(res.status).toBe(404);
  });
});
