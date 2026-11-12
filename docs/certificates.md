# Certificates

The control plane calls each agent over **mutual TLS**: the agent proves its identity to the
control plane, and the control plane to the agent. There is no other authentication and no
plain-HTTP mode ([ADR 0015](decisions/0015-mutual-tls-control-plane-agent.md)).

You need:

| Who | Files | Role |
|---|---|---|
| your machine | `ca/ca.crt`, `ca/ca.key` | the private CA. **The key never leaves this machine.** |
| control plane | `tls.crt`, `tls.key`, `ca.crt` | client certificate (`clientAuth`), and the CA that signs the agents |
| each agent | `tls.crt`, `tls.key`, `ca.crt` | server certificate (`serverAuth`) naming the node, and the CA that signs the control plane |

## Create them with `tryout-certs`

The `tryout-node` image ships `tryout-certs`. Run it on your own machine:

```bash
IMAGE=ghcr.io/<owner>/tryout-node:<version>
certs() { docker run --rm -u "$(id -u):$(id -g)" -v "$PWD/pki:/pki" "$IMAGE" tryout-certs "$@" --dir /pki; }

mkdir -p pki
certs init                                       # the CA + the control plane's certificate
certs node cli --san sbx-cli.internal            # one per node: the host in its agent_url
certs node gui --san 10.0.50.20                  # an IP address works too
certs inspect                                    # subjects, usages, names, expiry dates
```

Each sub-directory is what one machine needs:

```
pki/
├── ca/              keep here; back it up
├── control-plane/   copy to the control plane
└── nodes/
    ├── cli/         copy to node "cli"
    └── gui/         copy to node "gui"
```

Private keys are written with mode `0600`. `--san` is repeatable and must cover the host of the
node's `agent_url`: a DNS name or an IP address. `--days` sets the validity of leaf
certificates (default 365); the CA lasts 10 years.

## Configure

Control plane (paths are relative to the configuration file):

```yaml
agent_tls:
  ca: pki/ca.crt
  cert: pki/tls.crt
  key: pki/tls.key

nodes:
  cli:
    agent_url: https://sbx-cli.internal:7000
  gui:
    agent_url: https://10.0.50.20:7000
```

Agent:

```bash
AGENT_TLS_CERT=/pki/tls.crt
AGENT_TLS_KEY=/pki/tls.key
AGENT_TLS_CLIENT_CA=/pki/ca.crt
```

Mount the files read-only. The agent runs as `nonroot` (uid 65532) in the published image, or
as the user you choose: it must be able to read its key.

### When the URL host is not in the certificate

Through a tunnel or a port forward, the control plane may reach a node as
`https://127.0.0.1:17000` while the node's certificate names `sbx-cli.internal`. Set the
expected name:

```yaml
nodes:
  cli:
    agent_url: https://127.0.0.1:17000
    server_name: sbx-cli.internal
```

The tunnel must carry TLS **untouched** (VPN, SSH forward, TCP-level tunnel). An HTTP reverse
proxy that terminates TLS in front of the agent breaks client authentication.

## Rotate

Certificates are read at startup. The control plane warns at startup, and the agent at startup
and then daily, from 30 days before a certificate expires. Both refuse to start with an expired
or not-yet-valid certificate; for the agent, this includes every CA in
`AGENT_TLS_CLIENT_CA`.

```bash
certs node cli --san sbx-cli.internal --force   # new server certificate for a node
certs client --force                            # new client certificate for the control plane
```

Copy the new files and restart the component. The CA is never replaced by `tryout-certs`: to
start over (for example after a leak of the CA key), remove `pki/`, run `init` again and
reissue every certificate.

There is no revocation list. To cut off a node, remove it from the configuration; to cut off a
leaked control plane key, issue a new CA.

## Bring your own PKI

Any CA works (step-ca, Vault, openssl…), with these rules:

- PEM files; ECDSA, RSA or Ed25519 keys. An agent's certificate file may carry intermediate
  certificates after the leaf; they are sent to the control plane.
- The control plane's certificate states the `clientAuth` extended key usage.
- Each agent's certificate states `serverAuth` and names the host of its `agent_url` (or its
  `server_name`) in its subject alternative names.
- Use a CA dedicated to Tryout: the agent accepts **any** `clientAuth` certificate from the CA
  you give it.
