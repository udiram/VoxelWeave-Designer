import type { GitHubAsset, GitHubRelease, ReleaseArtifact, ReleaseCheck, ReleaseView } from './types.js';

const sha256Pattern = /\b[a-f0-9]{64}\b/i;

const formatSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const megabytes = bytes / 1_000_000;
  if (megabytes >= 1000) return `${(megabytes / 1000).toFixed(2)} GB`;
  if (megabytes >= 100) return `${megabytes.toFixed(1)} MB`;
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
};

const sha256For = (asset: GitHubAsset): string | null => {
  const digest = asset.digest?.replace(/^sha256:/i, '').trim();
  if (digest && sha256Pattern.test(digest)) return digest.toLowerCase();
  const fromName = asset.name.match(sha256Pattern)?.[0];
  return fromName?.toLowerCase() ?? null;
};

const isChecksumAsset = (name: string): boolean => /(?:sha-?256|checksum|checksums|\.sha256(?:sum)?$)/i.test(name);

const architectureFor = (name: string): string => {
  const normalized = name.toLowerCase();
  if (/source|\.tar\.gz$|\.tar\.bz2$/.test(normalized) && !/arm64|aarch64|apple.?silicon/.test(normalized)) return 'Source';
  if (/arm64|aarch64|apple[ _-]?silicon/.test(normalized)) return 'Apple Silicon';
  if (/x86_64|amd64|intel/.test(normalized)) return 'Intel';
  if (/windows|win32/.test(normalized)) return 'Windows';
  if (/linux/.test(normalized)) return 'Linux';
  if (/\.dmg$|\.app\.zip$|\.zip$/.test(normalized)) return 'Apple Silicon';
  return 'Unspecified';
};

const isArtifact = (asset: GitHubAsset): boolean => {
  if (isChecksumAsset(asset.name)) return false;
  if (/\.(asc|sig|pem)$/i.test(asset.name)) return false;
  return true;
};

const verifiedDownloadUrl = (url: string | undefined | null, repo: string): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
    if (!parsed.pathname.startsWith(`/${repo}/releases/download/`)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const verifiedReleaseUrl = (url: string | undefined | null, repo: string): string | null => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return null;
    if (!parsed.pathname.startsWith(`/${repo}/releases/tag/`)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

const sourceRevisionFor = (release: GitHubRelease): string | null => {
  const bodyMatch = release.body?.match(/source\s+revision\s*[:=]\s*`?([a-f0-9]{7,40})`?/i);
  return bodyMatch?.[1] ?? release.target_commitish ?? null;
};

const reportedByBody = (body: string, patterns: RegExp[]): boolean => {
  return patterns.some((pattern) => pattern.test(body));
};

const buildChecks = (release: GitHubRelease, artifacts: ReleaseArtifact[]): ReleaseCheck[] => {
  const body = release.body ?? '';
  const reported = (id: string, label: string, patterns: RegExp[], fallback: boolean, detail: string): ReleaseCheck => ({
    id,
    label,
    status: reportedByBody(body, patterns) || fallback ? 'reported' : 'not_reported',
    detail: reportedByBody(body, patterns) || fallback ? detail : 'Not reported in release metadata'
  });
  return [
    reported('unit-integration', 'Unit + integration', [/\[x\].*(unit|integration)/i, /unit\s*\+\s*integration.*(pass|green|complete)/i], false, 'Reported in release notes'),
    reported('desktop-e2e', 'Desktop E2E', [/\[x\].*(desktop|e2e)/i, /desktop.*e2e.*(pass|green|complete)/i], false, 'Reported in release notes'),
    reported('accessibility', 'Accessibility', [/\[x\].*accessib/i, /accessib.*(pass|green|complete)/i], false, 'Reported in release notes'),
    reported('architecture', 'Architecture', [/\[x\].*architect/i, /architecture.*(apple silicon|arm64|pass|green|complete)/i], artifacts.some((artifact) => artifact.architecture === 'Apple Silicon'), 'Apple Silicon artifact is present'),
    reported('release-checksum', 'Release checksum', [/\[x\].*(checksum|sha-?256)/i, /checksum.*(pass|published|included)/i], artifacts.some((artifact) => Boolean(artifact.sha256)), 'SHA-256 is present for at least one artifact')
  ];
};

export const normalizeRelease = (release: GitHubRelease, repo: string): ReleaseView => {
  const tag = release.tag_name;
  const artifacts = release.assets.filter(isArtifact).map<ReleaseArtifact>((asset) => {
    const url = verifiedDownloadUrl(asset.browser_download_url, repo);
    return {
      name: asset.name,
      architecture: architectureFor(asset.name),
      sizeBytes: asset.size,
      size: formatSize(asset.size),
      sha256: sha256For(asset),
      url,
      downloadPath: `/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`
    };
  });
  return {
    tag,
    name: release.name ?? tag,
    sourceRevision: sourceRevisionFor(release),
    publishedAt: release.published_at ?? release.created_at ?? null,
    releaseUrl: verifiedReleaseUrl(release.html_url, repo),
    artifacts,
    checks: buildChecks(release, artifacts)
  };
};

export const isSafeArtifactUrl = (url: string | null, repo: string): boolean => Boolean(verifiedDownloadUrl(url, repo));
