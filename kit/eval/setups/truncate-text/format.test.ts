import { describe, it, expect } from 'vitest';
import { slugify } from '../src/text/format';
describe('slugify', () => {
  it('lowercases and joins words with dashes', () => {
    expect(slugify('  Hello, World ')).toBe('hello-world');
  });
});
