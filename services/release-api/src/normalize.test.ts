import { describe, expect, it } from 'vitest';
import { normalizeRelease } from './normalize.js';
import type { GitHubRelease } from './types.js';

describe('normalizeRelease', () => {
  it('maps Apple Silicon assets, checksums, source revision, and evidence', () => {
    const release: GitHubRelease = {
      tag_name: 'v0.1.0',
      name: 'VoxelWeave Designer v0.1.0',
      target_commitish: 'abc1234',
      published_at: '2026-08-04T12:00:00Z',
      body: '- [x] Unit + integration\n- [x] Desktop E2E\n- [x] Accessibility',
      html_url: 'https://github.com/udbhavram/VoxelWeave/releases/tag/v0.1.0',
      assets: [
        {
          name: 'VoxelWeave-Designer-arm64.dmg',
          size: 284600000,
          digest: `sha256:${'a'.repeat(64)}`,
          browser_download_url: 'https://github.com/udbhavram/VoxelWeave/releases/download/v0.1.0/VoxelWeave-Designer-arm64.dmg'
        },
        {
          name: 'checksums.txt',
          size: 128,
          browser_download_url: 'https://github.com/udbhavram/VoxelWeave/releases/download/v0.1.0/checksums.txt'
        }
      ]
    };
    const view = normalizeRelease(release, 'udbhavram/VoxelWeave');
    expect(view.artifacts).toHaveLength(1);
    expect(view.artifacts[0]).toMatchObject({ architecture: 'Apple Silicon', sha256: 'a'.repeat(64), size: '284.6 MB' });
    expect(view.artifacts[0].downloadPath).toContain('/download/v0.1.0/');
    expect(view.releaseUrl).toBe('https://github.com/udbhavram/VoxelWeave/releases/tag/v0.1.0');
    expect(view.checks.find((check) => check.id === 'architecture')?.status).toBe('reported');
    expect(view.checks.find((check) => check.id === 'unit-integration')?.status).toBe('reported');
  });

  it('does not expose an arbitrary release URL', () => {
    const release: GitHubRelease = {
      tag_name: 'v0.1.0',
      assets: [{ name: 'app.dmg', size: 10, browser_download_url: 'https://example.com/app.dmg' }]
    };
    const view = normalizeRelease(release, 'udbhavram/VoxelWeave');
    expect(view.artifacts[0].url).toBeNull();
    expect(view.releaseUrl).toBeNull();
  });
});
