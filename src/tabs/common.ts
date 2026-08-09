/**
 * Minimal style + fetch helpers for the concierge Kitchen tab.
 *
 * Deliberately a local copy rather than an import from kitchen-plugin-yot:
 * plugins are installed independently, so a cross-plugin import would be a
 * dependency Kitchen cannot resolve at runtime.
 */
export const t = {
  page: { maxWidth: 860 } as Record<string, unknown>,
  muted: { opacity: 0.7 } as Record<string, unknown>,
  h2: { margin: '0 0 4px' } as Record<string, unknown>,
  section: { marginTop: 32 } as Record<string, unknown>,
  label: { display: 'block', marginTop: 16, fontWeight: 600 } as Record<string, unknown>,
  input: { width: '100%', marginTop: 6, padding: '6px 8px' } as Record<string, unknown>,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14, marginTop: 12 } as Record<string, unknown>,
  th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ddd' } as Record<string, unknown>,
  td: { padding: '6px 8px', borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' } as Record<string, unknown>,
  faint: { opacity: 0.65 } as Record<string, unknown>,
};

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

export async function api<T = any>(
  pluginId: string,
  teamId: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const join = path.startsWith('/') ? path : `/${path}`;
  const url = `/api/plugins/${pluginId}${join}${join.includes('?') ? '&' : '?'}team=${encodeURIComponent(teamId)}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { throw new Error(text || `HTTP ${res.status}`); }
  if (!res.ok) throw new Error(json?.message || json?.error || `HTTP ${res.status}`);
  return json;
}
