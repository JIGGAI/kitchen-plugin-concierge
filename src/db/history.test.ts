import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

beforeAll(() => {
  process.env.CONCIERGE_DB_DIR = mkdtempSync(join(tmpdir(), 'concierge-hist-'));
});

const TEAM = 'hmx-marketing-team';

describe('history', () => {
  it('opens a conversation and returns turns in order', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-1');
    h.appendMessage(TEAM, id, 'user', 'How is revenue?');
    h.appendMessage(TEAM, id, 'assistant', 'Up 4%.', [{ id: 'summary', label: 'Overview', href: '/' }]);

    const turns = h.recentTurns(TEAM, id);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1].content).toBe('Up 4%.');
  });

  it('reuses an existing conversation id', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-2');
    expect(h.openConversation(TEAM, 'user-2', id)).toBe(id);
  });

  it("will not open another user's conversation", async () => {
    const h = await import('./history');
    const mine = h.openConversation(TEAM, 'user-3');
    const theirs = h.openConversation(TEAM, 'user-4', mine);
    expect(theirs).not.toBe(mine);
  });

  it('caps the turns it returns', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-5');
    for (let i = 0; i < 30; i++) h.appendMessage(TEAM, id, 'user', `q${i}`);
    expect(h.recentTurns(TEAM, id, 10)).toHaveLength(10);
  });

  it('returns the LAST n turns, not the first', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-5b');
    for (let i = 0; i < 12; i++) h.appendMessage(TEAM, id, 'user', `q${i}`);
    const turns = h.recentTurns(TEAM, id, 3);
    expect(turns.map((t) => t.content)).toEqual(['q9', 'q10', 'q11']);
  });

  it('archives without deleting a single message', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-6');
    h.appendMessage(TEAM, id, 'user', 'What drove the Auburn Hills dip?');
    h.appendMessage(TEAM, id, 'assistant', 'Two stylists left mid-month.');

    h.archiveConversation(TEAM, id, 'Looked into the Auburn Hills retention dip.');

    expect(h.transcriptFor(TEAM, id)).toHaveLength(2);
    const row = h.listConversations(TEAM, { userId: 'user-6' })[0];
    expect(row.status).toBe('archived');
    expect(row.summary).toMatch(/Auburn Hills/);
    expect(row.messageCount).toBe(2);
  });

  it('archives the open thread instead of deleting it, and starts a fresh one', async () => {
    const h = await import('./history');
    const first = h.openConversation(TEAM, 'user-7');
    h.appendMessage(TEAM, first, 'user', 'x');

    h.archiveActiveFor(TEAM, 'user-7');
    const second = h.openConversation(TEAM, 'user-7');

    expect(second).not.toBe(first);
    expect(h.transcriptFor(TEAM, first)).toHaveLength(1);
    expect(h.listConversations(TEAM, { userId: 'user-7' })).toHaveLength(2);
  });

  it('will not resume an archived conversation', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-8');
    h.archiveConversation(TEAM, id, 'done');
    expect(h.openConversation(TEAM, 'user-8', id)).not.toBe(id);
  });

  it('feeds recent summaries forward, newest first and capped', async () => {
    const h = await import('./history');
    for (const text of ['first topic', 'second topic', 'third topic', 'fourth topic']) {
      const id = h.openConversation(TEAM, 'user-9');
      h.appendMessage(TEAM, id, 'user', text);
      h.archiveConversation(TEAM, id, `Discussed ${text}.`);
    }
    const summaries = h.recentSummaries(TEAM, 'user-9', 3);
    expect(summaries).toHaveLength(3);
    expect(summaries[0]).toMatch(/fourth/);
    expect(h.recentSummaries(TEAM, 'user-9', 3, 40).join('').length).toBeLessThanOrEqual(40);
  });

  it('does not feed one user summaries from another', async () => {
    const h = await import('./history');
    const mine = h.openConversation(TEAM, 'user-9a');
    h.archiveConversation(TEAM, mine, 'Private thing I asked about.');
    expect(h.recentSummaries(TEAM, 'user-9b')).toEqual([]);
  });

  it('only removes a conversation on an explicit delete', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-10');
    h.appendMessage(TEAM, id, 'user', 'sensitive');
    h.archiveConversation(TEAM, id, 'note');

    expect(h.listConversations(TEAM, { userId: 'user-10' })).toHaveLength(1);
    expect(h.deleteConversation(TEAM, id)).toBe(true);
    expect(h.listConversations(TEAM, { userId: 'user-10' })).toHaveLength(0);
    expect(h.transcriptFor(TEAM, id)).toHaveLength(0);
  });

  it('lists idle conversations as archive candidates without touching them', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-11');
    h.appendMessage(TEAM, id, 'user', 'old question');
    h.touchForTest(TEAM, id, new Date(Date.now() - 45 * 86_400_000).toISOString());

    expect(h.idleUnsummarized(TEAM, 30)).toContain(id);
    expect(h.listConversations(TEAM, { userId: 'user-11' })[0].status).toBe('active');
  });

  it('does not list a recently active conversation as idle', async () => {
    const h = await import('./history');
    const id = h.openConversation(TEAM, 'user-12');
    expect(h.idleUnsummarized(TEAM, 30)).not.toContain(id);
  });
});
