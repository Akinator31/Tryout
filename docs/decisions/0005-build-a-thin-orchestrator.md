# 0005 — Build a thin orchestrator

**Status:** accepted

## Context

Existing options were reviewed during the research phase:

- Kasm Workspaces Community Edition caps concurrent sessions and is limited to non-commercial use
  ([license](https://kasm.com/docs/latest/license.html)).
- [neko-rooms](https://github.com/m1k1o/neko-rooms) only orchestrates Neko.
- [SealSkin](https://docs.linuxserver.io/selkies/components/sealskin/) is user-centric, not built
  for anonymous queues.
- [JupyterHub DockerSpawner](https://github.com/jupyterhub/dockerspawner) is tied to the
  JupyterHub model.
- [Play with Docker](https://github.com/play-with-docker/play-with-docker) is a reference for the
  pattern, but the service has been shut down.

## Decision

Write a small agent that creates containers with a hard-coded, hardened specification, plus a
control plane that owns the queue. Use the reviewed projects as references, not dependencies.

## Consequences

- Full control of the security posture and the queue semantics.
- The code to maintain is small (a few hundred lines per component), at the cost of features to
  build ourselves (admin UI, metrics).
