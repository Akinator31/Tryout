# Example "CLI project" image. Contract with Tryout, for a terminal served by the agent's
# ttyd (the default):
#  - the image's entrypoint and command are the program the visitor gets; the agent
#    mounts ttyd and runs that program in it, so the image needs no web server
#  - work with a read-only root filesystem (HOME=/tmp is writable)
FROM debian:trixie-slim
RUN useradd -u 1000 -m -s /bin/bash visitor
COPY hello.sh /usr/local/bin/hello
USER 1000:1000
CMD ["bash", "-c", "hello; exec bash -l"]
