# Published images

CI publishes Tryout's images to the GitHub Container Registry (`ghcr.io`), for `linux/amd64` and
`linux/arm64`. A node or a control plane can run from them without building anything.

| Image | Contents |
|---|---|
| `ghcr.io/<owner>/tryout-node` | `tryout-agent` and `tryout-gateway`, run as two containers (see [Production deployment](deployment.md)), and `tryout-certs`, which creates the mutual TLS certificates ([Certificates](certificates.md)) |
| `ghcr.io/<owner>/tryout-ttyd` | the web terminal the agent mounts into terminal sessions: ttyd's static binary alone, pinned by checksum (`apps/node/ttyd`). Each `tryout-node` image defaults to the `tryout-ttyd` digest published with it |
| `ghcr.io/<owner>/tryout-control-plane` | the control plane (Node.js) |
| `ghcr.io/<owner>/tryout-example-cli-hello` | the sample terminal project from `examples/cli-hello`, for demos and tests |

`<owner>` is the GitHub account that owns the repository, in lower case: `akinator31` for the
main repository. A fork publishes to its own namespace with no change to the workflow.

## Tags

| Tag | Points to | Use |
|---|---|---|
| `1.4.2` | the release `v1.4.2` | production, pinned by digest |
| `1.4` | the latest `v1.4.x` release | |
| `1` | the latest `v1.x.y` release (not created for `0.x`) | |
| `latest` | the latest release | evaluation only |
| `edge` | the latest commit on `main` | testing unreleased changes |
| `sha-<commit>` | one published commit (seven characters) | reproducing a build |

Images are pushed only after the unit, integration and end-to-end tests of the same commit
passed. Pull requests build the images without pushing them. When several commits land on `main`
in quick succession, CI may skip the queued runs in between, so not every commit gets a
`sha-*` tag. The end-to-end tests run on images built from the same commit, not on the pushed
bytes, and the arm64 images are built but not run in CI.

`tryout-ttyd` follows the repository's tags too, not ttyd's version. CI publishes it first, then
builds its digest into `tryout-node` as the agent's default `TTYD_IMAGE`: a node runs the ttyd of
its own release without any setting. The sample image is a demo, not a base image. Third-party
images, such as LinuxServer desktops, are not
republished: pull them from their own publishers.

**Pin by digest in production**, as for project images:

```bash
docker buildx imagetools inspect ghcr.io/akinator31/tryout-node:1.4.2   # prints the digest
```

```yaml
image: ghcr.io/akinator31/tryout-node:1.4.2@sha256:…
```

## Provenance

Each image carries a [SLSA](https://slsa.dev/) build provenance and an SPDX SBOM, stored in the
registry next to the image:

```bash
docker buildx imagetools inspect ghcr.io/akinator31/tryout-node:edge --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/akinator31/tryout-node:edge --format '{{ json .SBOM }}'
```

When the repository is public, CI also signs a GitHub artifact attestation, which proves that the
image was built by this repository's workflow:

```bash
gh attestation verify oci://ghcr.io/akinator31/tryout-node:edge --repo Akinator31/Tryout
```

## Visibility

A package published to `ghcr.io` for the first time can be private, whatever the repository's
visibility. After the first publication, and after making a repository public, open each
package's settings on GitHub (**Packages → Package settings → Change visibility**) and check that
it is public. A private package needs a registry login on the node to pull the node and control
plane images, and `REGISTRY_AUTH_FILE` on the agent for a project image such as
`tryout-example-cli-hello` (see [Project images](project-images.md#private-images)).
