import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

/**
 * Find `db/migrations/` relative to the bundled output. After esbuild
 * bundling, __dirname can be `dist/`, `dist/api/`, or (unbundled) `src/db/`
 * depending on which entry point is executing. Walk up looking for the
 * migrations directory so this works regardless of build layout.
 */
function resolveMigrationsDir(startDir: string): string | null {
  let cur = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(cur, 'db', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

type Entry = { db: ReturnType<typeof drizzle>; sqlite: Database.Database };

const cache = new Map<string, Entry>();

/**
 * Unlike kitchen-plugin-yot, this creates the database on demand. YOT refuses
 * because a missing file there means synced data was lost; here the database
 * holds only chat history, so bootstrapping is correct and a refusal would
 * just break first run.
 */
export function initializeDatabase(teamId: string): Entry {
  const cached = cache.get(teamId);
  if (cached) return cached;

  const dbDir = process.env.CONCIERGE_DB_DIR
    ?? join(homedir(), '.openclaw', 'kitchen', 'plugins', 'concierge');
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const sqlite = new Database(join(dbDir, `concierge-${teamId}.db`));
  sqlite.pragma('journal_mode = WAL');

  const migrationsDir = resolveMigrationsDir(__dirname);
  if (!migrationsDir) {
    throw new Error('kitchen-plugin-concierge: db/migrations not found');
  }
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }

  const entry: Entry = { db: drizzle(sqlite, { schema }), sqlite };
  cache.set(teamId, entry);
  return entry;
}
