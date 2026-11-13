package main

import (
	"slices"
	"testing"
)

// TestContainerSpecHardening checks the hard-coded hardening of both session
// kinds: no capabilities beyond the desktop set, no privilege escalation,
// resource limits, the session network and gVisor.
func TestContainerSpecHardening(t *testing.T) {
	a := testAgent("strict", false)

	for _, kind := range []sessionKind{kindTerminal, kindDesktop} {
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
