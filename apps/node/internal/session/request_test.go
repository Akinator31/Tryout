package session

import (
	"slices"
	"strings"
	"testing"
)

// testPolicy returns the policy of a node with runc and runsc installed.
func testPolicy(profile string, allowRunc bool) Policy {
	return Policy{
		Profile:        profile,
		AllowRunc:      allowRunc,
		DefaultRuntime: "runsc",
		Runtimes:       map[string]bool{"runc": true, "runsc": true},
		MaxAge:         3600e9,
		TTYDImage:      "ttyd@sha256:0123",
	}
}

// validReq returns a minimal valid request of the given kind: a desktop on
// port 3000, a terminal in the agent's ttyd.
func validReq(kind Kind) Request {
	r := Request{ID: strings.Repeat("a", 26), Project: "p", Image: "img", Kind: kind}
	if kind == Desktop {
		r.Port = 3000
	}
	return r
}

// envMap returns the session's container environment as a map.
func envMap(r Request) map[string]string {
	m := map[string]string{}
	for _, kv := range containerEnv(r) {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

// TestValidateAppliesDefaults checks the default runtime, limits and lifetime.
func TestValidateAppliesDefaults(t *testing.T) {
	r := validReq(Desktop)
	if err := r.validate(testPolicy("strict", false)); err != nil {
		t.Fatal(err)
	}

	if r.Runtime != "runsc" || r.Limits.MemoryMB != 2048 || r.MaxAgeS != 3600 {
		t.Errorf("defaults not applied: %+v", r)
	}
}

// TestValidateRuntimePolicy checks the node profile's runtime allowlist:
// outside dev, only gVisor passes without ALLOW_RUNC, whatever name the
// daemon gives its other runtimes (Docker lists runc as
// io.containerd.runc.v2 too).
func TestValidateRuntimePolicy(t *testing.T) {
	r := validReq(Terminal)
	r.Runtime = "runc"
	if err := r.validate(testPolicy("strict", false)); err == nil {
		t.Error("runc must be refused by profile strict without ALLOW_RUNC")
	}

	r = validReq(Terminal)
	r.Runtime = "runc"
	if err := r.validate(testPolicy("strict", true)); err != nil {
		t.Errorf("runc must be allowed with ALLOW_RUNC: %v", err)
	}

	for _, profile := range []string{"strict", "single-host"} {
		for _, rt := range []string{"runc", "io.containerd.runc.v2", "kata"} {
			p := testPolicy(profile, false)
			p.Runtimes[rt] = true
			r := validReq(Terminal)
			r.Runtime = rt

			if err := r.validate(p); err == nil {
				t.Errorf("profile %s must refuse runtime %s without ALLOW_RUNC", profile, rt)
			}

			p.AllowRunc = true
			r = validReq(Terminal)
			r.Runtime = rt
			if err := r.validate(p); err != nil {
				t.Errorf("profile %s must allow runtime %s with ALLOW_RUNC: %v", profile, rt, err)
			}
		}
	}

	r = validReq(Terminal)
	r.Runtime = "io.containerd.runc.v2"
	dev := testPolicy("dev", false)
	dev.Runtimes["io.containerd.runc.v2"] = true
	if err := r.validate(dev); err != nil {
		t.Errorf("profile dev allows any installed runtime: %v", err)
	}
}

// TestValidateRejectsBadRequests checks the fields the hardening depends on
// and the reserved environment variables.
func TestValidateRejectsBadRequests(t *testing.T) {
	for _, bad := range []func(*Request){
		func(r *Request) { r.ID = "../etc" },
		func(r *Request) { r.Kind = "vm" },
		func(r *Request) { r.Port = 0 },
		func(r *Request) { r.Env = map[string]string{"SUBFOLDER": "/"} },
		func(r *Request) { r.Env = map[string]string{"SELKIES_FILE_TRANSFERS": "upload,download"} },
		func(r *Request) { r.Env = map[string]string{"TRYOUT_BASE_PATH": "/"} },
	} {
		r := validReq(Desktop)
		bad(&r)

		if err := r.validate(testPolicy("dev", false)); err == nil {
			t.Errorf("expected rejection for %+v", r)
		}
	}
}

// TestContainerEnvPrecedence checks the merge order: kind defaults, then
// project env, then locked env.
func TestContainerEnvPrecedence(t *testing.T) {
	r := validReq(Desktop)
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

	m = envMap(validReq(Terminal))
	if m["HOME"] != "/tmp" || m["TRYOUT_BASE_PATH"] != "/s/"+strings.Repeat("a", 26) {
		t.Errorf("terminal env: %v", m)
	}
	if _, ok := m["SELKIES_FRAMERATE"]; ok {
		t.Error("desktop defaults must not leak into terminal sessions")
	}
}

// TestParseUsesSchema checks that the body goes through the shared JSON
// Schema (an unknown field is refused) before the node policy.
func TestParseUsesSchema(t *testing.T) {
	p := testPolicy("dev", false)
	ok := `{"id":"` + strings.Repeat("a", 26) + `","project":"p","image":"img","kind":"terminal","max_age_s":60}`

	r, err := Parse([]byte(ok), p)
	if err != nil {
		t.Fatal(err)
	}
	if r.Runtime != "runsc" || r.Limits.Pids != 128 {
		t.Errorf("policy defaults not applied: %+v", r)
	}

	unknown := strings.Replace(ok, `"max_age_s":60`, `"max_age_s":60,"privileged":true`, 1)
	if _, err := Parse([]byte(unknown), p); err == nil || !strings.Contains(err.Error(), "/privileged") {
		t.Errorf("unknown field must be rejected by the schema: %v", err)
	}
}

// TestSchemaReservedEnvMatchesLockedEnv checks that the schema's reserved
// names are exactly what the agent locks, or the control plane would accept
// a configuration the agent then refuses (or the reverse).
func TestSchemaReservedEnvMatchesLockedEnv(t *testing.T) {
	names, prefixes := schemaReservedEnv()
	if !slices.Equal(prefixes, []string{"TRYOUT_"}) {
		t.Errorf("reserved prefixes: %v", prefixes)
	}

	want := map[string]bool{}
	for _, kind := range []Kind{Terminal, Desktop} {
		for k := range lockedEnv(Request{Kind: kind}) {
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
