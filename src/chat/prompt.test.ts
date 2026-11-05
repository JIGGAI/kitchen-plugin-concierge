import { describe, expect, it } from 'vitest';
import { systemPrompt } from './prompt';

describe('systemPrompt source authority', () => {
  it('forbids inferred attendance and absence statuses from overriding YOT-derived reads', () => {
    const prompt = systemPrompt('Test persona.', []);

    expect(prompt).toContain('Treat YOT-derived read results as authoritative');
    expect(prompt).toContain('Never replace or reinterpret an explicit YOT status');
    expect(prompt).toContain('No roster row, no appointments, a staffing shortage, or a');
    expect(prompt).toContain('closed shop does not imply an absence reason');
    expect(prompt).toContain('instead of resolving it by speculation');
  });
});
