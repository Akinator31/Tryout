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
PASS=0; FAIL=0
ok()   { echo "  [OK]   $*"; PASS=$((PASS+1)); }
ko()   { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
info() { echo "  [..]   $*"; }
indent() { sed 's/^/         /'; }

echo "== Host"
info "arch: $(uname -m)  kernel: $(uname -r)"
PAGE=$(getconf PAGESIZE)
if [ "$PAGE" = 4096 ]; then ok "page size 4K"; else ko "page size $PAGE (gVisor on arm64 may need a 4K kernel: kernel=kernel8.img in config.txt on a Pi 5)"; fi
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then ok "cgroup v2"; else ko "cgroup v1 (rootless limits will be ignored)"; fi
if [ -e /dev/kvm ]; then info "/dev/kvm present (Kata/VM possible)"; else info "no /dev/kvm"; fi

echo "== Docker (${DOCKER_HOST:-default socket})"
if ! docker info >/dev/null 2>&1; then ko "docker unreachable"; exit 1; fi
SEC=$(docker info --format '{{json .SecurityOptions}}')
case "$SEC" in *rootless*) ok "rootless daemon";; *) info "rootful daemon (fine for profile strict, refused by single-host)";; esac
if docker info --format '{{json .Runtimes}}' | grep -q "\"$RUNTIME\""; then ok "runtime $RUNTIME registered"; else ko "runtime $RUNTIME not registered in daemon.json"; fi

echo "== Terminal session under $RUNTIME"
T0=$(date +%s%N)
OUT=$(docker run --rm --runtime="$RUNTIME" --network none --cap-drop ALL --security-opt no-new-privileges \
      --read-only --tmpfs /tmp --memory 256m --pids-limit 128 debian:bookworm-slim \
      sh -c 'echo started; cat /proc/version; id -u' 2>&1)
T1=$(date +%s%N)
if echo "$OUT" | grep -q started; then
  ok "hardened container runs ($(( (T1-T0)/1000000 )) ms incl. image)"
else
  ko "hardened container failed:"
fi
printf '%s\n' "$OUT" | indent

NET=tryout-feas-$$
docker network create --internal "$NET" >/dev/null
OUT=$(docker run --rm --runtime="$RUNTIME" --network "$NET" debian:bookworm-slim \
      bash -c 'timeout 3 bash -c "echo > /dev/tcp/1.1.1.1/80" 2>&1 && echo EGRESS-OPEN || echo egress-blocked' 2>&1)
case "$OUT" in *egress-blocked*) ok "--internal network blocks egress under $RUNTIME";; *) ko "egress check: $OUT";; esac
docker network rm "$NET" >/dev/null

if [ "${SKIP_GUI:-0}" = 1 ]; then echo "== GUI skipped"; else
echo "== GUI (Selkies) under $RUNTIME: $GUI_IMAGE"
docker pull -q "$GUI_IMAGE" >/dev/null || ko "pull failed"
NET=tryout-feas-gui-$$
docker network create --internal "$NET" >/dev/null
SUB=/s/feasibilitytest0000000000/
CID=$(docker run -d --runtime="$RUNTIME" --network "$NET" --shm-size 1g --memory 2g --pids-limit 1024 \
      --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL \
      --security-opt no-new-privileges -e PUID=1000 -e PGID=1000 -e SUBFOLDER="$SUB" \
      -e HARDEN_DESKTOP=true -e NO_GAMEPAD=true -e START_DOCKER=false "$GUI_IMAGE")
# probe from a sidecar on the same internal network (the host cannot reach it in rootless mode)
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CID")
READY=0
for i in $(seq 1 90); do
  CODE=$(docker run --rm --network "$NET" curlimages/curl:8.11.1 -s -o /dev/null -w '%{http_code}' "http://$IP:3000$SUB" 2>/dev/null || true)
  if [ "$CODE" = 200 ]; then READY=$i; break; fi
  sleep 2
done
if [ "$READY" != 0 ]; then ok "Selkies answers 200 on $SUB after ~$((READY*2)) s"; else ko "Selkies not ready after 180 s (logs below)"; docker logs --tail 30 "$CID" 2>&1 | indent; fi
sleep 10
info "memory after boot: $(docker stats --no-stream --format '{{.MemUsage}}' "$CID")"
info "state: $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$CID")"
docker rm -f "$CID" >/dev/null; docker network rm "$NET" >/dev/null
fi

echo "== Result: $PASS ok, $FAIL failed"
[ "$FAIL" = 0 ]
