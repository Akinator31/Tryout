// Package session turns a request of the control plane into the hardened
// container that runs it. It is the node's security policy, and it is pure:
// it never calls Docker.
//
//	Parse  checks a POST /v1/sessions body against the shared JSON Schema,
//	       then the node's Policy (runtime allowlist, lifetime cap, reserved
//	       environment), and fills in the defaults;
//	Spec   builds the container: the hard-coded hardening, the locked
//	       environment and the labels the agent reads back.
//
// Files of this package: request.go (the request and the policy), schema.go
// (the JSON Schema check), env.go (the container environment), hardening.go
// (the container specification and its labels), ttyd.go (the agent's web
// terminal).
package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"
)

// idRe matches the ids the control plane generates. Ids end up in container
// and network names and in the gateway's /s/<id>/ paths.
var idRe = regexp.MustCompile(`^[a-z0-9]{26}$`)

// ValidID reports whether id has the shape of a session id.
func ValidID(id string) bool {
	return idRe.MatchString(id)
}

// Kind is what a session serves: a web terminal (ttyd) or a streamed desktop
// (Selkies). The kind selects the hardening variant, the locked environment
// and the default limits.
type Kind string

const (
	Terminal Kind = "terminal"
	Desktop  Kind = "desktop"
)

// Limits are a session's resource limits. Zero means the kind's default.
type Limits struct {
	MemoryMB int     `json:"memory_mb"`
	CPUs     float64 `json:"cpus"`
	Pids     int64   `json:"pids"`
}

// defaultLimits are the resource limits of each session kind, used for the
// fields a request leaves at zero.
var defaultLimits = map[Kind]Limits{
	Terminal: {MemoryMB: 256, CPUs: 0.5, Pids: 128},
	Desktop:  {MemoryMB: 2048, CPUs: 1.5, Pids: 1024},
}

// Request is the body of POST /v1/sessions, once Parse has applied the
// node's policy and defaults.
type Request struct {
	ID          string            `json:"id"`
	Project     string            `json:"project"`
	Image       string            `json:"image"`
	Kind        Kind              `json:"kind"`
	TTYD        TTYDMode          `json:"ttyd,omitempty"`
	Command     []string          `json:"command,omitempty"`
	Port        int               `json:"port"`
	Runtime     string            `json:"runtime,omitempty"`
	MaxAgeS     int               `json:"max_age_s"`
	StripPrefix bool              `json:"strip_prefix,omitempty"`
	Env         map[string]string `json:"env,omitempty"`
	Limits      Limits            `json:"limits"`
	GPU         bool              `json:"gpu,omitempty"`

	ttydImage  string   // Policy.TTYDImage, for a terminal with the agent's ttyd
	gpuDevices []string // Policy.GPUDevices, for a session with gpu
}

// Policy is what the node allows, settled at startup from its profile and
// its Docker daemon.
type Policy struct {
	Profile        string          // dev | strict | single-host
	AllowRunc      bool            // ALLOW_RUNC: any installed runtime outside dev
	DefaultRuntime string          // for requests that name none
	Runtimes       map[string]bool // installed on the daemon
	MaxAge         time.Duration   // SESSION_MAX_AGE_CAP
	TTYDImage      string          // TTYD_IMAGE: mounted into terminals with the agent's ttyd
	GPUDevices     []string        // GPU_DEVICES: CDI device names given to GPU sessions
}

// RuntimeAllowed is the node profile's runtime rule. Outside dev, only gVisor
// is accepted unless ALLOW_RUNC=true: an allowlist, because the daemon may
// list runc under other names (io.containerd.runc.v2) and any other runtime's
// isolation is unknown to the agent.
func (p Policy) RuntimeAllowed(rt string) bool {
	return p.Profile == "dev" || p.AllowRunc || rt == "runsc"
}

// Parse checks body against the shared JSON Schema (the same file the
// control plane validates its configuration with), then applies the node's
// policy and defaults.
func Parse(body []byte, p Policy) (Request, error) {
	var r Request
	if err := validateSchema(body); err != nil {
		return r, err
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return r, err
	}
	return r, r.validate(p)
}

// validate re-checks the fields the hardening depends on (defence in depth,
// the schema already covers them), then applies the node policy and defaults.
func (r *Request) validate(p Policy) error {
	if err := r.checkShape(); err != nil {
		return err
	}
	if err := r.applyTTYDMode(p.TTYDImage); err != nil {
		return err
	}
	if err := r.applyRuntimePolicy(p); err != nil {
		return err
	}
	if err := r.applyGPUPolicy(p); err != nil {
		return err
	}
	if err := r.checkEnv(); err != nil {
		return err
	}

	r.applyDefaults(p.MaxAge)
	return nil
}

// checkShape checks the fields that name things or reach the container spec.
func (r *Request) checkShape() error {
	switch {
	case !ValidID(r.ID):
		return errors.New("invalid id")
	case r.Image == "":
		return errors.New("image required")
	case r.Kind != Terminal && r.Kind != Desktop:
		return errors.New("kind must be terminal or desktop")
	case r.Port < 0 || r.Port > 65535:
		return errors.New("invalid port")
	}
	return nil
}

// applyTTYDMode settles who serves the session's page. A terminal runs in
// the agent's ttyd when it says ttyd: agent, or sets neither ttyd nor a port;
// ttyd then listens on ttydPort and serves under the base path itself, so the
// request must not set a port or strip_prefix. A terminal with a port and no
// ttyd serves its own page, as every terminal did before the agent's ttyd.
// Any session that serves its own page runs the image as it is.
func (r *Request) applyTTYDMode(ttydImage string) error {
	if r.Kind == Terminal && r.TTYD == "" {
		r.TTYD = TTYDAgent
		if r.Port != 0 {
			r.TTYD = TTYDImage
		}
	}

	switch {
	case r.Kind == Desktop && r.TTYD != "":
		return errors.New("ttyd is a terminal setting")
	case r.TTYD != "" && r.TTYD != TTYDAgent && r.TTYD != TTYDImage:
		return errors.New("ttyd must be agent or image")
	case r.TTYD != TTYDAgent && len(r.Command) > 0:
		return errors.New("command needs the agent's ttyd")
	case r.TTYD != TTYDAgent && r.Port == 0:
		return errors.New("port required")
	case r.TTYD == TTYDAgent && (r.Port != 0 || r.StripPrefix):
		return errors.New("port and strip_prefix are not allowed with the agent's ttyd")
	case r.TTYD == TTYDAgent && ttydImage == "":
		return errors.New("this node has no ttyd image")
	}

	if r.TTYD == TTYDAgent {
		r.Port = ttydPort
		r.ttydImage = ttydImage
	}
	return nil
}

// applyRuntimePolicy fills in the default runtime, then refuses a runtime the
// daemon does not have or the node profile does not allow.
func (r *Request) applyRuntimePolicy(p Policy) error {
	if r.Runtime == "" {
		r.Runtime = p.DefaultRuntime
	}

	if !p.Runtimes[r.Runtime] {
		return fmt.Errorf("runtime %q not installed on this node", r.Runtime)
	}
	if !p.RuntimeAllowed(r.Runtime) {
		return fmt.Errorf("runtime %q refused by node profile %s: only runsc without ALLOW_RUNC", r.Runtime, p.Profile)
	}
	return nil
}

// applyGPUPolicy gives a desktop that asks for a GPU the node's CDI devices.
// It runs after applyRuntimePolicy, so the runtime is settled: a GPU is only
// given under runsc, whatever the profile or ALLOW_RUNC, because gVisor's
// nvproxy is what filters the driver calls. Under runc the visitor would
// reach the whole NVIDIA kernel driver.
func (r *Request) applyGPUPolicy(p Policy) error {
	if !r.GPU {
		return nil
	}

	switch {
	case r.Kind != Desktop:
		return errors.New("gpu is a desktop setting")
	case len(p.GPUDevices) == 0:
		return errors.New("this node has no GPU")
	case r.Runtime != "runsc":
		return fmt.Errorf("gpu needs runtime runsc (gVisor nvproxy), not %q", r.Runtime)
	}

	r.gpuDevices = p.GPUDevices
	return nil
}

// checkEnv refuses a project variable that the agent sets itself.
func (r *Request) checkEnv() error {
	for k := range r.Env {
		if isReservedEnv(k) {
			return fmt.Errorf("env %s is reserved", k)
		}
	}
	return nil
}

// applyDefaults caps the session's lifetime at maxAge (SESSION_MAX_AGE_CAP)
// and fills in the kind's default resource limits.
func (r *Request) applyDefaults(maxAge time.Duration) {
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
