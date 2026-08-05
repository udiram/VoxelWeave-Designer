import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './github.js';

const release = {
  tag_name: 'v0.1.0',
  assets: []
};

describe('GitHubClient', () => {
  it('uses the TTL/ETag cache for repeated release reads', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(release), {
      status: 200,
      headers: { etag: '"release-1"', 'content-type': 'application/json' }
    }));
    const client = new GitHubClient({
      repo: 'udiram/VoxelWeave',
      apiBaseUrl: 'https://api.github.com',
      ttlMs: 60_000,
      fetchImpl
    });
    await client.getLatest();
    await client.getLatest();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/udiram/VoxelWeave/releases/latest', expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/vnd.github+json' }) }));
  });

  it('returns null for a GitHub 404 release', async () => {
    const client = new GitHubClient({
      repo: 'udiram/VoxelWeave',
      apiBaseUrl: 'https://api.github.com',
      ttlMs: 60_000,
      fetchImpl: async () => new Response('{}', { status: 404 })
    });
    await expect(client.getLatest()).resolves.toBeNull();
  });
});
