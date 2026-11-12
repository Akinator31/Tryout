# 0001 — Split the node into an agent and a gateway

**Status:** accepted

## Context

Access to the Docker socket is equivalent to root on the host
([OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html)).
Socket proxies such as [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)
filter by API path and method, not by request body, so they cannot forbid `Privileged: true`
on `POST /containers/create`. The component that receives Internet traffic is also the most
exposed one.

## Decision

Each node runs two processes from the same image:

- the **agent** holds the Docker socket, exposes a private API, and hard-codes the container
  specification;
- the **gateway** is the only public component, holds **no** socket, and proxies `/s/<id>/` to
  session containers it is attached to.

The agent pushes routes to the gateway over a **unix socket in a volume shared by both**. During
the POC, a TCP admin port turned out to be reachable from every session, since the gateway joins
each session network.

## Consequences

- Compromising the gateway does not give control of Docker.
- The gateway can run on rootless setups: it reaches sessions from inside their networks, not
  from the host (in rootless mode, container IPs are not routable from the host).
- Two containers to deploy per node.
