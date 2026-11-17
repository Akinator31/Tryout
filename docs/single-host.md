# Single-host node

This guide runs a node in the `single-host` profile: on a machine that also runs other
services, such as a small server with your sites and databases. Sessions run on a **dedicated
rootless Docker daemon**, owned by an unprivileged user, and a firewall lets that user reach
the public Internet only. The machine's root daemon, if it has one, keeps running your other
services; Tryout never touches it.

It follows [Production deployment](deployment.md) and changes only the node. The control plane
may run elsewhere or on the same machine ([below](#control-plane-on-the-same-machine)).

!!! warning "Sessions run with runc, not gVisor"
    gVisor does not run under a rootless Docker daemon today
    ([google/gvisor#12575](https://github.com/google/gvisor/issues/12575)), so this guide uses
    runc with `ALLOW_RUNC=true`. A session is isolated by the container sandbox and the shared
    kernel: one kernel flaw lets an escaped session act as the unprivileged user on the host,
    which can still read what that user, or every user, can read. Use it for projects you
    trust and a host with nothing secret in world-readable files. For a host whose other
    services are valuable, run sessions in a virtual machine node in the `strict` profile
    instead. See [Security](security.md#single-host-machine-shared-with-other-services).

```
one machine
┌──────────────────────────────────────────────────────────────────────────┐
│ root Docker daemon (optional)        rootless daemon of the user tryout  │
│   your services                        agent :7000    gateway :8080      │
│   the control plane (optional)         sessions (runc, isolated networks)│
│                                                                          │
│ nftables: the user tryout and its subordinate uids reach the public      │
│ Internet only, never the host, the LAN or cloud metadata                 │
└──────────────────────────────────────────────────────────────────────────┘
```

CI follows this guide on a fresh Ubuntu runner (amd64), with a root daemon running next to the
rootless one, and runs the end-to-end tests against it (`NODE_USER=tryout
scripts/e2e/deploy.sh`).

## Requirements

| Needs | |
|---|---|
| System | Debian 13 or Ubuntu 24.04 or later, amd64 or arm64, with systemd and cgroup v2 (the default on both) |
| Docker | Docker Engine 28 or later [from Docker's repository](https://docs.docker.com/engine/install/), with the `docker-ce-rootless-extras` package |
| Access | `sudo` on the machine, for the setup only |

The commands below use the example files of `deploy/node/`, from a checkout of the repository
or copied to the machine.

## 1. Install the packages

```bash
sudo apt-get install docker-ce-rootless-extras uidmap slirp4netns dbus-user-session \
  systemd-container nftables
```

On Ubuntu, the AppArmor profile that lets RootlessKit create user namespaces comes with the
`apparmor` package; there is nothing to add for a Docker installed from its repository.

## 2. Create the user

The daemon, the agent, the gateway and the sessions all run as one dedicated user, here
`tryout`. Give it no password, no `sudo` and no membership of the `docker` group, which would
give it the root daemon and so root on the machine:

```bash
sudo adduser --disabled-password --comment "" tryout
grep ^tryout: /etc/subuid /etc/subgid      # 65,536 subordinate ids each
```

Then let its systemd manager hand the cgroup controllers to its daemon, without which the
sessions' memory, CPU and pids limits are ignored, and keep that manager running without a
login:

```bash
uid=$(id -u tryout)
sudo install -D -m 644 deploy/node/single-host/delegate.conf \
  "/etc/systemd/system/user@$uid.service.d/delegate.conf"
sudo systemctl daemon-reload
sudo loginctl enable-linger tryout
```

If the manager was already running, restart it: `sudo systemctl restart user@$uid.service`.

The home must carry no default ACL (`getfacl /home/tryout` lists none), which the daemon's
storage would inherit: creating the node's volume then fails with
`failed to copy xattrs: … system.posix_acl_default`. Remove them with
`sudo setfacl -R -b -k /home/tryout`.

## 3. Install the rootless daemon

Open a shell as the user, through systemd so that its session is complete, and install its
daemon:

```bash
sudo machinectl shell tryout@
dockerd-rootless-setuptool.sh install
docker info
```

The setup tool starts the daemon as a user service, enabled at boot, and makes it the default
for the user's `docker` command. `docker info` must show `name=rootless` in its security
options, `Cgroup Version: 2`, and no warning such as `No memory limit support`.

Every command for the node from here on runs in this shell.

## 4. Load the egress filter

The rootless daemon has no bridge on the host: its pulls, its containers' traffic and its
published ports all go through processes of the user `tryout` or of its subordinate uids. The
table in `tryout-egress.nft` filters what they send:

- answers on connections they accepted (the agent's and the gateway's ports) pass;
- the public Internet is open, for image pulls;
- the host's own addresses, private and special-purpose ranges (LAN, carrier-grade NAT,
  link-local and cloud metadata, unique local IPv6…) are refused;
- DNS goes to a public resolver, since the host's resolver is often on the LAN or a metadata
  address. A resolver on the host's loopback, such as systemd-resolved on Ubuntu, is allowed
  on port 53 instead, since a redirection cannot leave the loopback: on such a host, the
  user's queries reach the stub's upstream, LAN names included.

With global IPv6 on the LAN, the LAN's neighbours have global addresses too: add the host's
own prefixes to the `denied6` set.

The table is its own: it leaves the rules of the root daemon, UFW or anything else alone. Fill
in its three definitions, then load it at boot, and again whenever `nftables.service` reloads
the host's rules (Debian's `/etc/nftables.conf` begins with `flush ruleset`):

```bash
id -u tryout; grep ^tryout: /etc/subuid    # e.g. 1001, and tryout:165536:65536
sudo install -D -m 644 deploy/node/single-host/tryout-egress.nft /etc/tryout/tryout-egress.nft
sudoedit /etc/tryout/tryout-egress.nft     # tryout_uids = { 1001, 165536-231071 }, dns4, dns6
sudo install -m 644 deploy/node/single-host/tryout-egress.service /etc/systemd/system/
sudo systemctl enable --now tryout-egress.service
```

Check it from the user's shell:

```bash
curl -m 5 http://192.168.1.1        # an address of your LAN: refused
curl -sI https://ghcr.io | head -1  # the Internet: answers
```

The user cannot reach the host's own ports either, its own published ports included: check
those from your own account.

## 5. Set up the node

Make the certificates on your own machine as in
[Production deployment](deployment.md#1-create-the-certificates), then copy `deploy/node/` and
the node's certificates into the user's home:

```bash
sudo cp -r deploy/node /home/tryout/tryout-node
sudo cp -r pki/nodes/cli/ /home/tryout/tryout-node/pki    # tls.crt, tls.key, ca.crt
sudo chown -R tryout:tryout /home/tryout/tryout-node
```

In the user's shell, give the certificates to the agent, then prepare `.env`:

```bash
cd ~/tryout-node
docker run --rm -v "$PWD/pki:/pki" busybox:1.37 chown -R 65532:65532 /pki
cp .env.example .env
docker run --rm -v "$XDG_RUNTIME_DIR/docker.sock:/s" busybox:1.37 stat -c %g /s   # DOCKER_GID
```

The agent runs as uid 65532 inside the daemon's user namespace, which is one of the
subordinate uids on the host: a `chown` on the host would give the files to another uid, so
it runs in a container of the daemon. Likewise, the daemon's socket belongs to a group whose
number differs inside the namespace, which the last command prints.

Fill in `.env` as in [Production deployment](deployment.md#2-set-up-the-node), with these
values:

| Variable | Value |
|---|---|
| `NODE_PROFILE` | `single-host` |
| `ALLOW_RUNC` | `true` |
| `DEFAULT_RUNTIME` | `runc` |
| `DOCKER_SOCKET` | the rootless daemon's socket: `/run/user/<uid>/docker.sock` (`echo $XDG_RUNTIME_DIR`) |
| `DOCKER_GID` | the number printed by the last command above |
| `AGENT_PUBLISH` | a private or VPN address of the host and a port, or `127.0.0.1:7000` when a tunnel on the host carries it. **Never a public address.** |
| `GATEWAY_PUBLISH` | where your proxy or tunnel reaches the gateway, e.g. `127.0.0.1:8080` |

The daemon publishes ports through RootlessKit, as the user: ports below 1024 are refused, and
connections reach the agent and the gateway from a RootlessKit address instead of the
client's, which neither of them uses.

Start the node and check that the agent accepted its profile:

```bash
docker compose up -d
docker compose logs agent   # "agent listening (mutual TLS)" with profile single-host
```

The agent warns that `ALLOW_RUNC=true` lets sessions use runc. It refuses to start, with the
reason in its log, when the daemon is not rootless (the wrong socket), on cgroup v1, or when
the daemon ignores the memory, CPU or pids limit: check the delegation of step 2 with
`cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers`,
which must list `cpu`, `memory` and `pids`.

## Control plane on the same machine

Run `deploy/control-plane/` on the root daemon, or on the platform that runs your other
services, as in [Production deployment](deployment.md#3-set-up-the-control-plane). Its
containers have their own loopback, so they cannot reach an agent published on `127.0.0.1`:
publish the agent on a private or VPN address of the host, and use it in `agent_url` and in
the node's certificate (`--san`). The egress filter does not get in the way, since the control
plane opens the connection and the agent only answers.

A bridge address of the root daemon, such as `172.17.0.1`, works too, but it exists only
while the root daemon runs: if the rootless daemon starts first at boot, the agent cannot
publish its port and stays stopped.

Keep the two daemons apart: never mount the root daemon's socket into the node, nor the
rootless one into the control plane or anything else.

## Operations

- **Commands**: everything for the node runs in the user's shell, `sudo machinectl shell tryout@`.
- **Logs**: `journalctl --user -u docker` for the daemon, `docker compose logs` for the node.
- **Upgrades**: Docker's packages update both daemons' binaries; restart the rootless one with
  `systemctl --user restart docker`. Upgrade Tryout as in
  [Production deployment](deployment.md#upgrade).
- **Updates matter more here**: with runc, the kernel and runc are the barrier between a
  session and the host. Keep them up to date, with AppArmor and seccomp enabled.
