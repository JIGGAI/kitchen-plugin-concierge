export interface SliceParam {
  type: 'string';
  description: string;
  required?: boolean;
}

export interface SliceContext {
  teamId: string;
  user: { id: string; email: string };
  roles: string[];
  scope: unknown;
  params: Record<string, string | undefined>;
}

/**
 * A slice is one read-only view of the host application's data.
 *
 * `read` is the only verb, deliberately. The concierge cannot write, execute,
 * or fetch because no such capability is defined here — not because one is
 * denied elsewhere. See the read-only-guarantee test in types.test.ts, which
 * fails if a second function-valued property appears on a slice.
 */
export interface Slice {
  id: string;
  label: string;
  href: string;
  /** The tool description the model routes on. Write it as a menu entry. */
  description: string;
  /** Section role required, or null for everyone. */
  role: string | null;
  parameters: Record<string, SliceParam>;
  read(ctx: SliceContext): Promise<string | null>;
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: object };
}

/**
 * Mirrors hasSectionRole() in the dashboard's server.js: admin and super-admin
 * inherit every section role. Keep the two in step — if the dashboard's
 * inheritance rules change, this must change with them.
 */
const INHERITS_EVERYTHING = ['admin', 'super-admin'];

export function hasRole(roles: string[], role: string | null): boolean {
  if (role === null) return true;
  if (!Array.isArray(roles)) return false;
  if (roles.some((r) => INHERITS_EVERYTHING.includes(r))) return true;
  return roles.includes(role);
}

export function visibleSlices(slices: Slice[], roles: string[]): Slice[] {
  return slices.filter((s) => hasRole(roles, s.role));
}

export function toolName(sliceId: string): string {
  return `read_${sliceId.replace(/-/g, '_')}`;
}

export function toolsFor(slices: Slice[], roles: string[]): OpenAITool[] {
  return visibleSlices(slices, roles).map((s) => ({
    type: 'function' as const,
    function: {
      name: toolName(s.id),
      description: `${s.description} (Shown on the ${s.label} page at ${s.href}.)`,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(s.parameters).map(([k, p]) => [k, { type: p.type, description: p.description }]),
        ),
        required: Object.entries(s.parameters).filter(([, p]) => p.required).map(([k]) => k),
        additionalProperties: false,
      },
    },
  }));
}
