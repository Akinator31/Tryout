#!/bin/sh
# -W writable terminal, -m 1 one client max, -b base path given by the agent.
exec ttyd -W -m 1 -p 7681 -b "${TRYOUT_BASE_PATH:-/}" \
  -t titleFixed="Tryout" -t disableLeaveAlert=true \
  bash -c 'hello; exec bash -l'
