// tryout-agent: the only component that talks to Docker on a sandbox node.
//
// It exposes a small private HTTP API used by the control plane, over mutual
// TLS only (ADR 0015), creates one hardened container + one --internal network per
// session, attaches the gateway to that network, and pushes the route table
// to the gateway. A reconcile loop removes expired/dead sessions and orphans,
// and attaches a recreated gateway again to every running session network.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/pki"
	"github.com/Akinator31/Tryout/apps/node/internal/registryauth"
	"github.com/Akinator31/Tryout/apps/node/internal/spec"
)

const (
	labelSession = "tryout.session"
	labelProject = "tryout.project"
	labelExpires = "tryout.expires"
	labelPort    = "tryout.port"
	labelStrip   = "tryout.strip-prefix"
	namePrefix   = "tryout-s-"
)

var sessionIDRe = regexp.MustCompile(`^[a-z0-9]{26}$`)

type config struct {
	listen           string
	tlsCert          string
	tlsKey           string
	tlsClientCA      string
	dockerHost       string
	profile          string // dev | strict | single-host
	defaultRuntime   string
	allowRunc        bool
	gatewayName      string
	gatewaySocket    string
	gatewayToken     string
	registryAuthFile string // path of a config.json with registry credentials, optional
	maxSessions      int
	maxAge           time.Duration
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadConfig() config {
	maxS, _ := strconv.Atoi(env("MAX_SESSIONS", "10"))
	maxAge, _ := time.ParseDuration(env("SESSION_MAX_AGE_CAP", "2h"))
	return config{
		listen:           env("AGENT_LISTEN", ":7000"),
		tlsCert:          os.Getenv("AGENT_TLS_CERT"),
		tlsKey:           os.Getenv("AGENT_TLS_KEY"),
		tlsClientCA:      os.Getenv("AGENT_TLS_CLIENT_CA"),
		dockerHost:       env("DOCKER_HOST", "unix:///var/run/docker.sock"),
		profile:          env("NODE_PROFILE", "dev"),
		defaultRuntime:   env("DEFAULT_RUNTIME", "runsc"),
		allowRunc:        env("ALLOW_RUNC", "false") == "true",
		gatewayName:      env("GATEWAY_CONTAINER", "tryout-gateway"),
		gatewaySocket:    strings.TrimPrefix(env("GATEWAY_ADMIN_SOCKET", "unix:///run/tryout/gateway.sock"), "unix://"),
		gatewayToken:     os.Getenv("GATEWAY_TOKEN"),
		registryAuthFile: os.Getenv("REGISTRY_AUTH_FILE"),
		maxSessions:      maxS,
		maxAge:           maxAge,
	}
}

type agent struct {
	cfg      config
	docker   *dockerapi.Client
	arch     string
	runtimes map[string]bool
	registry *registryauth.Store // nil: anonymous pulls

	gatewayHTTP *http.Client // over the shared unix socket

	mu         sync.Mutex
	creating   map[string]bool // ids being created: reconciler must not touch them
	destroying map[string]bool // ids being removed through the API: same
}

// ---------- startup checks: the profile is a contract, not a hint ----------

func normArch(a string) string {
	switch a {
	case "x86_64":
		return "amd64"
	case "aarch64":
		return "arm64"
	}
	return a
}

func (a *agent) checkProfile(ctx context.Context) error {
	info, err := a.docker.Info(ctx)
	if err != nil {
		return fmt.Errorf("docker unreachable at %s: %w", a.cfg.dockerHost, err)
	}
	a.arch = normArch(info.Architecture)
	a.runtimes = map[string]bool{}
	for r := range info.Runtimes {
		a.runtimes[r] = true
	}
	rootless := slices.ContainsFunc(info.SecurityOptions, func(s string) bool { return strings.Contains(s, "name=rootless") })
	hasRunsc := a.runtimes["runsc"]

	slog.Info("docker", "arch", a.arch, "runtimes", keys(a.runtimes), "rootless", rootless, "cgroup", info.CgroupVersion)

	switch a.cfg.profile {
	case "dev":
		slog.Warn("PROFILE=dev: NO SECURITY GUARANTEE, do not expose to the internet")
	case "strict":
		if !hasRunsc && !a.cfg.allowRunc {
			return errors.New("profile strict: runtime runsc (gVisor) not installed; install it or set ALLOW_RUNC=true explicitly")
		}
	case "single-host":
		if !rootless {
			return errors.New("profile single-host: DOCKER_HOST must point to a dedicated ROOTLESS daemon, never the main root socket")
		}
		if info.CgroupVersion != "2" {
			return errors.New("profile single-host: cgroup v2 required (otherwise rootless resource limits are silently ignored)")
		}
		if !hasRunsc && !a.cfg.allowRunc {
			return errors.New("profile single-host: runsc (gVisor) required; ALLOW_RUNC=true is a documented, weaker opt-out")
		}
	default:
		return fmt.Errorf("unknown NODE_PROFILE %q", a.cfg.profile)
	}
	if a.cfg.allowRunc && a.cfg.profile != "dev" {
		slog.Warn("ALLOW_RUNC=true: sessions may use runtimes other than gVisor, such as runc on the host kernel")
	}
	if !a.runtimes[a.cfg.defaultRuntime] && (a.cfg.profile == "dev" || a.cfg.allowRunc) {
		slog.Warn("default runtime missing, falling back to runc", "wanted", a.cfg.defaultRuntime)
		a.cfg.defaultRuntime = "runc"
	}
	if !a.runtimes[a.cfg.defaultRuntime] {
		return fmt.Errorf("DEFAULT_RUNTIME %q not available on this daemon", a.cfg.defaultRuntime)
	}
	// Otherwise the agent would start, then refuse every session that uses the default.
	if !a.runtimeAllowed(a.cfg.defaultRuntime) {
		return fmt.Errorf("profile %s: DEFAULT_RUNTIME %q is refused: use runsc, or set ALLOW_RUNC=true explicitly", a.cfg.profile, a.cfg.defaultRuntime)
	}
	return nil
}

// runtimeAllowed is the node profile's runtime rule. Outside dev, only gVisor
// is accepted unless ALLOW_RUNC=true: an allowlist, because the daemon may
// list runc under other names (io.containerd.runc.v2) and any other runtime's
// isolation is unknown to the agent.
func (a *agent) runtimeAllowed(rt string) bool {
	return a.cfg.profile == "dev" || a.cfg.allowRunc || rt == "runsc"
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// ---------- session spec ----------

type limits struct {
	MemoryMB int     `json:"memory_mb"`
	CPUs     float64 `json:"cpus"`
	Pids     int64   `json:"pids"`
}

type sessionReq struct {
	ID          string            `json:"id"`
	Project     string            `json:"project"`
	Image       string            `json:"image"`
	Kind        string            `json:"kind"` // terminal | desktop
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
	switch {
	case !sessionIDRe.MatchString(r.ID):
		return errors.New("invalid id")
	case r.Image == "":
		return errors.New("image required")
	case r.Kind != "terminal" && r.Kind != "desktop":
		return errors.New("kind must be terminal or desktop")
	case r.Port <= 0 || r.Port > 65535:
		return errors.New("invalid port")
	}
	if r.Runtime == "" {
		r.Runtime = a.cfg.defaultRuntime
	}
	if !a.runtimes[r.Runtime] {
		return fmt.Errorf("runtime %q not installed on this node", r.Runtime)
	}
	if !a.runtimeAllowed(r.Runtime) {
		return fmt.Errorf("runtime %q refused by node profile %s: only runsc without ALLOW_RUNC", r.Runtime, a.cfg.profile)
	}
	for k := range r.Env {
		if isReservedEnv(k) {
			return fmt.Errorf("env %s is reserved", k)
		}
	}
	if r.MaxAgeS <= 0 || time.Duration(r.MaxAgeS)*time.Second > a.cfg.maxAge {
		r.MaxAgeS = int(a.cfg.maxAge.Seconds())
	}
	if r.Limits.MemoryMB <= 0 {
		r.Limits.MemoryMB = map[string]int{"terminal": 256, "desktop": 2048}[r.Kind]
	}
	if r.Limits.CPUs <= 0 {
		r.Limits.CPUs = map[string]float64{"terminal": 0.5, "desktop": 1.5}[r.Kind]
	}
	if r.Limits.Pids <= 0 {
		r.Limits.Pids = map[string]int64{"terminal": 128, "desktop": 1024}[r.Kind]
	}
	return nil
}

// Environment policy.
//
// lockedEnv is set by the agent and can never be overridden by a project:
// it carries the routing contract and the features a public sandbox must
// not expose (file transfer, microphone, webcam, printing...).
// desktopDefaults are performance defaults a project may override: Selkies
// otherwise sizes the stream to the client screen (near-4K at 60 fps on a
// HiDPI laptop), which saturates a small node with a single visitor.
func lockedEnv(r sessionReq) map[string]string {
	base := "/s/" + r.ID
	env := map[string]string{
		"TRYOUT_SESSION_ID": r.ID,
		"TRYOUT_BASE_PATH":  base,
	}
	switch r.Kind {
	case "terminal":
		env["HOME"] = "/tmp" // the root filesystem is read-only
	case "desktop":
		for k, v := range map[string]string{
			"PUID": "1000", "PGID": "1000",
			"SUBFOLDER":                  base + "/",
			"HARDEN_DESKTOP":             "true",
			"START_DOCKER":               "false",
			"NO_GAMEPAD":                 "true",
			"SELKIES_FILE_TRANSFERS":     "none",
			"SELKIES_MICROPHONE_ENABLED": "false|locked",
			"SELKIES_WEBCAM_ENABLED":     "false|locked",
			"SELKIES_PRINTING_ENABLED":   "false|locked",
			"SELKIES_GAMEPAD_ENABLED":    "false|locked",
			"SELKIES_SECOND_SCREEN":      "false|locked",
		} {
			env[k] = v
		}
	}
	return env
}

var desktopDefaults = map[string]string{
	"SELKIES_MANUAL_RESOLUTION": "true|locked",
	"SELKIES_MANUAL_WIDTH":      "1280",
	"SELKIES_MANUAL_HEIGHT":     "720",
	"SELKIES_SCALING_DPI":       "96",
	"SELKIES_USE_CSS_SCALING":   "true|locked",
	"SELKIES_FRAMERATE":         "15-30",
	"SELKIES_AUDIO_ENABLED":     "false|locked",
}

func isReservedEnv(k string) bool {
	if strings.HasPrefix(k, "TRYOUT_") {
		return true
	}
	_, inTerminal := lockedEnv(sessionReq{Kind: "terminal"})[k]
	_, inDesktop := lockedEnv(sessionReq{Kind: "desktop"})[k]
	return inTerminal || inDesktop
}

// sessionEnv merges, by increasing priority: kind defaults, project env,
// locked env. The result is sorted for deterministic container specs.
func sessionEnv(r sessionReq) []string {
	merged := map[string]string{}
	if r.Kind == "desktop" {
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

// containerSpec is where the hardening lives. It is NOT configurable by the
// control plane on purpose: only image/kind/limits come from outside.
func (a *agent) containerSpec(r sessionReq, netName string) dockerapi.ContainerCreate {
	envs := sessionEnv(r)
	hc := dockerapi.HostConfig{
		Runtime:     r.Runtime,
		NetworkMode: netName,
		CapDrop:     []string{"ALL"},
		SecurityOpt: []string{"no-new-privileges:true"},
		Memory:      int64(r.Limits.MemoryMB) << 20,
		MemorySwap:  int64(r.Limits.MemoryMB) << 20, // no swap beyond memory
		NanoCpus:    int64(r.Limits.CPUs * 1e9),
		PidsLimit:   r.Limits.Pids,
		LogConfig:   &dockerapi.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "1m", "max-file": "1"}},
	}
	switch r.Kind {
	case "terminal":
		hc.Init = true
		hc.ReadonlyRootfs = true
		hc.Tmpfs = map[string]string{"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"}
	case "desktop":
		// LinuxServer/Selkies images boot as root under s6, chown files and
		// then drop to PUID. Minimal capability set for that boot sequence.
		hc.CapAdd = []string{"CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER", "KILL"}
		hc.ShmSize = 1 << 30
	}
	return dockerapi.ContainerCreate{
		Image:    r.Image,
		Env:      envs,
		Hostname: "tryout",
		Labels: map[string]string{
			labelSession: r.ID,
			labelProject: r.Project,
			labelExpires: strconv.FormatInt(time.Now().Add(time.Duration(r.MaxAgeS)*time.Second).Unix(), 10),
			labelPort:    strconv.Itoa(r.Port),
			labelStrip:   strconv.FormatBool(r.StripPrefix),
		},
		HostConfig: hc,
	}
}

// ---------- lifecycle ----------

func (a *agent) ensureImage(ctx context.Context, ref string) error {
	img, err := a.docker.ImageInspect(ctx, ref)
	if dockerapi.IsNotFound(err) {
		slog.Info("pulling image", "ref", ref)
		if err := a.docker.ImagePull(ctx, ref, a.registry.HeaderFor(ref)); err != nil {
			return err
		}
		img, err = a.docker.ImageInspect(ctx, ref)
	}
	if err != nil {
		return err
	}
	if normArch(img.Architecture) != a.arch {
		return fmt.Errorf("image %s is %s but this node is %s (build a multi-arch image or assign the project to another node)", ref, img.Architecture, a.arch)
	}
	return nil
}

func (a *agent) countSessions(ctx context.Context) (int, error) {
	cs, err := a.docker.ContainerList(ctx, labelSession)
	return len(cs), err
}

func (a *agent) create(ctx context.Context, r sessionReq) error {
	a.mu.Lock()
	if a.creating[r.ID] {
		a.mu.Unlock()
		return errors.New("already creating")
	}
	n, err := a.countSessions(ctx)
	if err == nil && n+len(a.creating) >= a.cfg.maxSessions {
		err = errors.New("node full")
	}
	if err != nil {
		a.mu.Unlock()
		return err
	}
	a.creating[r.ID] = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.creating, r.ID); a.mu.Unlock() }()

	if err := a.ensureImage(ctx, r.Image); err != nil {
		return err
	}
	name := namePrefix + r.ID
	if _, err := a.docker.NetworkCreate(ctx, dockerapi.NetworkCreate{
		Name: name, Driver: "bridge", Internal: true,
		Labels:  map[string]string{labelSession: r.ID},
		Options: map[string]string{"com.docker.network.bridge.enable_icc": "true"},
	}); err != nil {
		return fmt.Errorf("network: %w", err)
	}
	fail := func(err error) error {
		a.destroy(context.WithoutCancel(ctx), r.ID)
		return err
	}
	if _, err := a.docker.ContainerCreate(ctx, name, a.containerSpec(r, name)); err != nil {
		return fail(fmt.Errorf("create: %w", err))
	}
	if err := a.docker.NetworkConnect(ctx, name, a.cfg.gatewayName); err != nil {
		return fail(fmt.Errorf("attach gateway: %w", err))
	}
	if err := a.docker.ContainerStart(ctx, name); err != nil {
		return fail(fmt.Errorf("start: %w", err))
	}
	slog.Info("session started", "id", r.ID, "project", r.Project, "runtime", r.Runtime, "kind", r.Kind)
	a.pushRoutes(ctx)
	return nil
}

func (a *agent) destroy(ctx context.Context, id string) {
	name := namePrefix + id
	if err := a.docker.ContainerRemove(ctx, name); err != nil && !dockerapi.IsNotFound(err) {
		slog.Warn("remove container", "id", id, "err", err)
	}
	if err := a.docker.NetworkDisconnect(ctx, name, a.cfg.gatewayName); err != nil && !dockerapi.IsNotFound(err) {
		slog.Debug("disconnect gateway", "id", id, "err", err)
	}
	if err := a.docker.NetworkRemove(ctx, name); err != nil && !dockerapi.IsNotFound(err) {
		slog.Warn("remove network", "id", id, "err", err)
	}
	slog.Info("session destroyed", "id", id)
}

type route struct {
	ID          string `json:"id"`
	Target      string `json:"target"`
	StripPrefix bool   `json:"strip_prefix"`
}

func (a *agent) pushRoutes(ctx context.Context) {
	cs, err := a.docker.ContainerList(ctx, labelSession)
	if err != nil {
		slog.Warn("list for routes", "err", err)
		return
	}
	routes := []route{}
	for _, c := range cs {
		if c.State != "running" {
			continue
		}
		id := c.Labels[labelSession]
		routes = append(routes, route{
			ID:          id,
			Target:      fmt.Sprintf("http://%s%s:%s", namePrefix, id, c.Labels[labelPort]),
			StripPrefix: c.Labels[labelStrip] == "true",
		})
	}
	b, _ := json.Marshal(routes)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPut, "http://gateway/routes", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+a.cfg.gatewayToken)
	resp, err := a.gatewayHTTP.Do(req)
	if err != nil {
		slog.Warn("push routes", "err", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		slog.Warn("push routes", "status", resp.StatusCode)
	}
}

// reconcile: Docker labels are the source of truth on the node.
func (a *agent) reconcile(ctx context.Context) {
	a.mu.Lock()
	busy := map[string]bool{}
	for id := range a.creating {
		busy[id] = true
	}
	for id := range a.destroying {
		busy[id] = true
	}
	a.mu.Unlock()

	cs, err := a.docker.ContainerList(ctx, labelSession)
	if err != nil {
		slog.Warn("reconcile list", "err", err)
		return
	}
	now := time.Now().Unix()
	live := map[string]bool{}
	var running []string
	for _, c := range cs {
		id := c.Labels[labelSession]
		if busy[id] {
			live[id] = true
			continue
		}
		exp, _ := strconv.ParseInt(c.Labels[labelExpires], 10, 64)
		if exp < now || (c.State != "running" && c.State != "created") {
			slog.Info("reaping", "id", id, "state", c.State, "expired", exp < now)
			a.destroy(ctx, id)
			continue
		}
		live[id] = true
		if c.State == "running" {
			running = append(running, id)
		}
	}
	nets, err := a.docker.NetworkList(ctx, labelSession)
	if err == nil {
		for _, n := range nets {
			if id := n.Labels[labelSession]; !live[id] && !busy[id] {
				slog.Info("removing orphan network", "name", n.Name)
				a.destroy(ctx, id)
			}
		}
	}
	a.reattachGateway(ctx, running)
	a.pushRoutes(ctx)
}

// reattachGateway attaches the gateway to the network of every running session
// it is missing from. A recreated gateway container (an upgrade, a manual
// `docker compose up`) keeps its name but loses the networks the agent
// connected it to, which would leave running sessions unreachable.
//
// Sessions being created are skipped (create attaches the gateway itself), and
// so are sessions being removed through the API: the check and the connect
// happen under the lock remove takes, so a reattachment never lands between
// destroy's disconnect and its network removal.
func (a *agent) reattachGateway(ctx context.Context, running []string) {
	gw, err := a.docker.ContainerInspect(ctx, a.cfg.gatewayName)
	if err != nil {
		slog.Warn("inspect gateway", "name", a.cfg.gatewayName, "err", err)
		return
	}
	for _, id := range running {
		name := namePrefix + id
		if _, ok := gw.NetworkSettings.Networks[name]; ok {
			continue
		}
		if !sessionIDRe.MatchString(id) { // a label, not an id the agent made
			slog.Warn("reattach gateway: invalid session label", "id", id)
			continue
		}
		a.mu.Lock()
		if !a.creating[id] && !a.destroying[id] {
			if err := a.docker.NetworkConnect(ctx, name, a.cfg.gatewayName); err != nil {
				slog.Warn("reattach gateway", "id", id, "err", err)
			} else {
				slog.Info("gateway reattached", "id", id)
			}
		}
		a.mu.Unlock()
	}
}

// remove destroys a session on the control plane's request. The id is marked
// so that the reconcile loop leaves it alone meanwhile.
func (a *agent) remove(ctx context.Context, id string) {
	a.mu.Lock()
	a.destroying[id] = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.destroying, id); a.mu.Unlock() }()
	a.destroy(ctx, id)
}

// ---------- HTTP API ----------

// serverTLS loads the listener's mutual TLS configuration and refuses an
// expired certificate. There is no plain-HTTP mode: the TLS handshake is the
// API's only authentication.
func serverTLS(cfg config, now time.Time) (*tls.Config, []*x509.Certificate, error) {
	var missing []string
	for k, v := range map[string]string{"AGENT_TLS_CERT": cfg.tlsCert, "AGENT_TLS_KEY": cfg.tlsKey, "AGENT_TLS_CLIENT_CA": cfg.tlsClientCA} {
		if v == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return nil, nil, fmt.Errorf("%s required (mutual TLS, see docs/certificates.md)", strings.Join(missing, ", "))
	}
	tlsCfg, certs, err := pki.ServerConfig(cfg.tlsCert, cfg.tlsKey, cfg.tlsClientCA)
	if err != nil {
		return nil, nil, err
	}
	for _, c := range certs {
		if w := pki.Expiry(c, now, 0); w != "" {
			return nil, nil, errors.New(w)
		}
	}
	return tlsCfg, certs, nil
}

// warnExpiry logs certificates that are expired or close to expiry. Rotation
// is a restart with new files (ADR 0015).
func warnExpiry(certs []*x509.Certificate, now time.Time) {
	for _, c := range certs {
		if w := pki.Expiry(c, now, pki.ExpiryWarning); w != "" {
			slog.Warn(w)
		}
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (a *agent) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "profile": a.cfg.profile, "arch": a.arch, "runtimes": keys(a.runtimes)})
	})
	mux.HandleFunc("POST /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		req, err := a.parseSessionReq(body)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": err.Error()})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute) // first pull can be long
		defer cancel()
		if err := a.create(ctx, req); err != nil {
			slog.Warn("create failed", "id", req.ID, "err", err)
			writeJSON(w, 409, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 201, map[string]string{"id": req.ID})
	})
	mux.HandleFunc("DELETE /v1/sessions/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !sessionIDRe.MatchString(id) {
			http.Error(w, "bad id", 400)
			return
		}
		a.remove(r.Context(), id)
		a.pushRoutes(r.Context())
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /v1/sessions", func(w http.ResponseWriter, r *http.Request) {
		cs, err := a.docker.ContainerList(r.Context(), labelSession)
		if err != nil {
			writeJSON(w, 502, map[string]string{"error": err.Error()})
			return
		}
		out := []map[string]string{}
		for _, c := range cs {
			out = append(out, map[string]string{"id": c.Labels[labelSession], "project": c.Labels[labelProject], "state": c.State})
		}
		writeJSON(w, 200, out)
	})
	return mux
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	cfg := loadConfig()
	if cfg.gatewayToken == "" {
		slog.Error("GATEWAY_TOKEN required")
		os.Exit(1)
	}
	tlsCfg, certs, err := serverTLS(cfg, time.Now())
	if err != nil {
		slog.Error("refusing to start", "err", err)
		os.Exit(1)
	}
	warnExpiry(certs, time.Now())
	dc, err := dockerapi.New(cfg.dockerHost)
	if err != nil {
		slog.Error("docker client", "err", err)
		os.Exit(1)
	}
	a := &agent{cfg: cfg, docker: dc, creating: map[string]bool{}, destroying: map[string]bool{}}
	if cfg.registryAuthFile != "" {
		if a.registry, err = registryauth.Load(cfg.registryAuthFile); err != nil {
			slog.Error("refusing to start: REGISTRY_AUTH_FILE", "err", err)
			os.Exit(1)
		}
		slog.Info("registry credentials loaded", "registries", a.registry.Registries())
	}
	a.gatewayHTTP = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", cfg.gatewaySocket)
		}}}
	ctx := context.Background()
	if err := a.checkProfile(ctx); err != nil {
		slog.Error("refusing to start", "err", err)
		os.Exit(1)
	}
	go func() {
		for {
			a.reconcile(ctx)
			time.Sleep(10 * time.Second)
		}
	}()
	go func() {
		for range time.Tick(24 * time.Hour) {
			warnExpiry(certs, time.Now())
		}
	}()
	srv := &http.Server{Addr: cfg.listen, Handler: a.routes(), TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	slog.Info("agent listening (mutual TLS)", "addr", cfg.listen, "profile", cfg.profile, "default_runtime", a.cfg.defaultRuntime)
	if err := srv.ListenAndServeTLS("", ""); err != nil {
		slog.Error("server", "err", err)
		os.Exit(1)
	}
}
