# One image, two binaries: tryout-agent (holds the Docker socket, private API)
# and tryout-gateway (public, no socket). Run them as two separate containers.
# The build stage runs natively and cross-compiles, so multi-arch builds are fast.
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/tryout-agent ./cmd/agent \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/tryout-gateway ./cmd/gateway \
 && mkdir -p /run-tryout

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ /usr/local/bin/
# Directory for the agent<->gateway admin socket (a named volume inherits this owner).
COPY --from=build --chown=65532:65532 /run-tryout /run/tryout
USER nonroot
