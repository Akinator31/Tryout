# Example "CLI project" image. Contract with Tryout:
#  - listen HTTP on the port declared in the project config (here 7681)
#  - serve under $TRYOUT_BASE_PATH (ttyd: -b), or set strip_prefix: true
#  - work with a read-only root filesystem (HOME=/tmp is writable)
FROM debian:bookworm-slim
ARG TARGETARCH
ARG TTYD_VERSION=1.7.7
ADD --chmod=0755 https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 /tmp/ttyd.amd64
ADD --chmod=0755 https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.aarch64 /tmp/ttyd.arm64
RUN mv /tmp/ttyd.${TARGETARCH} /usr/local/bin/ttyd && rm -f /tmp/ttyd.* \
 && useradd -u 1000 -m -s /bin/bash visitor
COPY hello.sh /usr/local/bin/hello
COPY entrypoint.sh /entrypoint.sh
USER 1000:1000
EXPOSE 7681
ENTRYPOINT ["/entrypoint.sh"]
