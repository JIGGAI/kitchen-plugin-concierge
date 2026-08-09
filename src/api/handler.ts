import { initializeDatabase } from '../db';
import { eq } from 'drizzle-orm';
import {
  openConversation, recentTurns, archiveActiveFor,
  listConversations, deleteConversation, transcriptFor,
} from '../db/history';
import { pluginConfig } from '../db/schema';
import { DEFAULT_PERSONA } from '../chat/prompt';

const ALLOWED_MODELS = ['gpt-5.5', 'gpt-5', 'gpt-5-mini'];
const MAX_PERSONA_CHARS = 4000;

function readConfig(teamId: string) {
  const { db } = initializeDatabase(teamId);
  const rows = db.select().from(pluginConfig).where(eq(pluginConfig.teamId, teamId)).all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  let enabledSlices: string[] | null = null;
  const raw = map.get('enabledSlices');
  if (raw) { try { enabledSlices = JSON.parse(raw); } catch { enabledSlices = null; } }
  return {
    persona: map.get('persona') ?? DEFAULT_PERSONA,
    model: map.get('model') ?? 'gpt-5.5',
    enabledSlices,
  };
}

function writeConfig(teamId: string, patch: Record<string, string>) {
  const { db } = initializeDatabase(teamId);
  const now = new Date().toISOString();
  for (const [key, value] of Object.entries(patch)) {
    db.insert(pluginConfig)
      .values({ teamId, key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [pluginConfig.teamId, pluginConfig.key],
        set: { value, updatedAt: now },
      })
      .run();
  }
}

export interface PluginRequest {
  path: string;
  method: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface PluginResponse {
  status: number;
  data: unknown;
}

function getTeamId(req: PluginRequest): string {
  // Kitchen sends `?team=`; the dashboard sends an x-team-id header or
  // `?teamId=`. Accept all three rather than silently falling back to
  // 'default' and writing to the wrong database.
  return req.headers?.['x-team-id'] ?? req.query?.teamId ?? req.query?.team ?? 'default';
}

export async function handleRequest(req: PluginRequest, _ctx?: unknown): Promise<PluginResponse> {
  const teamId = getTeamId(req);

  if (req.path === '/health' && req.method === 'GET') {
    try {
      const { sqlite } = initializeDatabase(teamId);
      sqlite.prepare('SELECT 1').get();
      return { status: 200, data: { ok: true, database: 'ready', teamId } };
    } catch (err) {
      return {
        status: 500,
        data: { ok: false, database: 'error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (req.path === '/config' && req.method === 'GET') {
    return { status: 200, data: readConfig(teamId) };
  }

  // Note what is absent: there is no route that grants a capability. This
  // toggles slices that already exist in the version-controlled registry and
  // edits the persona. Widening what the concierge can read stays a commit.
  if (req.path === '/config' && req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, string> = {};

    if (typeof body.persona === 'string') {
      if (body.persona.length > MAX_PERSONA_CHARS) {
        return { status: 400, data: { error: `persona too long (max ${MAX_PERSONA_CHARS} chars)` } };
      }
      patch.persona = body.persona;
    }
    if (typeof body.model === 'string') {
      if (!ALLOWED_MODELS.includes(body.model)) {
        return { status: 400, data: { error: `model must be one of ${ALLOWED_MODELS.join(', ')}` } };
      }
      patch.model = body.model;
    }
    if (Array.isArray(body.enabledSlices)) {
      patch.enabledSlices = JSON.stringify(body.enabledSlices.map(String));
    }

    if (!Object.keys(patch).length) {
      return { status: 400, data: { error: 'nothing to update' } };
    }
    writeConfig(teamId, patch);
    return { status: 200, data: readConfig(teamId) };
  }

  if (req.path === '/history' && req.method === 'GET') {
    const userId = req.query?.userId;
    if (!userId) return { status: 400, data: { error: 'userId required' } };
    const requested = req.query?.conversationId;
    if (!requested) return { status: 200, data: { conversationId: null, turns: [] } };
    const id = openConversation(teamId, userId, requested);
    return {
      status: 200,
      data: {
        conversationId: id,
        // A different id back means the requested thread was archived (or not
        // theirs) and a fresh one was opened; the client's log should be empty.
        turns: id === requested ? recentTurns(teamId, id, 20) : [],
      },
    };
  }

  // Close the caller's open thread. Deliberately a POST, not a DELETE —
  // nothing is removed. Summarizing happens in the caller, which has the
  // model credential and can do it behind the response.
  if (req.path === '/history/archive' && req.method === 'POST') {
    const userId = req.query?.userId;
    if (!userId) return { status: 400, data: { error: 'userId required' } };
    return { status: 200, data: { archived: archiveActiveFor(teamId, userId) } };
  }

  if (req.path === '/conversations' && req.method === 'GET') {
    const status = req.query?.status as 'active' | 'archived' | undefined;
    // userId is optional here on purpose: the Kitchen tab is an admin surface
    // and lists everyone. The dashboard always passes the session user, so an
    // end user only ever sees their own.
    return {
      status: 200,
      data: { conversations: listConversations(teamId, { userId: req.query?.userId, status }) },
    };
  }

  if (req.path.startsWith('/conversations/') && req.method === 'GET') {
    const id = req.path.slice('/conversations/'.length);
    // Ownership is enforced here, not left to the caller. When userId is
    // supplied the conversation must belong to them — otherwise anyone who
    // learns an id could read someone else's thread.
    const userId = req.query?.userId;
    if (userId) {
      const owned = listConversations(teamId, { userId }).some((c) => c.id === id);
      if (!owned) return { status: 404, data: { error: 'NOT_FOUND', conversationId: id } };
    }
    return { status: 200, data: { conversationId: id, turns: transcriptFor(teamId, id) } };
  }

  if (req.path.startsWith('/conversations/') && req.method === 'DELETE') {
    const id = req.path.slice('/conversations/'.length);
    return deleteConversation(teamId, id)
      ? { status: 200, data: { deleted: id } }
      : { status: 404, data: { error: 'NOT_FOUND', conversationId: id } };
  }

  return { status: 404, data: { error: 'NOT_FOUND', path: req.path } };
}
