# 0014 — YAML configuration validated by one JSON Schema

**Status:** accepted, implemented. Milestone M1 (see [Roadmap](../roadmap.md)).

## Context

- The control plane read a JSON file and cast it to its types with no validation. A typo in a
  key was silently ignored, and a wrong value surfaced only when a visitor started a session.
- The agent and the gateway take about ten environment variables each, a good fit for
  containers. What crosses the boundary between the control plane and a node is the
  **workload** of a project (image, kind, port, runtime, limits, environment), sent with each
  `POST /v1/sessions`. The agent checked it by hand, with its own copy of the rules (for example
  the list of reserved environment variables).
- Operators edit the file by hand and keep it in version control, without secrets.

## Decision

- **Format**: the control plane reads YAML (`TRYOUT_CONFIG`, default `tryout.yaml`). YAML 1.2 is
  a superset of JSON, so a JSON file still parses. There is no compatibility layer for the old key
  names: no release had shipped.
- **One schema**: `schema/tryout.schema.json` (JSON Schema 2020-12) is the source of truth. It
  describes the configuration file. Its `$defs/workload` is shared by `$defs/project` (in the
  file) and `$defs/session_request` (the agent API). Types on each side are written by hand.
  Shared fixtures in `schema/testdata/` are checked by both validators, which must agree.
- **Copies**: `go:embed` and the Docker build contexts cannot reach outside their directory.
  `scripts/sync-schema.sh` copies the schema into the agent, the control plane and the docs
  site; CI fails if a copy is stale.
- **Where it is checked**:
  - the control plane validates the whole file at startup (ajv), then runs the checks a schema
    cannot express: a project's node exists, `max_age` is between 1 s and 24 h. A node whose
    projects allow more sessions than its cap gets a warning only, because the node cap wins;
  - the agent validates every `POST /v1/sessions` body against `$defs/session_request`
    (`santhosh-tekuri/jsonschema`), before its own policy checks. A Go test checks that the
    schema's reserved variables match the environment the agent locks.
- **Strictness**: unknown keys are errors at every level (`additionalProperties` or
  `unevaluatedProperties: false`). Every problem of every pass (interpolation, schema, semantic
  checks) is reported at once, with its path and its YAML line, and the control plane exits
  before it listens.
- **Secrets**: `${NAME}` in a string value is replaced by the environment variable `NAME`. The
  substitution happens after YAML parsing, so a value can never change the document's structure.
  An unset variable is an error. There is no default-value syntax and no escape for a literal
  `${`; a substituted value is always a string.
- **Shape changes**: durations are strings (`max_age: 15m`, the subset of Go's format with `h`,
  `m` and `s`); `listen` is a `[host]:port` address; `embed_frame_ancestors` is a list of origins,
  each validated, and `'self'` is always added.
- **Editors**: the schema is published with the docs at `schema/v1/tryout.schema.json`. Its
  `$id` is that URL, and the path changes when the format breaks.
- **Reloading**: none. A change needs a restart (hot reload touches the caps of running sessions;
  it belongs to milestone M4).

## Consequences

- A typo or an out-of-range value stops the control plane at startup with a precise message,
  instead of failing a visitor later.
- The agent rejects any field it does not know. A newer control plane that sends a new field to an
  older agent gets an error rather than a silently ignored setting; nodes and the control plane
  must be upgraded together, which suits a pre-1.0 project.
- The Go module gains its first dependencies (`santhosh-tekuri/jsonschema/v6` and
  `golang.org/x/text`), and the control plane gains `yaml` and `ajv`.
- The agent keeps its hand-written checks of the fields the hardening depends on (session id,
  kind, port, reserved variables), as defence in depth.
- Node settings stay in environment variables; mutual TLS (next M1 item) will add its own keys
  to the schema.
