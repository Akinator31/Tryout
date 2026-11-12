# 0013 — Publish multi-architecture images on ghcr.io from CI

**Status:** accepted, implemented. First item of milestone M1 (see [Roadmap](../roadmap.md)).

## Context

- Operators built every image on their own machines, including on the node. The Security page
  already advises against building images on the node.
- The project is public and must not depend on the maintainer's infrastructure. A fork must be
  able to publish its own images without editing the workflow.
- Nodes run on amd64 and arm64 (the reference desktop node is a Raspberry Pi 5).
- GitHub Actions can push to the GitHub Container Registry with the workflow's own token, with no
  extra secret.

## Decision

- **Registry**: `ghcr.io`, namespace `github.repository_owner` in lower case.
- **Images**: `tryout-node` (agent and gateway, one image as in [0001](0001-split-agent-and-gateway.md)),
  `tryout-control-plane`, and the sample project `tryout-example-cli-hello`, so that a fresh
  machine can run a demo without building anything.
- **Platforms**: `linux/amd64` and `linux/arm64`. The Go build cross-compiles natively; the other
  images build under QEMU.
- **When**: the `images` job of `ci.yml` runs after every other job. It pushes on `main` and on
  `v*` tags only; pull requests build without pushing. An image is never published for a commit
  whose tests failed.
- **Tags**: `edge` for `main`, `sha-<commit>` for every push, and for a release tag `vX.Y.Z`:
  `X.Y.Z`, `X.Y`, `X` (not for `0.x`, where minor versions may break) and `latest`.
- **Supply chain**: BuildKit attaches a SLSA provenance (`mode=max`) and an SBOM to each image.
  When the repository is public, CI also creates a GitHub artifact attestation; GitHub's free
  plans do not offer it for private repositories.
- **Not published**: images of third-party projects (for example LinuxServer desktops); operators
  pull them from their own publishers.

## Consequences

- An operator deploys from tagged, attested images and pins them by digest, as for project images.
- Pull requests wait for the end-to-end tests before the image builds start.
- Packages created while the repository is private stay private until their visibility is
  changed by hand.
- Releases (`v0.1.0`, changelog) come with milestone M2; until then only `edge` and `sha-*` exist.
- The sample image is a demo, not a base image: its tags follow the repository, not ttyd.
