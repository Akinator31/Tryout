#!/usr/bin/env bash
# End-to-end test of the production layout (docs/deployment.md): deploy/node and
# deploy/control-plane, run as two separate compose projects that only reach each
# other through published ports, with certificates made by tryout-certs as the guide
# does it. Then runs the terminal, queue, SSE and mutual TLS end-to-end tests against it, and
# recreates the node (agent and gateway) during a session, as an upgrade does.
#
# Usage: scripts/e2e/deploy.sh            (from the repository root)
#
# Environment:
#   TRYOUT_NODE_IMAGE, TRYOUT_CONTROL_PLANE_IMAGE, TRYOUT_VERSION
#                   images to test (default: build them locally as tryout-*:e2e)
#   TTYD_IMAGE      ttyd image the agent mounts (default: the agent's own when
#                   TRYOUT_VERSION is set, else apps/node/ttyd built as tryout-ttyd:e2e)
#   PROJECT_IMAGE   sample project image (default: build examples/cli-hello)
#   NODE_PROFILE    default strict (requires gVisor); dev on a machine without it;
#                   single-host with NODE_USER
#   NODE_USER       run the node on this user's rootless daemon, set up as in
#                   docs/single-host.md (profile single-host, runc). Needs sudo; the
#                   images built or set here are copied into that daemon.
#   HOST_ADDR       address of this machine as the containers reach it; also the agent
#                   certificate's name (default: first address of `hostname -I`;
#                   host.docker.internal with Docker Desktop)
#   BIND_ADDR       address the services are published on (default: HOST_ADDR;
#                   127.0.0.1 with Docker Desktop)
#   CHOWN_CMD       command that gives a directory to a uid (default: sudo chown -R;
#                   ":" where bind mounts ignore ownership, as with Docker Desktop)
#   KEEP=1          leave the stack running
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$root/.cache"
work=$(mktemp -d -p "$root/.cache" e2e-deploy.XXXXXX)
host_addr=${HOST_ADDR:-$(hostname -I | awk '{print $1}')}
bind_addr=${BIND_ADDR:-$host_addr}
chown_cmd=${CHOWN_CMD:-sudo chown -R}
node_user=${NODE_USER:-}
if [ -n "$node_user" ]; then
  profile=${NODE_PROFILE:-single-host}
  node_uid=$(id -u "$node_user")
  node_home=$(getent passwd "$node_user" | cut -d: -f6)
else
  profile=${NODE_PROFILE:-strict}
fi

# Images under test: build them unless TRYOUT_VERSION names published ones.
if [ -z "${TRYOUT_VERSION:-}" ]; then
  docker build -q -t tryout-node:e2e "$root/apps/node" >/dev/null
  docker build -q -t tryout-control-plane:e2e -f "$root/apps/control-plane/Dockerfile" "$root" >/dev/null
  export TRYOUT_NODE_IMAGE=tryout-node TRYOUT_CONTROL_PLANE_IMAGE=tryout-control-plane TRYOUT_VERSION=e2e
  if [ -z "${TTYD_IMAGE:-}" ]; then
    docker build -q -t tryout-ttyd:e2e "$root/apps/node/ttyd" >/dev/null
    export TTYD_IMAGE=tryout-ttyd:e2e
  fi
fi
node_image="${TRYOUT_NODE_IMAGE:-ghcr.io/akinator31/tryout-node}:$TRYOUT_VERSION"
cp_image="${TRYOUT_CONTROL_PLANE_IMAGE:-ghcr.io/akinator31/tryout-control-plane}:$TRYOUT_VERSION"
project_image=${PROJECT_IMAGE:-}
if [ -z "$project_image" ]; then
  project_image=tryout-example/cli-hello:e2e
  docker build -q -t "$project_image" "$root/examples/cli-hello" >/dev/null
fi

# node_docker <args...>: docker on the daemon that runs sessions: the default one, or
# NODE_USER's rootless daemon, run as that user (as_node_user).
node_docker_cmd=(docker)
if [ -n "$node_user" ]; then
  as_node_user=(sudo -u "$node_user" env HOME="$node_home" XDG_RUNTIME_DIR="/run/user/$node_uid")
  node_docker_cmd=("${as_node_user[@]}" DOCKER_HOST="unix:///run/user/$node_uid/docker.sock" docker)
fi
node_docker() { "${node_docker_cmd[@]}" "$@"; }

# load_images: copies the images under test that exist on the default daemon into
# NODE_USER's rootless daemon, which would otherwise pull them.
load_images() {
  local image
  for image in "$node_image" "${TTYD_IMAGE:-}" "$project_image"; do
    if [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1; then
      docker save "$image" | node_docker load -q >/dev/null
    fi
  done
}

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

# The node's directory: the copied example, or, with NODE_USER, a copy in that user's home
# made by install_node_dir, since the rootless daemon only reads its own files.
node_dir=$work/node

# compose <dir> <args...>: docker compose on one of the copied example directories.
compose() {
  if [ "$1" = node ]; then
    node_docker compose --project-directory "$node_dir" -f "$node_dir/compose.yaml" "${@:2}"
  else
    docker compose --project-directory "$work/$1" -f "$work/$1/compose.yaml" "${@:2}"
  fi
}

# cleanup: on exit, print the logs if the test failed, then remove both stacks and
# the work directory, unless KEEP=1.
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
    if [ -n "$node_user" ]; then sudo rm -rf "$node_dir" || true; fi
    rm -rf "$work" || true
  else
    echo "stack kept; files in $work"
  fi
  exit "$status"
}
trap cleanup EXIT

# certs <args...>: tryout-certs from the node image, on the work directory's pki/.
certs() { docker run --rm -u "$(id -u):$(id -g)" -v "$work/pki:/pki" "$node_image" tryout-certs "$@" --dir /pki; }

# issue_certificates: the PKI, made on "the operator's machine" (docs/certificates.md),
# then each machine's directory copied and given to the uid of its service.
issue_certificates() {
  mkdir -p "$work/pki"
  certs init >/dev/null
  certs node cli --san "$host_addr" >/dev/null

  cp -r "$work/pki/nodes/cli" "$work/node/pki"
  cp -r "$work/pki/control-plane" "$work/control-plane/pki"
  if [ -z "$node_user" ]; then $chown_cmd 65532:65532 "$work/node/pki"; fi
  $chown_cmd 1000:1000 "$work/control-plane/pki"
}

# install_node_dir: with NODE_USER, the node's directory copied to that user's home, as
# the guide has it, and its certificates given to the agent's uid inside the rootless
# daemon's user namespace.
install_node_dir() {
  node_dir=$(sudo -u "$node_user" mktemp -d -p "$node_home" e2e-node.XXXXXX)
  sudo cp -r "$work/node/." "$node_dir/"
  sudo chown -R "$node_user:" "$node_dir"
  "${as_node_user[@]}" dockerd-rootless-setuptool.sh nsenter -- chown -R 65532:65532 "$node_dir/pki"
}

# socket_gid <socket>: the group of the daemon's socket, as the agent sees it: for a
# rootless daemon, from inside its user namespace (docs/single-host.md).
socket_gid() {
  if [ -n "$node_user" ]; then
    node_docker run --rm -v "$1:/s" busybox:1.37 stat -c %g /s
  else
    stat -c %g "$1"
  fi
}

# start_node: the node's .env from its example, then the node stack.
start_node() {
  local docker_sock=${DOCKER_SOCKET:-/var/run/docker.sock} runtime=()
  if [ -n "$node_user" ]; then
    docker_sock=/run/user/$node_uid/docker.sock
    runtime=(-e "s|^#ALLOW_RUNC=.*|ALLOW_RUNC=true|" -e "s|^#DEFAULT_RUNTIME=.*|DEFAULT_RUNTIME=runc|")
  fi
  write_env node TRYOUT_NODE_IMAGE "${runtime[@]}" \
    -e "s|^NODE_PROFILE=.*|NODE_PROFILE=$profile|" \
    -e "s|^DOCKER_SOCKET=.*|DOCKER_SOCKET=$docker_sock|" \
    -e "s|^DOCKER_GID=.*|DOCKER_GID=${DOCKER_GID:-$(socket_gid "$docker_sock")}|" \
    -e "s|^GATEWAY_TOKEN=.*|GATEWAY_TOKEN=$(openssl rand -hex 32)|" \
    -e "s|^AGENT_PUBLISH=.*|AGENT_PUBLISH=$bind_addr:7000|" \
    -e "s|^GATEWAY_PUBLISH=.*|GATEWAY_PUBLISH=$bind_addr:8080|" \
    -e "s|^FRAME_ANCESTORS=.*|FRAME_ANCESTORS=http://$bind_addr:3000|"
  if [ -n "${TTYD_IMAGE:-}" ]; then echo "TTYD_IMAGE=$TTYD_IMAGE" >>"$work/node/.env"; fi
  if [ -n "$node_user" ]; then
    load_images
    install_node_dir
  fi
  compose node up -d --quiet-pull
}

# start_control_plane: the control plane's .env, and the tryout.yaml the operator
# writes from the example, then the control plane stack.
start_control_plane() {
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
    max_sessions: 2
    max_age: 10m
EOF
  compose control-plane up -d --quiet-pull
}

# wait_until_healthy: up to 90 s for both published health checks, then a last,
# failing, check.
wait_until_healthy() {
  for _ in $(seq 90); do
    curl -fs "http://$bind_addr:3000/healthz" >/dev/null && curl -fs "http://$bind_addr:8080/healthz" >/dev/null && break
    sleep 1
  done
  curl -fsS "http://$bind_addr:3000/healthz" >/dev/null
  curl -fsS "http://$bind_addr:8080/healthz" >/dev/null
}

# run_e2e_tests: the end-to-end tests, through the published ports only.
run_e2e_tests() {
  local cp_url="http://$bind_addr:3000"
  node "$root/scripts/e2e/cli.ts" "$cp_url" cli-hello
  node "$root/scripts/e2e/queue.ts" "$cp_url"
  node "$root/scripts/e2e/sse.ts" "$cp_url" cli-hello
  # The agent's published port, from outside both stacks, with the operator's certificates;
  # the agent's certificate names HOST_ADDR, which may differ from BIND_ADDR (Docker Desktop).
  node "$root/scripts/e2e/mtls.ts" "$bind_addr:7000" --pki "$work/pki" --node cli --server-name "$host_addr"
  node "$root/scripts/e2e/reattach.ts" "$cp_url" cli-hello -- \
    "${node_docker_cmd[@]}" compose --project-directory "$node_dir" -f "$node_dir/compose.yaml" up -d --force-recreate
}

# Copy the example directories, as an operator would, then deploy and test.
cp -r "$root/deploy/node" "$root/deploy/control-plane" "$work/"
issue_certificates
start_node
start_control_plane
wait_until_healthy
run_e2e_tests

echo "e2e-deploy: OK (profile $profile)"
