import { initializeDatabase } from '../db';
import {
  openConversation, recentTurns, archiveActiveFor,
  listConversations, deleteConversation, transcriptFor,
} from '../db/history';

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
  return req.headers?.['x-team-id'] ?? req.query?.teamId ?? 'default';
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
    return {
      status: 200,
      data: { conversations: listConversations(teamId, { userId: req.query?.userId, status }) },
    };
  }

  if (req.path.startsWith('/conversations/') && req.method === 'GET') {
    const id = req.path.slice('/conversations/'.length);
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
