# Example "CLI project" image. Contract with Tryout:
#  - listen HTTP on the port declared in the project config (here 7681)
#  - serve under $TRYOUT_BASE_PATH (ttyd: -b), or set strip_prefix: true
#  - work with a read-only root filesystem (HOME=/tmp is writable)
FROM debian:bookworm-slim
ARG TARGETARCH
ARG TTYD_VERSION=1.7.7
# Checksums from the release's SHA256SUMS; update them with TTYD_VERSION.
ADD --chmod=0755 --checksum=sha256:8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 \
    https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 /tmp/ttyd.amd64
ADD --chmod=0755 --checksum=sha256:b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 \
    https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.aarch64 /tmp/ttyd.arm64
RUN mv /tmp/ttyd.${TARGETARCH} /usr/local/bin/ttyd && rm -f /tmp/ttyd.* \
 && useradd -u 1000 -m -s /bin/bash visitor
COPY hello.sh /usr/local/bin/hello
COPY entrypoint.sh /entrypoint.sh
USER 1000:1000
EXPOSE 7681
ENTRYPOINT ["/entrypoint.sh"]
