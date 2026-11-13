package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/pki"
	"github.com/Akinator31/Tryout/apps/node/internal/registryauth"
	"github.com/Akinator31/Tryout/apps/node/internal/spec"
)

func testAgent(profile string, allowRunc bool) *agent {
	return &agent{
		cfg: config{
			profile: profile, allowRunc: allowRunc, defaultRuntime: "runsc",
			maxAge: 3600e9,
		},
		runtimes: map[string]bool{"runc": true, "runsc": true},
	}
}

func validReq(kind string) sessionReq {
	return sessionReq{ID: strings.Repeat("a", 26), Project: "p", Image: "img", Kind: kind, Port: 3000}
}

func envMap(r sessionReq) map[string]string {
	m := map[string]string{}
	for _, kv := range sessionEnv(r) {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

func TestValidateDefaultsAndRuntimePolicy(t *testing.T) {
	r := validReq("desktop")
	if err := r.validate(testAgent("strict", false)); err != nil {
		t.Fatal(err)
	}
	if r.Runtime != "runsc" || r.Limits.MemoryMB != 2048 || r.MaxAgeS != 3600 {
		t.Errorf("defaults not applied: %+v", r)
	}

	r = validReq("terminal")
	r.Runtime = "runc"
	if err := r.validate(testAgent("strict", false)); err == nil {
		t.Error("runc must be refused by profile strict without ALLOW_RUNC")
	}
	r.Runtime = "runc"
	if err := r.validate(testAgent("strict", true)); err != nil {
		t.Errorf("runc must be allowed with ALLOW_RUNC: %v", err)
	}

	// Outside dev, only gVisor passes without ALLOW_RUNC, whatever name the
	// daemon gives its other runtimes (Docker lists runc as io.containerd.runc.v2 too).
	for _, profile := range []string{"strict", "single-host"} {
		for _, rt := range []string{"runc", "io.containerd.runc.v2", "kata"} {
			a := testAgent(profile, false)
			a.runtimes[rt] = true
			r := validReq("terminal")
			r.Runtime = rt
			if err := r.validate(a); err == nil {
				t.Errorf("profile %s must refuse runtime %s without ALLOW_RUNC", profile, rt)
			}
			a.cfg.allowRunc = true
			if err := r.validate(a); err != nil {
				t.Errorf("profile %s must allow runtime %s with ALLOW_RUNC: %v", profile, rt, err)
			}
		}
	}
	r = validReq("terminal")
	r.Runtime = "io.containerd.runc.v2"
	dev := testAgent("dev", false)
	dev.runtimes["io.containerd.runc.v2"] = true
	if err := r.validate(dev); err != nil {
		t.Errorf("profile dev allows any installed runtime: %v", err)
	}

	for _, bad := range []func(*sessionReq){
		func(r *sessionReq) { r.ID = "../etc" },
		func(r *sessionReq) { r.Kind = "vm" },
		func(r *sessionReq) { r.Port = 0 },
		func(r *sessionReq) { r.Env = map[string]string{"SUBFOLDER": "/"} },
		func(r *sessionReq) { r.Env = map[string]string{"SELKIES_FILE_TRANSFERS": "upload,download"} },
		func(r *sessionReq) { r.Env = map[string]string{"TRYOUT_BASE_PATH": "/"} },
	} {
		r := validReq("desktop")
		bad(&r)
		if err := r.validate(testAgent("dev", false)); err == nil {
			t.Errorf("expected rejection for %+v", r)
		}
	}
}

func TestSessionEnvPrecedence(t *testing.T) {
	r := validReq("desktop")
	r.Env = map[string]string{"SELKIES_MANUAL_WIDTH": "1920", "APP_MODE": "demo"}
	m := envMap(r)
	if m["SELKIES_MANUAL_WIDTH"] != "1920" || m["APP_MODE"] != "demo" {
		t.Errorf("project env must override performance defaults: %v", m)
	}
	if m["SELKIES_MANUAL_HEIGHT"] != "720" || m["SELKIES_FRAMERATE"] != "15-30" {
		t.Errorf("performance defaults missing: %v", m)
	}
	if m["SELKIES_FILE_TRANSFERS"] != "none" || m["SUBFOLDER"] != "/s/"+r.ID+"/" {
		t.Errorf("locked env missing: %v", m)
	}

	m = envMap(validReq("terminal"))
	if m["HOME"] != "/tmp" || m["TRYOUT_BASE_PATH"] != "/s/"+strings.Repeat("a", 26) {
		t.Errorf("terminal env: %v", m)
	}
	if _, ok := m["SELKIES_FRAMERATE"]; ok {
		t.Error("desktop defaults must not leak into terminal sessions")
	}
}

func TestContainerSpecHardening(t *testing.T) {
	a := testAgent("strict", false)
	for _, kind := range []string{"terminal", "desktop"} {
		r := validReq(kind)
		if err := r.validate(a); err != nil {
			t.Fatal(err)
		}
		hc := a.containerSpec(r, "net").HostConfig
		if !slices.Equal(hc.CapDrop, []string{"ALL"}) || hc.Privileged {
			t.Errorf("%s: capabilities not dropped", kind)
		}
		if !slices.Contains(hc.SecurityOpt, "no-new-privileges:true") {
			t.Errorf("%s: no-new-privileges missing", kind)
		}
		if hc.Memory == 0 || hc.MemorySwap != hc.Memory || hc.NanoCpus == 0 || hc.PidsLimit == 0 {
			t.Errorf("%s: resource limits missing: %+v", kind, hc)
		}
		if hc.NetworkMode != "net" || hc.Runtime != "runsc" {
			t.Errorf("%s: network/runtime: %+v", kind, hc)
		}
		if slices.Contains(hc.CapAdd, "SYS_ADMIN") || slices.Contains(hc.CapAdd, "SYS_PTRACE") || slices.Contains(hc.CapAdd, "NET_ADMIN") {
			t.Errorf("%s: dangerous capability added: %v", kind, hc.CapAdd)
		}
	}
	term := validReq("terminal")
	_ = term.validate(a)
	if !a.containerSpec(term, "net").HostConfig.ReadonlyRootfs {
		t.Error("terminal sessions must have a read-only rootfs")
	}
}

func TestParseSessionReqUsesSchema(t *testing.T) {
	a := testAgent("dev", false)
	ok := `{"id":"` + strings.Repeat("a", 26) + `","project":"p","image":"img","kind":"terminal","port":7681,"max_age_s":60}`
	r, err := a.parseSessionReq([]byte(ok))
	if err != nil {
		t.Fatal(err)
	}
	if r.Runtime != "runsc" || r.Limits.Pids != 128 {
		t.Errorf("policy defaults not applied: %+v", r)
	}
	unknown := strings.Replace(ok, `"port":7681`, `"port":7681,"privileged":true`, 1)
	if _, err := a.parseSessionReq([]byte(unknown)); err == nil || !strings.Contains(err.Error(), "/privileged") {
		t.Errorf("unknown field must be rejected by the schema: %v", err)
	}
}

// The schema's reserved names must be exactly what the agent locks, or the
// control plane would accept a configuration the agent then refuses (or the
// reverse).
func TestSchemaReservedEnvMatchesLockedEnv(t *testing.T) {
	names, prefixes := spec.ReservedEnv()
	if !slices.Equal(prefixes, []string{"TRYOUT_"}) {
		t.Errorf("reserved prefixes: %v", prefixes)
	}
	want := map[string]bool{}
	for _, kind := range []string{"terminal", "desktop"} {
		for k := range lockedEnv(sessionReq{Kind: kind}) {
			if !strings.HasPrefix(k, "TRYOUT_") {
				want[k] = true
			}
		}
	}
	got := map[string]bool{}
	for _, n := range names {
		got[n] = true
		if !isReservedEnv(n) {
			t.Errorf("schema reserves %s but the agent does not lock it", n)
		}
	}
	for k := range want {
		if !got[k] {
			t.Errorf("agent locks %s but the schema does not reserve it", k)
		}
	}
}

func TestServerTLSIsRequired(t *testing.T) {
	_, _, err := serverTLS(config{tlsCert: "/x/tls.crt"}, time.Now())
	if err == nil || !strings.Contains(err.Error(), "AGENT_TLS_CLIENT_CA, AGENT_TLS_KEY required") {
		t.Errorf("missing variables: %v", err)
	}
	if _, _, err := serverTLS(config{tlsCert: "/nope/tls.crt", tlsKey: "/nope/tls.key", tlsClientCA: "/nope/ca.crt"}, time.Now()); err == nil {
		t.Error("unreadable files accepted")
	}
}

// The API is served over mutual TLS only: no client certificate, no request.
func TestAPIOverMutualTLS(t *testing.T) {
	dir := t.TempDir()
	ca, _ := pki.NewCA("ca", time.Now(), pki.CAValidity)
	srv, _ := ca.Issue(pki.ServerAuth, "agent", []string{"127.0.0.1"}, time.Now(), pki.LeafValidity)
	cli, _ := ca.Issue(pki.ClientAuth, "cp", nil, time.Now(), pki.LeafValidity)
	write := func(name string, b []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, b, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	files := config{
		tlsCert: write("tls.crt", srv.CertPEM), tlsKey: write("tls.key", srv.KeyPEM), tlsClientCA: write("ca.crt", ca.CertPEM),
	}
	if _, _, err := serverTLS(files, time.Now().Add(pki.LeafValidity+time.Hour)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("expired certificate: %v", err)
	}
	cfg, _, err := serverTLS(files, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	a := testAgent("dev", false)
	ts := httptest.NewUnstartedServer(a.routes())
	ts.TLS = cfg
	ts.Config.ErrorLog = log.New(io.Discard, "", 0)
	ts.StartTLS()
	defer ts.Close()

	roots := x509.NewCertPool()
	roots.AddCert(ca.Cert)
	get := func(certs []tls.Certificate) (*http.Response, error) {
		c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, Certificates: certs}}}
		return c.Get(ts.URL + "/healthz")
	}
	if _, err := get(nil); err == nil {
		t.Error("request without a client certificate reached the API")
	}
	resp, err := get([]tls.Certificate{{Certificate: [][]byte{cli.Cert.Raw}, PrivateKey: cli.Key}})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status %d", resp.StatusCode)
	}
}

// fakeDocker answers GET /info like a daemon with the given runtimes.
func fakeDocker(t *testing.T, runtimes ...string) *dockerapi.Client {
	t.Helper()
	rts := map[string]any{}
	for _, r := range runtimes {
		rts[r] = map[string]any{"path": r}
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/info") {
			http.NotFound(w, r)
			return
		}
		if err := json.NewEncoder(w).Encode(map[string]any{"Architecture": "x86_64", "Runtimes": rts, "CgroupVersion": "2"}); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(srv.Close)
	c, err := dockerapi.New("tcp://" + srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestCheckProfileDefaultRuntime(t *testing.T) {
	all := []string{"io.containerd.runc.v2", "runc", "runsc"}
	noGVisor := []string{"io.containerd.runc.v2", "runc"}
	onlyShim := []string{"io.containerd.runc.v2"}
	cases := []struct {
		profile, def string
		allowRunc    bool
		installed    []string
		wantErr      string // "" = starts
	}{
		{"strict", "runsc", false, all, ""},
		{"strict", "runc", false, all, `DEFAULT_RUNTIME "runc" is refused`},
		{"strict", "io.containerd.runc.v2", false, all, `DEFAULT_RUNTIME "io.containerd.runc.v2" is refused`},
		{"strict", "runc", true, all, ""},
		{"strict", "runsc", false, noGVisor, "runsc (gVisor) not installed"},
		{"strict", "runsc", true, noGVisor, ""}, // falls back to runc
		{"strict", "runsc", true, onlyShim, "not available"},
		{"dev", "runc", false, all, ""},
		{"dev", "runsc", false, noGVisor, ""}, // falls back to runc
		{"dev", "runsc", false, onlyShim, "not available"},
	}
	for _, c := range cases {
		a := &agent{
			cfg:    config{profile: c.profile, defaultRuntime: c.def, allowRunc: c.allowRunc},
			docker: fakeDocker(t, c.installed...),
		}
		err := a.checkProfile(context.Background())
		name := fmt.Sprintf("profile %s, DEFAULT_RUNTIME %s, ALLOW_RUNC %v, runtimes %v", c.profile, c.def, c.allowRunc, c.installed)
		switch {
		case c.wantErr == "" && err != nil:
			t.Errorf("%s: want start, got %v", name, err)
		case c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)):
			t.Errorf("%s: want error containing %q, got %v", name, c.wantErr, err)
		}
	}
}

// TestEnsureImageSendsRegistryAuth checks that a missing image is pulled with
// the credentials of its registry, and only of its registry.
func TestEnsureImageSendsRegistryAuth(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "config.json")
	cred := base64.StdEncoding.EncodeToString([]byte("bot:token"))
	if err := os.WriteFile(cfgPath, []byte(`{"auths":{"ghcr.io":{"auth":"`+cred+`"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := registryauth.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	for ref, wantUser := range map[string]string{"ghcr.io/owner/app:edge": "bot", "quay.io/other/app:1": ""} {
		t.Run(ref, func(t *testing.T) {
			var mu sync.Mutex
			pulled, gotAuth := false, ""
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch {
				case strings.HasSuffix(r.URL.Path, "/images/create"):
					pulled, gotAuth = true, r.Header.Get("X-Registry-Auth")
					_, _ = w.Write([]byte(`{"status":"done"}`))
				case strings.HasSuffix(r.URL.Path, "/json") && pulled:
					_, _ = w.Write([]byte(`{"Id":"sha256:x","Architecture":"amd64","Os":"linux"}`))
				default:
					http.Error(w, `{"message":"no such image"}`, http.StatusNotFound)
				}
			}))
			t.Cleanup(srv.Close)
			dc, err := dockerapi.New("tcp://" + srv.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			a := &agent{docker: dc, arch: "amd64", registry: store}
			if err := a.ensureImage(context.Background(), ref); err != nil {
				t.Fatalf("%s: %v", ref, err)
			}
			if wantUser == "" {
				if gotAuth != "" {
					t.Errorf("%s: credentials sent to the wrong registry", ref)
				}
				return
			}
			raw, err := base64.URLEncoding.DecodeString(gotAuth)
			if err != nil {
				t.Fatalf("%s: X-Registry-Auth %q: %v", ref, gotAuth, err)
			}
			var ac map[string]string
			if err := json.Unmarshal(raw, &ac); err != nil || ac["username"] != wantUser || ac["password"] != "token" {
				t.Errorf("%s: X-Registry-Auth = %s (%v)", ref, raw, err)
			}
		})
	}
}
