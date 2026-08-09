import { randomUUID } from 'crypto';
import { eq, and, desc, lt, isNotNull, sql } from 'drizzle-orm';
import { initializeDatabase } from './index';
import { conversation, message } from './schema';

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface Source { id: string; label: string; href: string }

export interface ConversationRow {
  id: string;
  userId: string;
  status: string;
  summary: string | null;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

/**
 * Returns the id of an ACTIVE conversation owned by userId. If conversationId
 * is supplied and is an active thread belonging to that user, it is reused;
 * otherwise a new one is created.
 *
 * Two checks matter here. Ownership, so a client cannot resume someone else's
 * thread by guessing an id. And status, so an archived thread stays closed
 * rather than being reopened and appended to after it was already summarized.
 */
export function openConversation(teamId: string, userId: string, conversationId?: string): string {
  const { db } = initializeDatabase(teamId);
  const now = new Date().toISOString();

  if (conversationId) {
    const existing = db.select().from(conversation)
      .where(and(
        eq(conversation.id, conversationId),
        eq(conversation.teamId, teamId),
        eq(conversation.userId, userId),
        eq(conversation.status, 'active'),
      )).get();
    if (existing) {
      db.update(conversation).set({ lastActiveAt: now })
        .where(eq(conversation.id, conversationId)).run();
      return conversationId;
    }
  }

  const id = randomUUID();
  db.insert(conversation)
    .values({ id, teamId, userId, status: 'active', createdAt: now, lastActiveAt: now })
    .run();
  return id;
}

export function appendMessage(
  teamId: string,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  sources?: Source[],
): string {
  const { db } = initializeDatabase(teamId);
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(message).values({
    id,
    conversationId,
    role,
    content,
    sources: sources?.length ? JSON.stringify(sources) : null,
    createdAt: now,
  }).run();
  db.update(conversation).set({ lastActiveAt: now })
    .where(eq(conversation.id, conversationId)).run();
  return id;
}

/**
 * The most recent `limit` turns, in chronological order.
 *
 * Ordered DESC then reversed so the cap takes the newest turns; ordering ASC
 * with a LIMIT would return the oldest, which is the opposite of what a
 * conversation needs.
 */
export function recentTurns(teamId: string, conversationId: string, limit = 10): ChatTurn[] {
  const { db } = initializeDatabase(teamId);
  const rows = db.select().from(message)
    .where(eq(message.conversationId, conversationId))
    // rowid, not id, as the tiebreak. ISO timestamps collide at millisecond
    // resolution — a user turn and its assistant reply routinely land in the
    // same tick — and `id` is a random UUID, so ordering by it shuffles rows
    // written together. SQLite's implicit rowid is insertion order.
    .orderBy(desc(message.createdAt), desc(sql`rowid`))
    .limit(limit)
    .all();
  return rows.reverse().map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
}

export function transcriptFor(teamId: string, conversationId: string): ChatTurn[] {
  const { db } = initializeDatabase(teamId);
  return db.select().from(message)
    .where(eq(message.conversationId, conversationId))
    .orderBy(message.createdAt, sql`rowid`)
    .all()
    .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
}

/**
 * Closes a conversation and records its summary. Messages are NOT deleted —
 * archiving is a status change plus a digest. deleteConversation() is the only
 * code path in this plugin that removes rows.
 */
export function archiveConversation(
  teamId: string,
  conversationId: string,
  summary: string | null,
): boolean {
  const { db } = initializeDatabase(teamId);
  const res = db.update(conversation)
    .set({ status: 'archived', summary, summarizedAt: new Date().toISOString() })
    .where(and(eq(conversation.id, conversationId), eq(conversation.teamId, teamId)))
    .run();
  return res.changes > 0;
}

/**
 * Closes whatever thread the user has open. Returns the ids that were closed
 * so the caller can summarize them — summarizing needs a model call, which
 * does not belong in the data layer.
 */
export function archiveActiveFor(teamId: string, userId: string): string[] {
  const { db } = initializeDatabase(teamId);
  const ids = db.select({ id: conversation.id }).from(conversation)
    .where(and(
      eq(conversation.teamId, teamId),
      eq(conversation.userId, userId),
      eq(conversation.status, 'active'),
    ))
    .all().map((r) => r.id);
  for (const id of ids) archiveConversation(teamId, id, null);
  return ids;
}

/**
 * Newest-first summaries for feed-forward context, hard-capped in characters.
 *
 * The cap is not cosmetic: these are prepended to a fresh conversation, and an
 * uncapped feed would grow the prompt every time a thread closes.
 */
export function recentSummaries(
  teamId: string,
  userId: string,
  limit = 3,
  maxChars = 1500,
): string[] {
  const { db } = initializeDatabase(teamId);
  const rows = db.select({ summary: conversation.summary }).from(conversation)
    .where(and(
      eq(conversation.teamId, teamId),
      eq(conversation.userId, userId),
      eq(conversation.status, 'archived'),
      isNotNull(conversation.summary),
    ))
    .orderBy(desc(conversation.summarizedAt), desc(sql`rowid`))
    .limit(limit)
    .all();

  const out: string[] = [];
  let used = 0;
  for (const r of rows) {
    const s = (r.summary ?? '').trim();
    if (!s) continue;
    if (used + s.length > maxChars) {
      const room = maxChars - used;
      if (room > 40) out.push(s.slice(0, room));
      break;
    }
    out.push(s);
    used += s.length;
  }
  return out;
}

export function listConversations(
  teamId: string,
  opts: { userId?: string; status?: 'active' | 'archived' } = {},
): ConversationRow[] {
  const { db, sqlite } = initializeDatabase(teamId);
  const filters = [eq(conversation.teamId, teamId)];
  if (opts.userId) filters.push(eq(conversation.userId, opts.userId));
  if (opts.status) filters.push(eq(conversation.status, opts.status));

  const rows = db.select().from(conversation)
    .where(and(...filters))
    .orderBy(desc(conversation.lastActiveAt), desc(sql`rowid`))
    .all();

  const countStmt = sqlite.prepare('SELECT COUNT(*) AS n FROM message WHERE conversation_id = ?');
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    status: r.status,
    summary: r.summary,
    createdAt: r.createdAt,
    lastActiveAt: r.lastActiveAt,
    messageCount: (countStmt.get(r.id) as { n: number }).n,
  }));
}

/**
 * The only path in this plugin that removes data. Reachable from the Kitchen
 * tab's delete control or a direct DELETE — never from a timer. A grep for
 * `db.delete(` outside this function should return nothing.
 */
export function deleteConversation(teamId: string, conversationId: string): boolean {
  const { db } = initializeDatabase(teamId);
  const owned = db.select({ id: conversation.id }).from(conversation)
    .where(and(eq(conversation.id, conversationId), eq(conversation.teamId, teamId)))
    .get();
  if (!owned) return false;
  db.delete(message).where(eq(message.conversationId, conversationId)).run();
  db.delete(conversation).where(eq(conversation.id, conversationId)).run();
  return true;
}

/** Archive candidates for the daily job: active and idle. Read-only. */
export function idleUnsummarized(teamId: string, days = 30): string[] {
  const { db } = initializeDatabase(teamId);
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  return db.select({ id: conversation.id }).from(conversation)
    .where(and(
      eq(conversation.teamId, teamId),
      eq(conversation.status, 'active'),
      lt(conversation.lastActiveAt, cutoff),
    ))
    .all().map((r) => r.id);
}

/** Test seam only — backdates a conversation so idle logic can be exercised. */
export function touchForTest(teamId: string, conversationId: string, iso: string): void {
  const { db } = initializeDatabase(teamId);
  db.update(conversation).set({ lastActiveAt: iso })
    .where(eq(conversation.id, conversationId)).run();
}
