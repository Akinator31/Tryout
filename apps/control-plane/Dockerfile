# Build context: the repository root (the embed page, the admin UI and their tokens live
# outside this app). Both are plain files, so they are built once on the build machine for
# every platform.
FROM --platform=$BUILDPLATFORM node:24-alpine AS embed
WORKDIR /src
COPY packages/tokens packages/tokens
COPY apps/embed/package.json apps/embed/package-lock.json apps/embed/
RUN cd apps/embed && npm ci
COPY apps/embed apps/embed
RUN cd apps/embed && npm run build && npm run size

FROM --platform=$BUILDPLATFORM node:24-alpine AS admin
WORKDIR /src
COPY packages/tokens packages/tokens
COPY apps/admin/package.json apps/admin/package-lock.json apps/admin/
RUN cd apps/admin && npm ci
COPY apps/admin apps/admin
RUN cd apps/admin && npm run build && npm run size

FROM node:24-alpine
# The repository's layout under /app, so the control plane finds ../embed/dist and
# ../admin/dist as in development; /app stays the working directory, where tryout.yaml is
# looked up by default.
WORKDIR /app/apps/control-plane
ARG VERSION=dev
ENV NODE_ENV=production TRYOUT_VERSION=$VERSION
COPY apps/control-plane/package.json apps/control-plane/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/control-plane/src ./src
COPY --from=embed /src/apps/embed/dist /app/apps/embed/dist
COPY --from=admin /src/apps/admin/dist /app/apps/admin/dist
WORKDIR /app
USER node
EXPOSE 3000
CMD ["node", "apps/control-plane/src/server.ts"]
