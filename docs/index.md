# Tryout

Tryout lets portfolio visitors **try projects in their browser**, each in a disposable, isolated
environment:

- **command-line** projects open in a web terminal (ttyd);
- **graphical** projects are streamed to the browser (Selkies);
- each project has a **limited number of concurrent sessions**, with a **queue**;
- every session is a **fresh container**, destroyed at the end, with no outbound network access.

The portfolio only embeds an iframe:

```html
<iframe src="https://tryout.example.org/embed/my-project"
        allow="clipboard-read; clipboard-write; autoplay; fullscreen; keyboard-map"></iframe>
```

!!! warning "0.x"
    Released versions are listed on the
    [releases page](https://github.com/Akinator31/Tryout/releases). Until 1.0, configuration and
    APIs may change between minor versions. See the [Roadmap](roadmap.md).

## Where to start

- [Local quickstart](quickstart.md): run the whole stack on your machine in a few minutes.
- [Architecture](architecture.md): the three components and the life of a session.
- [Security](security.md): threat model and node profiles. **Read before going online.**
- [Configuration](configuration.md): declare your nodes and projects.
- [Project images](project-images.md): what an image must comply with.
- [Packaging a project](packaging.md): a terminal and a desktop example, step by step.
- [Published images](published-images.md): Tryout's own images on `ghcr.io`.
- [Public exposure](exposure.md): make the platform reachable from the Internet.
