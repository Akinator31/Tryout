# Tryout

Let portfolio visitors **try your projects in their browser**, each in a disposable, isolated
container.

- **Command-line projects** open in a web terminal (ttyd).
- **Graphical projects** are streamed to the browser (Selkies).
- **A limited number of concurrent sessions per project**, with a queue for everyone else.
- **A fresh container per visitor**, destroyed at the end, with no outbound network, dropped
  capabilities and an optional gVisor sandbox.

Your portfolio only embeds an iframe:

```html
<iframe src="https://tryout.example.org/embed/my-project"
        allow="clipboard-read; clipboard-write; autoplay; fullscreen; keyboard-map"></iframe>
```

> **Status: pre-release.** The architecture has been validated by a proof of concept, including
> desktop sessions under gVisor on a Raspberry Pi 5. Several components are still provisional;
> see the [roadmap](docs/roadmap.md).

## How it works

```
browser ─► control plane (TypeScript)   queue, tickets, embed page
              │ (calls nodes, never the reverse)
              ▼
           node: agent (Go)             sole holder of the Docker socket
                 gateway (Go)           public proxy /s/<id>/, no Docker socket
                   ▼
                 session container      hardened, runsc or runc, destroyed at the end
```

Read [Architecture](docs/architecture.md) for details.

## Quickstart (local, no security guarantee)

```bash
docker build -t tryout-example/cli-hello:dev examples/cli-hello
cp deploy/.env.example deploy/.env
docker compose -f deploy/compose.dev.yaml up -d --build
# open http://localhost:3000/demo
```

## Documentation

| | |
|---|---|
| [Local quickstart](docs/quickstart.md) | run and test the stack |
| [Security](SECURITY.md) | threat model, node profiles, reporting vulnerabilities |
| [Configuration](docs/configuration.md) | nodes, projects, environment variables |
| [Project images](docs/project-images.md) | the contract an image must follow |
| [Published images](docs/published-images.md) | Tryout's multi-arch images on `ghcr.io` |
| [Public exposure](docs/exposure.md) | tunnels, reverse proxies, iframes |
| [Performance](docs/performance.md) | measured costs and node sizing |
| [Decisions](docs/decisions/index.md) | architecture decision records |
| [Contributing](docs/contributing.md) | conventions and local checks |

The documentation site is built with [Zensical](https://zensical.org) (`zensical serve`).

## License

[AGPL-3.0-or-later](LICENSE).
