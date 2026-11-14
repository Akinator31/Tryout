# One image, three binaries: tryout-agent (holds the Docker socket, private API),
# tryout-gateway (public, no socket), run as two separate containers, and
# tryout-certs, a one-shot tool that creates the mutual TLS certificates.
# The build stage runs natively and cross-compiles, so multi-arch builds are fast.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS TARGETARCH
# Release version reported by /healthz, /metrics and the logs; CI passes the image tag.
ARG VERSION=dev
WORKDIR /src
COPY go.mod ./
COPY . .
RUN export CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
 LDFLAGS="-s -w -X github.com/Akinator31/Tryout/apps/node/internal/version.Version=$VERSION" \
 && go build -trimpath -ldflags="$LDFLAGS" -o /out/tryout-agent ./cmd/agent \
 && go build -trimpath -ldflags="$LDFLAGS" -o /out/tryout-gateway ./cmd/gateway \
 && go build -trimpath -ldflags="$LDFLAGS" -o /out/tryout-certs ./cmd/certs \
 && mkdir -p /run-tryout

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ /usr/local/bin/
# Directory for the agent<->gateway admin socket (a named volume inherits this owner).
COPY --from=build --chown=65532:65532 /run-tryout /run/tryout
USER nonroot
