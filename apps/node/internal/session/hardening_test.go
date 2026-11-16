package session

import (
	"slices"
	"testing"
	"time"
)

// TestSpecHardening checks the hard-coded hardening of both session kinds:
// no capabilities beyond the desktop set, no privilege escalation, resource
// limits, the session network and gVisor.
func TestSpecHardening(t *testing.T) {
	p := testPolicy("strict", false)

	for _, kind := range []Kind{Terminal, Desktop} {
		r := validReq(kind)
		if err := r.validate(p); err != nil {
			t.Fatal(err)
		}
		c, err := Spec(r, Image{Cmd: []string{"bash"}}, "net", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		hc := c.HostConfig

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

	term := validReq(Terminal)
	_ = term.validate(p)
	if c, _ := Spec(term, Image{Cmd: []string{"bash"}}, "net", time.Now()); !c.HostConfig.ReadonlyRootfs {
		t.Error("terminal sessions must have a read-only rootfs")
	}
}

// TestSpecLabels checks the labels the agent reads back: the session, its
// lifetime from the creation time, and its route.
func TestSpecLabels(t *testing.T) {
	r := validReq(Desktop)
	r.MaxAgeS = 60
	c, _ := Spec(r, Image{}, "net", time.Unix(1000, 0))
	l := c.Labels

	if l[LabelSession] != r.ID || l[LabelCreated] != "1000" || l[LabelExpires] != "1060" || l[LabelPort] != "3000" || l[LabelStrip] != "false" {
		t.Errorf("labels: %v", l)
	}
}
