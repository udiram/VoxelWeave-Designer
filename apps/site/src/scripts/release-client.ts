type ReleaseArtifact = {
  name?: string;
  artifact?: string;
  architecture?: string;
  size?: string;
  sizeBytes?: number;
  sha256?: string | null;
  url?: string | null;
  downloadPath?: string | null;
};

type ReleaseCheck = {
  id?: string;
  label?: string;
  status?: string;
  detail?: string;
};

type Release = {
  tag?: string;
  tagName?: string;
  name?: string;
  sourceRevision?: string | null;
  publishedAt?: string | null;
  artifacts?: ReleaseArtifact[];
  checks?: ReleaseCheck[];
};

type ReleasePayload = Release & { release?: Release | null };

const query = <T extends Element>(selector: string): T | null => document.querySelector(selector) as T | null;
const queryAll = <T extends Element>(selector: string): T[] => Array.from(document.querySelectorAll(selector)) as T[];

const loading = query<HTMLElement>('[data-release-loading]');
const empty = query<HTMLElement>('[data-release-empty]');
const error = query<HTMLElement>('[data-release-error]');
const table = query<HTMLElement>('[data-release-table]');
const rows = query<HTMLTableSectionElement>('[data-release-rows]');
const tag = query<HTMLElement>('[data-release-tag]');
const sourceRevision = query<HTMLElement>('[data-source-revision]');
const publishedAt = query<HTMLTimeElement>('[data-published-at]');

const setHidden = (element: HTMLElement | null, hidden: boolean) => {
  if (element) element.hidden = hidden;
};

const setState = (state: 'loading' | 'empty' | 'error' | 'release') => {
  setHidden(loading, state !== 'loading');
  setHidden(empty, state !== 'empty');
  setHidden(error, state !== 'error');
  setHidden(table, state !== 'release');
};

const verifiedHref = (candidate: string | null | undefined): string | null => {
  if (!candidate) return null;
  try {
    const url = new URL(candidate, window.location.origin);
    if (url.origin === window.location.origin && url.pathname.startsWith('/download/')) return `${url.pathname}${url.search}${url.hash}`;
    if (url.protocol !== 'https:') return null;
    if (url.hostname === 'github.com' && url.pathname.includes('/releases/download/')) return url.toString();
    if (url.hostname === 'objects.githubusercontent.com') return url.toString();
  } catch {
    return null;
  }
  return null;
};

const formatSize = (artifact: ReleaseArtifact): string => {
  if (artifact.size) return artifact.size;
  if (typeof artifact.sizeBytes !== 'number' || !Number.isFinite(artifact.sizeBytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = artifact.sizeBytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatDate = (value: string | null | undefined): string => {
  if (!value) return 'Not reported';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
};

const createCell = (text: string, className?: string): HTMLTableCellElement => {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
};

const renderArtifactRows = (artifacts: ReleaseArtifact[]) => {
  if (!rows) return;
  rows.replaceChildren();
  for (const artifact of artifacts) {
    const row = document.createElement('tr');
    const name = artifact.name ?? artifact.artifact ?? 'Unnamed artifact';
    const artifactCell = createCell(name, 'release-artifact-name');
    const architectureCell = createCell(artifact.architecture ?? 'Unspecified');
    const sizeCell = createCell(formatSize(artifact));
    const checksumCell = document.createElement('td');
    checksumCell.className = 'checksum-cell';
    const checksum = artifact.sha256?.replace(/^sha256:/i, '') ?? '';
    const checksumText = document.createElement('code');
    checksumText.textContent = checksum || 'Not reported';
    if (checksum) checksumText.title = checksum;
    checksumCell.append(checksumText);
    if (checksum) {
      const copyButton = document.createElement('button');
      copyButton.className = 'copy-button';
      copyButton.type = 'button';
      copyButton.dataset.copySha = checksum;
      copyButton.setAttribute('aria-label', `Copy SHA-256 for ${name}`);
      copyButton.title = 'Copy SHA-256';
      copyButton.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="10" height="11" rx="1.5"/><path d="M6 15H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 3h8.5A1.5 1.5 0 0 1 15 4.5V6"/></svg>';
      checksumCell.append(copyButton);
    }
    const downloadCell = document.createElement('td');
    const href = verifiedHref(artifact.downloadPath) ?? verifiedHref(artifact.url);
    if (href) {
      const link = document.createElement('a');
      link.className = 'release-download';
      link.setAttribute('href', href);
      link.target = href.startsWith('/') || href.startsWith(window.location.origin) ? '_self' : '_blank';
      if (link.target === '_blank') link.rel = 'noreferrer';
      link.textContent = 'Download';
      link.setAttribute('aria-label', `Download ${name}`);
      downloadCell.append(link);
    } else {
      downloadCell.textContent = 'Unavailable';
    }
    row.append(artifactCell, architectureCell, sizeCell, checksumCell, downloadCell);
    rows.append(row);
  }
};

const updateEvidence = (release: Release | null) => {
  const checks = new Map((release?.checks ?? []).map((check) => [check.id ?? '', check]));
  for (const item of queryAll<HTMLElement>('[data-check-id]')) {
    const check = checks.get(item.dataset.checkId ?? '');
    const detail = item.querySelector<HTMLElement>('[data-check-detail]');
    const reported = check?.status === 'reported' || check?.status === 'pass' || check?.status === 'available';
    item.dataset.status = reported ? 'reported' : release ? 'not-reported' : 'not-published';
    if (detail) detail.textContent = reported ? (check?.detail ?? 'Reported in release') : release ? (check?.detail ?? 'Not reported') : 'Not published';
  }
};

const updateDownloadCtas = (release: Release | null) => {
  const appleArtifact = release?.artifacts?.find((artifact) => (artifact.architecture ?? '').toLowerCase().includes('apple silicon'));
  const href = appleArtifact ? verifiedHref(appleArtifact.downloadPath) ?? verifiedHref(appleArtifact.url) : null;
  for (const cta of queryAll<HTMLAnchorElement>('[data-download-cta]')) {
    const releaseCta = cta.hasAttribute('data-release-download-cta');
    const label = cta.querySelector<HTMLElement>('[data-download-label]');
    if (href) {
      cta.href = href;
      if (label) label.textContent = releaseCta ? 'Download VoxelWeave Designer' : 'Download for Apple Silicon';
      cta.setAttribute('aria-label', 'Download the current Apple Silicon release');
    } else if (releaseCta) {
      cta.href = cta.dataset.sourceUrl ?? '#evidence';
      if (label) label.textContent = 'View source on GitHub';
      cta.setAttribute('aria-label', 'View the GitHub source until an Apple Silicon release is published');
    } else {
      cta.href = '#evidence';
      cta.setAttribute('aria-label', 'View Apple Silicon release availability');
    }
  }
};

const copyChecksum = async (button: HTMLButtonElement) => {
  const value = button.dataset.copySha;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    button.setAttribute('aria-label', 'SHA-256 copied');
    button.title = 'Copied';
  } catch {
    button.setAttribute('aria-label', 'SHA-256 could not be copied automatically');
    button.title = 'Copy unavailable';
  }
};

const renderRelease = (release: Release) => {
  const artifacts = Array.isArray(release.artifacts) ? release.artifacts : [];
  if (artifacts.length === 0) {
    setState('empty');
    updateEvidence(release);
    updateDownloadCtas(null);
    return;
  }
  setState('release');
  if (tag) tag.textContent = release.tag ?? release.tagName ?? '';
  if (sourceRevision) sourceRevision.textContent = release.sourceRevision ?? 'Not reported';
  if (publishedAt) {
    const value = release.publishedAt ?? '';
    publishedAt.textContent = formatDate(value);
    if (value) publishedAt.dateTime = value;
  }
  renderArtifactRows(artifacts);
  updateEvidence(release);
  updateDownloadCtas(release);
};

const loadRelease = async () => {
  setState('loading');
  try {
    const response = await fetch('/api/releases/latest', { headers: { accept: 'application/json' } });
    if (response.status === 404) {
      setState('empty');
      updateEvidence(null);
      updateDownloadCtas(null);
      return;
    }
    if (!response.ok) throw new Error(`release service returned ${response.status}`);
    const payload = await response.json() as ReleasePayload;
    const release = Object.prototype.hasOwnProperty.call(payload, 'release') ? payload.release : payload;
    if (!release) {
      setState('empty');
      updateEvidence(null);
      updateDownloadCtas(null);
      return;
    }
    if (typeof release !== 'object') throw new Error('release response did not contain release metadata');
    renderRelease(release);
  } catch {
    setState('error');
    updateEvidence(null);
    updateDownloadCtas(null);
  }
};

rows?.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('[data-copy-sha]');
  if (button) void copyChecksum(button);
});

void loadRelease();
