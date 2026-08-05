export type ReleaseApiConfig = {
  repo: string;
  githubApiUrl: string;
  githubToken?: string;
  cacheTtlMs: number;
  siteDistDir: string;
  port: number;
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const normalizeRepo = (value: string | undefined): string => {
  const repo = value?.trim() || 'udiram/VoxelWeave-Designer';
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY must be in owner/name form');
  return repo;
};

export const readConfig = (env: NodeJS.ProcessEnv = process.env): ReleaseApiConfig => ({
  repo: normalizeRepo(env.GITHUB_REPOSITORY ?? env.VOXELWEAVE_GITHUB_REPO),
  githubApiUrl: (env.GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/$/, ''),
  githubToken: env.GITHUB_TOKEN?.trim() || undefined,
  cacheTtlMs: parsePositiveInteger(env.GITHUB_CACHE_TTL_SECONDS, 60) * 1000,
  siteDistDir: env.SITE_DIST_DIR?.trim() || `${process.cwd()}/apps/site/dist`,
  port: parsePositiveInteger(env.PORT, 3000)
});
