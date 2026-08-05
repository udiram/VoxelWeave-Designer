import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHubClient } from './github.js';
import { readConfig, type ReleaseApiConfig } from './config.js';
import { normalizeRelease, isSafeArtifactUrl } from './normalize.js';
import type { GitHubRelease, ReleaseView } from './types.js';

export type ReleaseSource = {
  getLatest: () => Promise<GitHubRelease | null>;
  getByTag: (tag: string) => Promise<GitHubRelease | null>;
};

export type HandlerOptions = {
  config?: ReleaseApiConfig;
  client?: ReleaseSource;
  siteDistDir?: string;
};

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  response.end(payload);
};

const decodeSegment = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8'
};

const staticFileFor = (siteDistDir: string, pathname: string): string | null => {
  const decoded = decodeSegment(pathname);
  if (!decoded || decoded.includes('\0')) return null;
  const relative = decoded.replace(/^\/+/, '');
  const root = resolve(siteDistDir);
  const candidates = relative.endsWith('/') || relative === ''
    ? [join(root, relative, 'index.html')]
    : [join(root, relative), join(root, relative, 'index.html')];
  for (const candidate of candidates) {
    const resolved = resolve(normalize(candidate));
    if (!resolved.startsWith(`${root}/`) && resolved !== root) continue;
    try {
      return resolved;
    } catch {
      continue;
    }
  }
  return null;
};

const serveStatic = async (response: ServerResponse, siteDistDir: string, pathname: string): Promise<boolean> => {
  const file = staticFileFor(siteDistDir, pathname);
  if (!file) return false;
  try {
    await access(file);
    const fileStat = await stat(file);
    if (!fileStat.isFile()) return false;
    response.writeHead(200, {
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      'Content-Type': mimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': fileStat.size
    });
    createReadStream(file).pipe(response);
    return true;
  } catch {
    return false;
  }
};

const releaseResponse = (view: ReleaseView) => ({ release: view });

export const createReleaseHandler = (options: HandlerOptions = {}) => {
  const config = options.config ?? readConfig();
  const client = options.client ?? new GitHubClient({
    repo: config.repo,
    apiBaseUrl: config.githubApiUrl,
    token: config.githubToken,
    ttlMs: config.cacheTtlMs
  });
  const siteDistDir = options.siteDistDir ?? config.siteDistDir;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const method = request.method ?? 'GET';
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const pathname = requestUrl.pathname;

    if (method !== 'GET' && method !== 'HEAD') {
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }

    if (pathname === '/health') {
      json(response, 200, {
        status: 'ok',
        service: 'voxelweave-release-api',
        repository: config.repo,
        site: 'static'
      });
      return;
    }

    if (pathname === '/api/releases/latest' || pathname === '/api/releases/latest/') {
      const release = await client.getLatest();
      if (!release) {
        json(response, 200, { release: null, error: 'no_release', message: 'No public release is available yet.' });
        return;
      }
      json(response, 200, releaseResponse(normalizeRelease(release, config.repo)));
      return;
    }

    const tagMatch = pathname.match(/^\/api\/releases\/([^/]+)\/?$/);
    if (tagMatch) {
      const tag = decodeSegment(tagMatch[1]);
      if (!tag) {
        json(response, 400, { error: 'invalid_tag' });
        return;
      }
      const release = await client.getByTag(tag);
      if (!release) {
        json(response, 404, { error: 'release_not_found', message: `Release ${tag} was not found.` });
        return;
      }
      json(response, 200, releaseResponse(normalizeRelease(release, config.repo)));
      return;
    }

    const downloadMatch = pathname.match(/^\/download\/([^/]+)\/([^/]+)\/?$/);
    if (downloadMatch) {
      const tag = decodeSegment(downloadMatch[1]);
      const assetName = decodeSegment(downloadMatch[2]);
      if (!tag || !assetName) {
        json(response, 400, { error: 'invalid_download_target' });
        return;
      }
      const release = await client.getByTag(tag);
      if (!release) {
        json(response, 404, { error: 'release_not_found' });
        return;
      }
      const view = normalizeRelease(release, config.repo);
      const artifact = view.artifacts.find((candidate) => candidate.name === assetName);
      if (!artifact || !artifact.url || !isSafeArtifactUrl(artifact.url, config.repo)) {
        json(response, 404, { error: 'asset_not_found' });
        return;
      }
      response.writeHead(302, { Location: artifact.url, 'Cache-Control': 'no-store' });
      response.end();
      return;
    }

    if (await serveStatic(response, siteDistDir, pathname)) return;
    if (pathname.startsWith('/api/')) {
      json(response, 404, { error: 'not_found' });
      return;
    }
    json(response, 404, { error: 'not_found', message: 'The requested VoxelWeave page was not found.' });
  };
};

export const createReleaseServer = (options: HandlerOptions = {}) => {
  const config = options.config ?? readConfig();
  const handler = createReleaseHandler({ ...options, config });
  return createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unexpected release service error';
      if (!response.headersSent) json(response, 502, { error: 'upstream_error', message });
      else response.destroy();
    });
  });
};

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  const config = readConfig();
  const server = createReleaseServer({ config });
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`VoxelWeave release service listening on ${config.port}`);
  });
}
