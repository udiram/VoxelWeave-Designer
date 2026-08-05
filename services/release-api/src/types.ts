export type GitHubAsset = {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
  content_type?: string | null;
  updated_at?: string | null;
};

export type GitHubRelease = {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  target_commitish?: string | null;
  published_at?: string | null;
  created_at?: string | null;
  html_url?: string | null;
  assets: GitHubAsset[];
};

export type ReleaseCheckStatus = 'reported' | 'not_reported';

export type ReleaseCheck = {
  id: string;
  label: string;
  status: ReleaseCheckStatus;
  detail: string;
};

export type ReleaseArtifact = {
  name: string;
  architecture: string;
  sizeBytes: number;
  size: string;
  sha256: string | null;
  url: string | null;
  downloadPath: string;
};

export type ReleaseView = {
  tag: string;
  name: string;
  sourceRevision: string | null;
  publishedAt: string | null;
  releaseUrl: string | null;
  artifacts: ReleaseArtifact[];
  checks: ReleaseCheck[];
};
