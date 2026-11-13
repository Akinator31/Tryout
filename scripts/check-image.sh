#!/usr/bin/env bash
# Checks a project image against the Tryout contract (docs/project-images.md) before it goes
# to production: runs it the way the agent runs a session, then probes it the way the control
# plane does, through its base path, until it answers below 400.
#
# The constraints mirror the agent's (apps/node/cmd/agent: hardening.go, session.go): an
# internal network with no egress, no capabilities (desktop: the six its init needs),
# no-new-privileges, the kind's resource limits, and its environment with the same precedence
# (kind defaults < project variables < the agent's own). Terminals also get a read-only root
# filesystem with a small /tmp. The agent stays the reference; this script approximates it.
# Runs with bash 3.2 (macOS) and later.
#
# Usage: scripts/check-image.sh [options] <image>
#   --kind terminal|desktop   default terminal
#   --port N                  default 7681 (terminal), 3000 (desktop)
#   --strip-prefix            the project sets strip_prefix: true
#   --env KEY=VALUE           project environment variable; repeatable
#   --runtime NAME            container runtime, such as runsc (default: the daemon's default)
#   --timeout SECONDS         how long the image may take to answer; default 30 (terminal),
#                             170 (desktop), under the control plane's 180 s start limit
set -euo pipefail

kind=terminal
port=
strip_prefix=false
runtime=
timeout=
image=
project_env=()

session_id=check$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
container=tryout-check-$session_id
base_path=/s/$session_id
probe_image=curlimages/curl:8.11.1

# Desktop variables the agent sets: performance defaults a project may override, then the
# features it locks.
desktop_defaults=(
  "SELKIES_MANUAL_RESOLUTION=true|locked" SELKIES_MANUAL_WIDTH=1280 SELKIES_MANUAL_HEIGHT=720
  SELKIES_SCALING_DPI=96 "SELKIES_USE_CSS_SCALING=true|locked" SELKIES_FRAMERATE=15-30
  "SELKIES_AUDIO_ENABLED=false|locked" TITLE=check-image
)
desktop_locked=(
  PUID=1000 PGID=1000 HARDEN_DESKTOP=true START_DOCKER=false NO_GAMEPAD=true
  SELKIES_FILE_TRANSFERS=none
  "SELKIES_MICROPHONE_ENABLED=false|locked" "SELKIES_WEBCAM_ENABLED=false|locked"
  "SELKIES_PRINTING_ENABLED=false|locked" "SELKIES_GAMEPAD_ENABLED=false|locked"
  "SELKIES_SECOND_SCREEN=false|locked"
)

# usage prints the header's usage section and exits.
usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit 2
}

# parse_args reads the options, then applies the kind's defaults.
parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --kind | --port | --env | --runtime | --timeout)
        [ $# -ge 2 ] || { echo "$1 needs a value" >&2; usage; }
        case $1 in
          --kind) kind=$2 ;;
          --port) port=$2 ;;
          --env) project_env+=("$2") ;;
          --runtime) runtime=$2 ;;
          --timeout) timeout=$2 ;;
        esac
        shift 2
        ;;
      --strip-prefix) strip_prefix=true; shift ;;
      -h | --help) usage ;;
      -*) echo "unknown option $1" >&2; usage ;;
      *) image=$1; shift ;;
    esac
  done

  [ -n "$image" ] || usage
  case $kind in
    terminal) port=${port:-7681}; timeout=${timeout:-30} ;;
    desktop) port=${port:-3000}; timeout=${timeout:-170} ;;
    *) echo "--kind must be terminal or desktop" >&2; exit 2 ;;
  esac
}

# check_project_env refuses the variables the agent reserves, as the configuration does.
check_project_env() {
  local kv key
  for kv in ${project_env[@]+"${project_env[@]}"}; do
    key=${kv%%=*}
    if [[ $key == TRYOUT_* ]] || is_agent_variable "$key"; then
      echo "--env $key: reserved, the agent sets it" >&2
      exit 2
    fi
  done
}

# is_agent_variable tells whether the agent sets the variable for some kind of session.
is_agent_variable() {
  local kv
  for kv in HOME= SUBFOLDER= "${desktop_locked[@]}"; do
    [ "${kv%%=*}" = "$1" ] && return 0
  done
  return 1
}

# check_arch makes sure the image exists for this machine's architecture, as the agent does
# for its node.
check_arch() {
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null

  local image_arch daemon_arch
  image_arch=$(docker image inspect -f '{{.Architecture}}' "$image")
  daemon_arch=$(docker info -f '{{.Architecture}}' | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')
  if [ "$image_arch" != "$daemon_arch" ]; then
    fail "image is $image_arch but this machine is $daemon_arch: build a multi-architecture image"
  fi
  echo "ok   architecture $image_arch"
}

# start_session creates the session's internal network and runs the image on it, with the
# hardening common to every session, then the kind's limits and environment.
start_session() {
  docker network create --internal --label tryout.check=1 "$container" >/dev/null

  run_args=(--detach --name "$container" --hostname tryout --network "$container"
    --cap-drop=ALL --security-opt=no-new-privileges:true
    --log-driver=json-file --log-opt=max-size=1m --log-opt=max-file=1)
  if [ -n "$runtime" ]; then run_args+=(--runtime "$runtime"); fi
  add_kind_limits
  add_environment

  docker run "${run_args[@]}" "$image" >/dev/null
  echo "ok   started with the session constraints ($kind, port $port${runtime:+, runtime $runtime})"
}

# add_kind_limits adds the kind's resource limits and filesystem to run_args.
add_kind_limits() {
  case $kind in
    terminal)
      run_args+=(--memory=256m --memory-swap=256m --cpus=0.5 --pids-limit=128 --init
        --read-only "--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777")
      ;;
    desktop)
      run_args+=(--memory=2048m --memory-swap=2048m --cpus=1.5 --pids-limit=1024 --shm-size=1g)
      for cap in CHOWN SETUID SETGID DAC_OVERRIDE FOWNER KILL; do run_args+=(--cap-add="$cap"); done
      ;;
  esac
}

# add_environment adds the session's variables to run_args. Docker keeps the last value of a
# variable, so they go in the agent's order of precedence: kind defaults, project variables,
# then the variables the agent sets itself.
add_environment() {
  local kv defaults=() agent=(TRYOUT_SESSION_ID="$session_id" TRYOUT_BASE_PATH="$base_path")

  case $kind in
    terminal) agent+=(HOME=/tmp) ;;
    desktop)
      defaults=("${desktop_defaults[@]}")
      agent+=("${desktop_locked[@]}" "SUBFOLDER=$base_path/")
      ;;
  esac

  for kv in ${defaults[@]+"${defaults[@]}"} ${project_env[@]+"${project_env[@]}"} "${agent[@]}"; do
    run_args+=(--env "$kv")
  done
}

# probe_path is the path the gateway forwards to the container.
probe_path() {
  if [ "$strip_prefix" = true ]; then echo /; else echo "$base_path/"; fi
}

# wait_until_reachable probes the image from a container on the session network, like the
# gateway, until it answers below 400 without following redirects.
wait_until_reachable() {
  local path url started status elapsed
  path=$(probe_path)
  url="http://$container:$port$path"
  docker image inspect "$probe_image" >/dev/null 2>&1 || docker pull -q "$probe_image" >/dev/null
  started=$(date +%s)

  while :; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
      fail "the container exited before answering"
    fi

    status=$(docker run --rm --network "$container" "$probe_image" -s -o /dev/null \
      -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)
    elapsed=$(($(date +%s) - started))

    if [ -n "$status" ] && [ "$status" != 000 ] && [ "$status" -lt 400 ]; then
      echo "ok   answers $status on $path after $elapsed s"
      return
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      fail "no answer below 400 on $url within $timeout s (last status: ${status:-none})"
    fi
    sleep 2
  done
}

# fail prints the container's last logs, then the reason, and exits.
fail() {
  if docker inspect "$container" >/dev/null 2>&1; then
    echo "---- last container logs ----" >&2
    docker logs --tail 30 "$container" >&2 || true
    echo "-----------------------------" >&2
  fi
  echo "FAIL $1" >&2
  exit 1
}

# cleanup removes the session's container and network, whatever happened.
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "$container" >/dev/null 2>&1 || true
}

parse_args "$@"
check_project_env
trap cleanup EXIT
check_arch
start_session
wait_until_reachable
echo "OK   $image meets the contract for a $kind session"
