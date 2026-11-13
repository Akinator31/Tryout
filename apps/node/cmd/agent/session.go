package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/spec"
)

// sessionIDRe matches the ids the control plane generates. Ids end up in
// container and network names and in the gateway's /s/<id>/ paths.
var sessionIDRe = regexp.MustCompile(`^[a-z0-9]{26}$`)

// sessionKind is what a session serves: a web terminal (ttyd) or a streamed
// desktop (Selkies). The kind selects the hardening variant, the locked
// environment and the default limits.
type sessionKind string

const (
	kindTerminal sessionKind = "terminal"
	kindDesktop  sessionKind = "desktop"
)

// limits are a session's resource limits. Zero means the kind's default.
type limits struct {
	MemoryMB int     `json:"memory_mb"`
	CPUs     float64 `json:"cpus"`
	Pids     int64   `json:"pids"`
}

// defaultLimits are the resource limits of each session kind, used for the
// fields a request leaves at zero.
var defaultLimits = map[sessionKind]limits{
	kindTerminal: {MemoryMB: 256, CPUs: 0.5, Pids: 128},
	kindDesktop:  {MemoryMB: 2048, CPUs: 1.5, Pids: 1024},
}

// sessionReq is the body of POST /v1/sessions.
type sessionReq struct {
	ID          string            `json:"id"`
	Project     string            `json:"project"`
	Image       string            `json:"image"`
	Kind        sessionKind       `json:"kind"`
	Port        int               `json:"port"`
	Runtime     string            `json:"runtime,omitempty"`
	MaxAgeS     int               `json:"max_age_s"`
	StripPrefix bool              `json:"strip_prefix,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Limits      limits            `json:"limits"`
}

// parseSessionReq checks the body against the shared JSON Schema (the same
// file the control plane validates its configuration with), then applies the
// node's policy and defaults.
func (a *agent) parseSessionReq(body []byte) (sessionReq, error) {
	var r sessionReq
	if err := spec.ValidateSessionRequest(body); err != nil {
		return r, err
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return r, err
	}
	return r, r.validate(a)
}

// validate re-checks the fields the hardening depends on (defence in depth,
// the schema already covers them), then applies the node policy and defaults.
func (r *sessionReq) validate(a *agent) error {
	if err := r.checkShape(); err != nil {
		return err
	}
	if err := r.applyRuntimePolicy(a); err != nil {
		return err
	}
	if err := r.checkEnv(); err != nil {
		return err
	}

	r.applyDefaults(a.cfg.maxAge)
	return nil
}

// checkShape checks the fields that name things or reach the container spec.
func (r *sessionReq) checkShape() error {
	switch {
	case !sessionIDRe.MatchString(r.ID):
		return errors.New("invalid id")
	case r.Image == "":
		return errors.New("image required")
	case r.Kind != kindTerminal && r.Kind != kindDesktop:
		return errors.New("kind must be terminal or desktop")
	case r.Port <= 0 || r.Port > 65535:
		return errors.New("invalid port")
	}
	return nil
}

// applyRuntimePolicy fills in the default runtime, then refuses a runtime the
// daemon does not have or the node profile does not allow.
func (r *sessionReq) applyRuntimePolicy(a *agent) error {
	if r.Runtime == "" {
		r.Runtime = a.cfg.defaultRuntime
	}

	if !a.runtimes[r.Runtime] {
		return fmt.Errorf("runtime %q not installed on this node", r.Runtime)
	}
	if !a.runtimeAllowed(r.Runtime) {
		return fmt.Errorf("runtime %q refused by node profile %s: only runsc without ALLOW_RUNC", r.Runtime, a.cfg.profile)
	}
	return nil
}

// checkEnv refuses a project variable that the agent sets itself.
func (r *sessionReq) checkEnv() error {
	for k := range r.Env {
		if isReservedEnv(k) {
			return fmt.Errorf("env %s is reserved", k)
		}
	}
	return nil
}

// applyDefaults caps the session's lifetime at maxAge (SESSION_MAX_AGE_CAP)
// and fills in the kind's default resource limits.
func (r *sessionReq) applyDefaults(maxAge time.Duration) {
	if r.MaxAgeS <= 0 || time.Duration(r.MaxAgeS)*time.Second > maxAge {
		r.MaxAgeS = int(maxAge.Seconds())
	}

	def := defaultLimits[r.Kind]
	if r.Limits.MemoryMB <= 0 {
		r.Limits.MemoryMB = def.MemoryMB
	}
	if r.Limits.CPUs <= 0 {
		r.Limits.CPUs = def.CPUs
	}
	if r.Limits.Pids <= 0 {
		r.Limits.Pids = def.Pids
	}
}

// desktopLockedEnv is the part of lockedEnv specific to desktop sessions:
// the LinuxServer/Selkies boot settings the agent pins (user ids, hardened
// desktop, no Docker, no gamepad) and the features a public sandbox must not
// expose: file transfer, microphone, webcam, printing, gamepads, second screen.
var desktopLockedEnv = map[string]string{
	"PUID":                       "1000",
	"PGID":                       "1000",
	"HARDEN_DESKTOP":             "true",
	"START_DOCKER":               "false",
	"NO_GAMEPAD":                 "true",
	"SELKIES_FILE_TRANSFERS":     "none",
	"SELKIES_MICROPHONE_ENABLED": "false|locked",
	"SELKIES_WEBCAM_ENABLED":     "false|locked",
	"SELKIES_PRINTING_ENABLED":   "false|locked",
	"SELKIES_GAMEPAD_ENABLED":    "false|locked",
	"SELKIES_SECOND_SCREEN":      "false|locked",
}

// desktopDefaults are performance defaults a project may override: Selkies
// otherwise sizes the stream to the client screen (near-4K at 60 fps on a
// HiDPI laptop), which saturates a small node with a single visitor.
var desktopDefaults = map[string]string{
	"SELKIES_MANUAL_RESOLUTION": "true|locked",
	"SELKIES_MANUAL_WIDTH":      "1280",
	"SELKIES_MANUAL_HEIGHT":     "720",
	"SELKIES_SCALING_DPI":       "96",
	"SELKIES_USE_CSS_SCALING":   "true|locked",
	"SELKIES_FRAMERATE":         "15-30",
	"SELKIES_AUDIO_ENABLED":     "false|locked",
}

// lockedEnv is set by the agent and can never be overridden by a project:
// it carries the routing contract (the session's base path, SUBFOLDER for
// Selkies) and, for desktops, desktopLockedEnv. Terminals get HOME=/tmp
// because their root filesystem is read-only.
func lockedEnv(r sessionReq) map[string]string {
	base := "/s/" + r.ID
	env := map[string]string{
		"TRYOUT_SESSION_ID": r.ID,
		"TRYOUT_BASE_PATH":  base,
	}

	switch r.Kind {
	case kindTerminal:
		env["HOME"] = "/tmp"
	case kindDesktop:
		maps.Copy(env, desktopLockedEnv)
		env["SUBFOLDER"] = base + "/"
	}
	return env
}

// isReservedEnv reports whether a project may not set the variable k: any
// TRYOUT_ name, and every name lockedEnv sets for either kind. The JSON
// Schema's reserved_env must list the same names (see the tests).
func isReservedEnv(k string) bool {
	if strings.HasPrefix(k, "TRYOUT_") {
		return true
	}

	_, inTerminal := lockedEnv(sessionReq{Kind: kindTerminal})[k]
	_, inDesktop := lockedEnv(sessionReq{Kind: kindDesktop})[k]
	return inTerminal || inDesktop
}

// sessionEnv merges, by increasing priority: kind defaults, project env,
// locked env. The result is sorted for deterministic container specs.
func sessionEnv(r sessionReq) []string {
	merged := map[string]string{}
	if r.Kind == kindDesktop {
		maps.Copy(merged, desktopDefaults)
		merged["TITLE"] = r.Project
	}
	maps.Copy(merged, r.Env)
	maps.Copy(merged, lockedEnv(r))

	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	slices.Sort(out)
	return out
}
