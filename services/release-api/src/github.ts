import type { GitHubRelease } from './types.js';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type CachedValue = {
  value: GitHubRelease | null;
  expiresAt: number;
  etag?: string;
};

export class GitHubApiError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(status: number, endpoint: string) {
    super(`GitHub API request failed with ${status} for ${endpoint}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

export type GitHubClientOptions = {
  repo: string;
  apiBaseUrl: string;
  token?: string;
  ttlMs: number;
  fetchImpl?: FetchLike;
};

export class GitHubClient {
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly token?: string;
  private readonly ttlMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<string, CachedValue>();

  constructor(options: GitHubClientOptions) {
    this.repo = options.repo;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.ttlMs = options.ttlMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getLatest(): Promise<GitHubRelease | null> {
    return this.getRelease('/releases/latest');
  }

  getByTag(tag: string): Promise<GitHubRelease | null> {
    return this.getRelease(`/releases/tags/${encodeURIComponent(tag)}`);
  }

  private async getRelease(path: string): Promise<GitHubRelease | null> {
    const endpoint = `/repos/${this.repo}${path}`;
    const now = Date.now();
    const cached = this.cache.get(endpoint);
    if (cached && cached.expiresAt > now) return cached.value;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'VoxelWeave-Release-Service/0.1'
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (cached?.etag) headers['If-None-Match'] = cached.etag;

    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}${endpoint}`, { headers });
      if (response.status === 304 && cached) {
        cached.expiresAt = now + this.ttlMs;
        return cached.value;
      }
      if (response.status === 404) {
        this.cache.set(endpoint, { value: null, expiresAt: now + this.ttlMs });
        return null;
      }
      if (!response.ok) throw new GitHubApiError(response.status, endpoint);
      const value = await response.json() as GitHubRelease;
      if (!value || typeof value.tag_name !== 'string' || !Array.isArray(value.assets)) {
        throw new Error(`GitHub API response for ${endpoint} was not a release`);
      }
      this.cache.set(endpoint, {
        value,
        expiresAt: now + this.ttlMs,
        etag: response.headers.get('etag') ?? undefined
      });
      return value;
    } catch (error) {
      if (cached) return cached.value;
      throw error;
    }
  }
}
