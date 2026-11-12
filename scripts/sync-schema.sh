#!/usr/bin/env bash
# Copies schema/tryout.schema.json (the source of truth) to its consumers:
# the agent embeds it, the control plane image ships it, the docs site
# publishes it for editors. Docker build contexts and go:embed cannot reach
# outside their directory, hence copies. --check fails if a copy is stale.
set -euo pipefail
cd "$(dirname "$0")/.."
src=schema/tryout.schema.json
copies=(
  apps/node/internal/spec/tryout.schema.json
  apps/control-plane/src/tryout.schema.json
  docs/schema/v1/tryout.schema.json
)
status=0
for dst in "${copies[@]}"; do
  if [[ "${1:-}" == "--check" ]]; then
    if ! cmp -s "$src" "$dst"; then
      echo "stale: $dst (run scripts/sync-schema.sh)" >&2
      status=1
    fi
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
done
exit "$status"
