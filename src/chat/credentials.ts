import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';

export interface CodexCredential {
  accessToken: string;
  accountId: string;
  /** Epoch ms. OpenClaw refreshes well before this. */
  expiresAt: number;
  planType?: string;
}

export function selectCodexCredential(
  store: { profiles?: Record<string, Record<string, unknown>> },
  now = Date.now(),
): CodexCredential | null {
  const credentials: CodexCredential[] = [];
  for (const profile of Object.values(store.profiles ?? {})) {
    if (profile?.provider !== 'openai' || profile?.type !== 'oauth') continue;

    const accessToken = typeof profile.access === 'string' ? profile.access : '';
    const accountId = typeof profile.accountId === 'string' ? profile.accountId : '';
    if (!accessToken || !accountId) continue;

    credentials.push({
      accessToken,
      accountId,
      expiresAt: typeof profile.expires === 'number' ? profile.expires : 0,
      planType: typeof profile.chatgptPlanType === 'string' ? profile.chatgptPlanType : undefined,
    });
  }

  if (!credentials.length) return null;

  const fresh = credentials.filter((cred) => credentialIsFresh(cred, 60_000, now));
  return (fresh.length ? fresh : credentials)
    .sort((a, b) => b.expiresAt - a.expiresAt)[0];
}

/**
 * Reads the OpenAI OAuth credential OpenClaw keeps for an agent.
 *
 * Where it lives: a June 2026 migration moved auth profiles out of
 * `auth-profiles.json` and into `openclaw-agent.sqlite` (table
 * `auth_profile_store`, row key `primary`). The JSON files still on disk are
 * `.sqlite-import.*.bak` leftovers from that migration and are permanently
 * stale — do not read them.
 *
 * READ ONLY, DELIBERATELY. OAuth refresh tokens are single-use and rotate: the
 * server hands back a new one each time and invalidates the old. OpenClaw owns
 * that cycle. If this plugin ever called the token endpoint itself, whichever
 * side refreshed second would get `refresh_token_reused`, and providers
 * commonly treat reuse as a breach signal and revoke the whole token family —
 * which would take down every OpenClaw agent on this machine, not just the
 * concierge. So: read the access token, never the refresh flow.
 *
 * Read fresh on every turn rather than caching, so we always pick up whatever
 * OpenClaw last refreshed.
 */
export function readCodexCredential(agentId = 'main'): CodexCredential | null {
  const dbPath = process.env.CONCIERGE_AUTH_DB
    ?? join(homedir(), '.openclaw', 'agents', agentId, 'agent', 'openclaw-agent.sqlite');
  if (!existsSync(dbPath)) return null;

  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = sqlite
      .prepare("SELECT store_json FROM auth_profile_store WHERE store_key = 'primary'")
      .get() as { store_json?: string } | undefined;
    if (!row?.store_json) return null;

    return selectCodexCredential(JSON.parse(row.store_json));
  } catch {
    return null;
  } finally {
    sqlite?.close();
  }
}

export function credentialIsFresh(cred: CodexCredential, skewMs = 60_000, now = Date.now()): boolean {
  return cred.expiresAt === 0 || cred.expiresAt - skewMs > now;
}
