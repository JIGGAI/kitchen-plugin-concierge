import { initializeDatabase } from '../db';

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

  return { status: 404, data: { error: 'NOT_FOUND', path: req.path } };
}
