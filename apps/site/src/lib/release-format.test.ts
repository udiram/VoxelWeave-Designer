import { describe, expect, it } from 'vitest';
import { formatBytes, normalizeSha256 } from './release-format';

describe('release display helpers', () => {
  it('formats release sizes without inventing precision', () => {
    expect(formatBytes(284_600_000)).toBe('284.6 MB');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('accepts only complete SHA-256 values', () => {
    expect(normalizeSha256(`sha256:${'A'.repeat(64)}`)).toBe('a'.repeat(64));
    expect(normalizeSha256('not-a-checksum')).toBeNull();
  });
});
