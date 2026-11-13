package main

import (
	"slices"
	"strings"
	"testing"

	"github.com/Akinator31/Tryout/apps/node/internal/spec"
)

// TestValidateAppliesDefaults checks the default runtime, limits and lifetime.
func TestValidateAppliesDefaults(t *testing.T) {
	r := validReq("desktop")
	if err := r.validate(testAgent("strict", false)); err != nil {
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
	r := validReq("terminal")
	r.Runtime = "runc"
	if err := r.validate(testAgent("strict", false)); err == nil {
		t.Error("runc must be refused by profile strict without ALLOW_RUNC")
	}

	r.Runtime = "runc"
	if err := r.validate(testAgent("strict", true)); err != nil {
		t.Errorf("runc must be allowed with ALLOW_RUNC: %v", err)
	}

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
}

// TestValidateRejectsBadRequests checks the fields the hardening depends on
// and the reserved environment variables.
func TestValidateRejectsBadRequests(t *testing.T) {
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

// TestSessionEnvPrecedence checks the merge order: kind defaults, then
// project env, then locked env.
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

// TestParseSessionReqUsesSchema checks that the body goes through the shared
// JSON Schema (an unknown field is refused) before the node policy.
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

// TestSchemaReservedEnvMatchesLockedEnv checks that the schema's reserved
// names are exactly what the agent locks, or the control plane would accept
// a configuration the agent then refuses (or the reverse).
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
