import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseHandler } from './server.js';
import type { GitHubRelease } from './types.js';

const servers: Server[] = [];

const request = async (handler: ReturnType<typeof createReleaseHandler>, path: string): Promise<Response> => {
  const server = createServer((req, res) => void handler(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return fetch(`http://127.0.0.1:${address.port}${path}`, { redirect: 'manual' });
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const release: GitHubRelease = {
  tag_name: 'v0.1.0',
  assets: [{
    name: 'VoxelWeave-Designer-arm64.dmg',
    size: 100,
    digest: `sha256:${'b'.repeat(64)}`,
    browser_download_url: 'https://github.com/udiram/VoxelWeave/releases/download/v0.1.0/VoxelWeave-Designer-arm64.dmg'
  }]
};

describe('release HTTP handler', () => {
  it('reports health without contacting GitHub', async () => {
    const response = await request(createReleaseHandler({
      client: { getLatest: async () => { throw new Error('should not fetch'); }, getByTag: async () => null },
      siteDistDir: '/path/that/does/not/exist'
    }), '/health');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', service: 'voxelweave-release-api' });
  });

  it('returns an honest no-release response', async () => {
    const response = await request(createReleaseHandler({
      client: { getLatest: async () => null, getByTag: async () => null },
      siteDistDir: '/path/that/does/not/exist'
    }), '/api/releases/latest');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ error: 'no_release', release: null });
  });

  it('redirects only verified release assets and rejects unknown assets', async () => {
    const handler = createReleaseHandler({
      client: { getLatest: async () => release, getByTag: async () => release },
      siteDistDir: '/path/that/does/not/exist'
    });
    const redirect = await request(handler, '/download/v0.1.0/VoxelWeave-Designer-arm64.dmg');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(release.assets[0].browser_download_url);
    const unknown = await request(handler, '/download/v0.1.0/not-a-release.dmg');
    expect(unknown.status).toBe(404);
  });
});
