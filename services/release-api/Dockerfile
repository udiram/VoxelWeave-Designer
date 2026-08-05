FROM node:22-alpine AS site-build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY apps/site/package.json apps/site/pnpm-lock.yaml apps/site/pnpm-workspace.yaml ./apps/site/
RUN pnpm --dir apps/site install --frozen-lockfile
COPY apps/site ./apps/site
RUN pnpm --dir apps/site build

FROM node:22-alpine AS api-build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
COPY services/release-api/package.json services/release-api/pnpm-lock.yaml services/release-api/pnpm-workspace.yaml ./services/release-api/
RUN pnpm --dir services/release-api install --frozen-lockfile
COPY services/release-api ./services/release-api
RUN pnpm --dir services/release-api build

FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/udiram/VoxelWeave-Designer"
LABEL org.opencontainers.image.description="VoxelWeave Designer public site and release API"

WORKDIR /app
ENV NODE_ENV=production
ENV SITE_DIST_DIR=/app/apps/site/dist
COPY --from=api-build /app/services/release-api/package.json ./services/release-api/package.json
COPY --from=api-build /app/services/release-api/node_modules ./services/release-api/node_modules
COPY --from=api-build /app/services/release-api/dist ./services/release-api/dist
COPY --from=site-build /app/apps/site/dist ./apps/site/dist

EXPOSE 3000
CMD ["node", "services/release-api/dist/server.js"]
