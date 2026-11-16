# tryout-ttyd: the web terminal the agent mounts, read-only, into terminal sessions
# (Docker image mount at /opt/tryout). It holds a single static binary, /ttyd, so project
# images need no web server of their own. Tags follow ttyd's version.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS fetch
ARG TARGETARCH
ARG TTYD_VERSION=1.7.7
# Checksums from the release's SHA256SUMS; update them with TTYD_VERSION.
ADD --chmod=0755 --checksum=sha256:8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 \
    https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 /tmp/ttyd.amd64
ADD --chmod=0755 --checksum=sha256:b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 \
    https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.aarch64 /tmp/ttyd.arm64
RUN mv /tmp/ttyd.${TARGETARCH} /ttyd

FROM scratch
COPY --from=fetch /ttyd /ttyd
