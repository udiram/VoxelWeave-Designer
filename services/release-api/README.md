# VoxelWeave release service

The release service serves the static Astro build and exposes the current GitHub release without putting a GitHub token in the browser.

## Endpoints

- `GET /health` — service health and configured repository.
- `GET /api/releases/latest` — normalized latest release metadata, or `200` with `release: null` and `error: "no_release"` before the first public release.
- `GET /api/releases/:tag` — normalized release metadata for an exact tag.
- `GET /download/:tag/:asset` — same-origin redirect to an asset URL verified against the configured GitHub repository.

## Configuration

- `GITHUB_REPOSITORY` or `VOXELWEAVE_GITHUB_REPO` — `owner/name`, default `udiram/VoxelWeave`.
- `GITHUB_TOKEN` — optional server-only GitHub token for higher API limits; never exposed to the site.
- `GITHUB_API_URL` — optional API base URL for GitHub-compatible testing, default `https://api.github.com`.
- `GITHUB_CACHE_TTL_SECONDS` — in-memory cache TTL, default `60`.
- `SITE_DIST_DIR` — built Astro directory, default `apps/site/dist` relative to the service process.
- `PORT` — HTTP port, default `3000`.

GitHub release asset URLs are allowlisted to the configured repository's `/releases/download/` path. Arbitrary redirect targets are rejected.
