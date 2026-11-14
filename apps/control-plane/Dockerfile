# Build context: the repository root (the embed page and its tokens live outside this app).
# The embed is plain files, so it is built once on the build machine for every platform.
FROM --platform=$BUILDPLATFORM node:24-alpine AS embed
WORKDIR /src
COPY packages/tokens packages/tokens
COPY apps/embed/package.json apps/embed/package-lock.json apps/embed/
RUN cd apps/embed && npm ci
COPY apps/embed apps/embed
RUN cd apps/embed && npm run build && npm run size

FROM node:24-alpine
# The repository's layout under /app, so the control plane finds ../embed/dist as in
# development; /app stays the working directory, where tryout.yaml is looked up by default.
WORKDIR /app/apps/control-plane
ENV NODE_ENV=production
COPY apps/control-plane/package.json apps/control-plane/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY apps/control-plane/src ./src
COPY --from=embed /src/apps/embed/dist /app/apps/embed/dist
WORKDIR /app
USER node
EXPOSE 3000
CMD ["node", "apps/control-plane/src/server.ts"]
