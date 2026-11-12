package main

import (
	"slices"
	"strings"
	"testing"
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
