import { describe, it, expect } from 'vitest';
import { hasRole, visibleSlices, toolsFor, toolName, type Slice } from './types';

const summary: Slice = {
  id: 'summary', label: 'Overview', href: '/', description: 'Org-wide KPIs.',
  role: null, parameters: {}, async read() { return 'revenue up'; },
};

const payouts: Slice = {
  id: 'payouts', label: 'Daily Payouts', href: '/daily-payouts',
  description: 'Per-stylist disbursements.', role: 'payouts',
  parameters: {}, async read() { return 'secret'; },
};

const all = [summary, payouts];

describe('hasRole', () => {
  it('is true for a null role', () => {
    expect(hasRole([], null)).toBe(true);
  });
  it('is true when the role is held directly', () => {
    expect(hasRole(['payouts'], 'payouts')).toBe(true);
  });
  it('is true for admin and super-admin, which inherit every role', () => {
    expect(hasRole(['admin'], 'payouts')).toBe(true);
    expect(hasRole(['super-admin'], 'payouts')).toBe(true);
  });
  it('is false when the role is absent', () => {
    expect(hasRole(['media-manager'], 'payouts')).toBe(false);
  });
  it('is false for a malformed roles value rather than throwing', () => {
    expect(hasRole(undefined as never, 'payouts')).toBe(false);
    expect(hasRole(null as never, 'payouts')).toBe(false);
  });
});

describe('visibleSlices', () => {
  it('omits slices whose role the caller lacks', () => {
    expect(visibleSlices(all, ['media-manager']).map((s) => s.id)).toEqual(['summary']);
  });
  it('includes them for an admin', () => {
    expect(visibleSlices(all, ['admin']).map((s) => s.id)).toEqual(['summary', 'payouts']);
  });
});

describe('toolName', () => {
  it('converts a slice id into a valid function name', () => {
    expect(toolName('client-retention')).toBe('read_client_retention');
  });
});

describe('toolsFor', () => {
  it('never advertises a slice the caller cannot use', () => {
    const names = toolsFor(all, ['media-manager']).map((t) => t.function.name);
    expect(names).toEqual(['read_summary']);
    expect(names).not.toContain('read_payouts');
  });

  it('emits a schema the model can call', () => {
    const withParams: Slice = {
      ...summary,
      parameters: {
        month: { type: 'string', description: 'YYYY-MM', required: true },
        location: { type: 'string', description: 'Location name' },
      },
    };
    const [tool] = toolsFor([withParams], []);
    expect(tool.type).toBe('function');
    expect(tool.function.parameters).toMatchObject({
      type: 'object',
      required: ['month'],
      additionalProperties: false,
    });
    expect((tool.function.parameters as any).properties.location).toEqual({
      type: 'string', description: 'Location name',
    });
  });

  it('mentions the page in the description so answers can cite it', () => {
    const [tool] = toolsFor([summary], []);
    expect(tool.function.description).toContain('/');
    expect(tool.function.description).toContain('Overview');
  });
});

describe('the read-only guarantee', () => {
  it('exposes no verb other than read', () => {
    for (const slice of all) {
      const verbs = Object.entries(slice)
        .filter(([, v]) => typeof v === 'function')
        .map(([k]) => k);
      expect(verbs).toEqual(['read']);
    }
  });
});

describe('parameter enums', () => {
  it('emits enum into the JSON Schema so the model is constrained, not guessing', () => {
    const withEnum: Slice = {
      ...summary,
      parameters: { period: { type: 'string', description: 'Window.', enum: ['today', 'yesterday'] } },
    };
    const [tool] = toolsFor([withEnum], []);
    expect((tool.function.parameters as any).properties.period.enum).toEqual(['today', 'yesterday']);
  });

  it('omits enum entirely when a parameter is free-form', () => {
    const [tool] = toolsFor([{ ...summary, parameters: { q: { type: 'string', description: 'Free text.' } } }], []);
    expect((tool.function.parameters as any).properties.q).not.toHaveProperty('enum');
  });
});
