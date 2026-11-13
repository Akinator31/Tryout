#!/usr/bin/env bash
# End-to-end test of the production layout (docs/deployment.md): deploy/node and
# deploy/control-plane, run as two separate compose projects that only reach each
# other through published ports, with certificates made by tryout-certs as the guide
# does it. Then runs the terminal, queue, SSE and mutual TLS end-to-end tests against it, and
# recreates the node (agent and gateway) during a session, as an upgrade does.
#
# Usage: scripts/e2e-deploy.sh            (from the repository root)
#
# Environment:
#   TRYOUT_NODE_IMAGE, TRYOUT_CONTROL_PLANE_IMAGE, TRYOUT_VERSION
#                   images to test (default: build them locally as tryout-*:e2e)
#   PROJECT_IMAGE   sample project image (default: build examples/cli-hello)
#   NODE_PROFILE    default strict (requires gVisor); dev on a machine without it
#   HOST_ADDR       address of this machine as the containers reach it; also the agent
#                   certificate's name (default: first address of `hostname -I`;
#                   host.docker.internal with Docker Desktop)
#   BIND_ADDR       address the services are published on (default: HOST_ADDR;
#                   127.0.0.1 with Docker Desktop)
#   CHOWN_CMD       command that gives a directory to a uid (default: sudo chown -R;
#                   ":" where bind mounts ignore ownership, as with Docker Desktop)
#   KEEP=1          leave the stack running
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$root/.cache"
work=$(mktemp -d -p "$root/.cache" e2e-deploy.XXXXXX)
host_addr=${HOST_ADDR:-$(hostname -I | awk '{print $1}')}
bind_addr=${BIND_ADDR:-$host_addr}
chown_cmd=${CHOWN_CMD:-sudo chown -R}
profile=${NODE_PROFILE:-strict}

if [ -z "${TRYOUT_VERSION:-}" ]; then
  docker build -q -t tryout-node:e2e "$root/apps/node" >/dev/null
  docker build -q -t tryout-control-plane:e2e "$root/apps/control-plane" >/dev/null
  export TRYOUT_NODE_IMAGE=tryout-node TRYOUT_CONTROL_PLANE_IMAGE=tryout-control-plane TRYOUT_VERSION=e2e
fi
node_image="${TRYOUT_NODE_IMAGE:-ghcr.io/akinator31/tryout-node}:$TRYOUT_VERSION"
cp_image="${TRYOUT_CONTROL_PLANE_IMAGE:-ghcr.io/akinator31/tryout-control-plane}:$TRYOUT_VERSION"
project_image=${PROJECT_IMAGE:-}
if [ -z "$project_image" ]; then
  project_image=tryout-example/cli-hello:e2e
  docker build -q -t "$project_image" "$root/examples/cli-hello" >/dev/null
fi

# write_env <dir> <image variable> <sed args...>: .env from .env.example, with the
# image under test.
write_env() {
  local dir=$1 image_var=$2
  shift 2
  {
    sed "$@" -e "/^TRYOUT_VERSION=/d" "$work/$dir/.env.example"
    echo "TRYOUT_VERSION=$TRYOUT_VERSION"
    if [ -n "${!image_var:-}" ]; then echo "$image_var=${!image_var}"; fi
  } >"$work/$dir/.env"
}
compose() { docker compose --project-directory "$work/$1" -f "$work/$1/compose.yaml" "${@:2}"; }
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    compose node logs --no-color || true
    compose control-plane logs --no-color || true
  fi
  if [ "${KEEP:-}" != 1 ]; then
    compose control-plane down -v >/dev/null 2>&1 || true
    compose node down -v >/dev/null 2>&1 || true
    # Files written by other uids: remove them from a container.
    docker run --rm -u 0 -v "$work:/w" --entrypoint rm "$cp_image" -rf /w/node /w/control-plane /w/pki >/dev/null 2>&1 || true
    rm -rf "$work" || true
  else
    echo "stack kept; files in $work"
  fi
  exit "$status"
}
trap cleanup EXIT

# 1. Copy the example directories, as an operator would.
cp -r "$root/deploy/node" "$root/deploy/control-plane" "$work/"

# 2. Certificates, on "the operator's machine" (docs/certificates.md).
certs() { docker run --rm -u "$(id -u):$(id -g)" -v "$work/pki:/pki" "$node_image" tryout-certs "$@" --dir /pki; }
mkdir -p "$work/pki"
certs init >/dev/null
certs node cli --san "$host_addr" >/dev/null
cp -r "$work/pki/nodes/cli" "$work/node/pki"
cp -r "$work/pki/control-plane" "$work/control-plane/pki"
$chown_cmd 65532:65532 "$work/node/pki"
$chown_cmd 1000:1000 "$work/control-plane/pki"

# 3. Node.
docker_sock=${DOCKER_SOCKET:-/var/run/docker.sock}
write_env node TRYOUT_NODE_IMAGE \
  -e "s|^NODE_PROFILE=.*|NODE_PROFILE=$profile|" \
  -e "s|^DOCKER_SOCKET=.*|DOCKER_SOCKET=$docker_sock|" \
  -e "s|^DOCKER_GID=.*|DOCKER_GID=${DOCKER_GID:-$(stat -c %g "$docker_sock")}|" \
  -e "s|^GATEWAY_TOKEN=.*|GATEWAY_TOKEN=$(openssl rand -hex 32)|" \
  -e "s|^AGENT_PUBLISH=.*|AGENT_PUBLISH=$bind_addr:7000|" \
  -e "s|^GATEWAY_PUBLISH=.*|GATEWAY_PUBLISH=$bind_addr:8080|" \
  -e "s|^FRAME_ANCESTORS=.*|FRAME_ANCESTORS=http://$bind_addr:3000|"
compose node up -d --quiet-pull

# 4. Control plane: the operator writes their own tryout.yaml from the example.
write_env control-plane TRYOUT_CONTROL_PLANE_IMAGE \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 32)|" \
  -e "s|^CONTROL_PLANE_PUBLISH=.*|CONTROL_PLANE_PUBLISH=$bind_addr:3000|"
cat >"$work/control-plane/tryout.yaml" <<EOF
listen: ":3000"
embed_frame_ancestors: ["http://$bind_addr:3000"]
agent_tls: { ca: pki/ca.crt, cert: pki/tls.crt, key: pki/tls.key }
nodes:
  cli:
    agent_url: https://$host_addr:7000
    public_url: http://$bind_addr:8080/s/{session}/
    probe_url: http://$host_addr:8080/s/{session}/
    max_sessions: 4
projects:
  cli-hello:
    node: cli
    image: $project_image
    kind: terminal
    port: 7681
    max_sessions: 2
    max_age: 10m
EOF
compose control-plane up -d --quiet-pull

# 5. Wait, then test through the published ports only.
for _ in $(seq 90); do
  curl -fs "http://$bind_addr:3000/healthz" >/dev/null && curl -fs "http://$bind_addr:8080/healthz" >/dev/null && break
  sleep 1
done
curl -fsS "http://$bind_addr:3000/healthz" >/dev/null
curl -fsS "http://$bind_addr:8080/healthz" >/dev/null

cp_url="http://$bind_addr:3000"
node "$root/scripts/e2e-cli.ts" "$cp_url" cli-hello
node "$root/scripts/e2e-queue.ts" "$cp_url"
node "$root/scripts/e2e-sse.ts" "$cp_url" cli-hello
# The agent's published port, from outside both stacks, with the operator's certificates;
# the agent's certificate names HOST_ADDR, which may differ from BIND_ADDR (Docker Desktop).
node "$root/scripts/e2e-mtls.ts" "$bind_addr:7000" --pki "$work/pki" --node cli --server-name "$host_addr"
node "$root/scripts/e2e-reattach.ts" "$cp_url" cli-hello -- \
  docker compose --project-directory "$work/node" -f "$work/node/compose.yaml" up -d --force-recreate

echo "e2e-deploy: OK (profile $profile)"
