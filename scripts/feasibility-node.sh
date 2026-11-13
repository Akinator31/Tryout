#!/usr/bin/env bash
# Feasibility checks for a Tryout sandbox node (run ON the node, e.g. the Pi 5).
# Non-destructive: it only starts throwaway containers and removes them.
#
#   DOCKER_HOST=unix:///run/user/1001/docker.sock ./feasibility-node.sh
#
# Env:
#   RUNTIME=runsc            runtime to test (runsc | runc | kata...)
#   GUI_IMAGE=lscr.io/linuxserver/webtop:latest
#   SKIP_GUI=1               only run the terminal checks
set -u
RUNTIME=${RUNTIME:-runsc}
GUI_IMAGE=${GUI_IMAGE:-lscr.io/linuxserver/webtop:latest}
PASS=0
FAIL=0

ok()     { echo "  [OK]   $*"; PASS=$((PASS+1)); }
ko()     { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
info()   { echo "  [..]   $*"; }
indent() { sed 's/^/         /'; }

# check_host: page size (gVisor on arm64), cgroup version, KVM.
check_host() {
  echo "== Host"
  info "arch: $(uname -m)  kernel: $(uname -r)"

  local page
  page=$(getconf PAGESIZE)
  if [ "$page" = 4096 ]; then
    ok "page size 4K"
  else
    ko "page size $page (gVisor on arm64 may need a 4K kernel: kernel=kernel8.img in config.txt on a Pi 5)"
  fi

  if [ -f /sys/fs/cgroup/cgroup.controllers ]; then ok "cgroup v2"; else ko "cgroup v1 (rootless limits will be ignored)"; fi
  if [ -e /dev/kvm ]; then info "/dev/kvm present (Kata/VM possible)"; else info "no /dev/kvm"; fi
}

# check_docker: the daemon is reachable (or the script stops), rootless or not,
# and has RUNTIME registered.
check_docker() {
  echo "== Docker (${DOCKER_HOST:-default socket})"
  if ! docker info >/dev/null 2>&1; then
    ko "docker unreachable"
    exit 1
  fi

  local sec
  sec=$(docker info --format '{{json .SecurityOptions}}')
  case "$sec" in
    *rootless*) ok "rootless daemon" ;;
    *) info "rootful daemon (fine for profile strict, refused by single-host)" ;;
  esac

  if docker info --format '{{json .Runtimes}}' | grep -q "\"$RUNTIME\""; then
    ok "runtime $RUNTIME registered"
  else
    ko "runtime $RUNTIME not registered in daemon.json"
  fi
}

# check_terminal: a container with the agent's terminal hardening runs under RUNTIME.
check_terminal() {
  echo "== Terminal session under $RUNTIME"
  local t0 t1 out
  t0=$(date +%s%N)
  out=$(docker run --rm --runtime="$RUNTIME" --network none --cap-drop ALL --security-opt no-new-privileges \
        --read-only --tmpfs /tmp --memory 256m --pids-limit 128 debian:bookworm-slim \
        sh -c 'echo started; cat /proc/version; id -u' 2>&1)
  t1=$(date +%s%N)

  if echo "$out" | grep -q started; then
    ok "hardened container runs ($(( (t1-t0)/1000000 )) ms incl. image)"
  else
    ko "hardened container failed:"
  fi
  printf '%s\n' "$out" | indent
}

# check_egress: an --internal network has no route out under RUNTIME.
check_egress() {
  local net=tryout-feas-$$ out
  docker network create --internal "$net" >/dev/null
  out=$(docker run --rm --runtime="$RUNTIME" --network "$net" debian:bookworm-slim \
        bash -c 'timeout 3 bash -c "echo > /dev/tcp/1.1.1.1/80" 2>&1 && echo EGRESS-OPEN || echo egress-blocked' 2>&1)
  case "$out" in
    *egress-blocked*) ok "--internal network blocks egress under $RUNTIME" ;;
    *) ko "egress check: $out" ;;
  esac
  docker network rm "$net" >/dev/null
}

# check_gui: a Selkies desktop with the agent's capability set boots under RUNTIME
# behind a base path, then reports its memory and state.
check_gui() {
  echo "== GUI (Selkies) under $RUNTIME: $GUI_IMAGE"
  docker pull -q "$GUI_IMAGE" >/dev/null || ko "pull failed"

  local net=tryout-feas-gui-$$ sub=/s/feasibilitytest0000000000/ cid ip code i ready=0
  docker network create --internal "$net" >/dev/null
  cid=$(docker run -d --runtime="$RUNTIME" --network "$net" --shm-size 1g --memory 2g --pids-limit 1024 \
        --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL \
        --security-opt no-new-privileges -e PUID=1000 -e PGID=1000 -e SUBFOLDER="$sub" \
        -e HARDEN_DESKTOP=true -e NO_GAMEPAD=true -e START_DOCKER=false "$GUI_IMAGE")

  # Probe from a sidecar on the same internal network (the host cannot reach it in rootless mode).
  ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$cid")
  for i in $(seq 1 90); do
    code=$(docker run --rm --network "$net" curlimages/curl:8.11.1 -s -o /dev/null -w '%{http_code}' "http://$ip:3000$sub" 2>/dev/null || true)
    if [ "$code" = 200 ]; then ready=$i; break; fi
    sleep 2
  done
  if [ "$ready" != 0 ]; then
    ok "Selkies answers 200 on $sub after ~$((ready*2)) s"
  else
    ko "Selkies not ready after 180 s (logs below)"
    docker logs --tail 30 "$cid" 2>&1 | indent
  fi

  sleep 10
  info "memory after boot: $(docker stats --no-stream --format '{{.MemUsage}}' "$cid")"
  info "state: $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$cid")"
  docker rm -f "$cid" >/dev/null
  docker network rm "$net" >/dev/null
}

check_host
check_docker
check_terminal
check_egress
if [ "${SKIP_GUI:-0}" = 1 ]; then echo "== GUI skipped"; else check_gui; fi

echo "== Result: $PASS ok, $FAIL failed"
[ "$FAIL" = 0 ]
