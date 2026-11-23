import { describe, it, expect } from 'vitest';
import * as format from '../src/text/format';
describe('truncate', () => {
  it('shortens text longer than max to max characters ending in an ellipsis', () => {
    const truncate = (format as { truncate?: (text: string, max: number) => string }).truncate;
    expect(truncate?.('hello world', 5)).toBe('hell…');
    expect(truncate?.('hi', 5)).toBe('hi');
  });
  it('keeps text of exactly max characters', () => {
    const truncate = (format as { truncate?: (text: string, max: number) => string }).truncate;
    expect(truncate?.('hello', 5)).toBe('hello');
  });
});
