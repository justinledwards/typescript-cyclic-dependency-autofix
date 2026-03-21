import { describe, expect, it } from 'vitest';
import { canonicalizeCyclePath, normalizeCyclePath } from './cycleNormalization.js';

describe('cycle normalization', () => {
  it('normalizes rotated closed cycles to one canonical path', () => {
    expect(canonicalizeCyclePath(['src/b.ts', 'src/c.ts', 'src/a.ts', 'src/b.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/a.ts',
    ]);
  });

  it('closes open cycles before normalizing them', () => {
    expect(canonicalizeCyclePath(['src/b.ts', 'src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts', 'src/a.ts']);
  });

  it('produces a stable normalized key', () => {
    expect(normalizeCyclePath(['src/b.ts', 'src/c.ts', 'src/a.ts', 'src/b.ts'])).toBe(
      'src/a.ts -> src/b.ts -> src/c.ts -> src/a.ts',
    );
  });
});
