package session

import (
	"slices"
	"strings"
	"testing"
	"time"
)

// gpuPolicy returns the policy of a strict node with one CDI GPU device.
func gpuPolicy() Policy {
	p := testPolicy("strict", false)
	p.GPUDevices = []string{"nvidia.com/gpu=all"}
	return p
}

// gpuReq returns a valid desktop request that asks for a GPU.
func gpuReq() Request {
	r := validReq(Desktop)
	r.GPU = true
	return r
}

// TestSpecGPUDevices checks that a GPU desktop gets the node's CDI devices
// and the label the agent counts GPU sessions with, and that other sessions
// get neither.
func TestSpecGPUDevices(t *testing.T) {
	for _, gpu := range []bool{true, false} {
		r := validReq(Desktop)
		r.GPU = gpu
		if err := r.validate(gpuPolicy()); err != nil {
			t.Fatal(err)
		}
		c, err := Spec(r, Image{}, "net", time.Now())
		if err != nil {
			t.Fatal(err)
		}

		dr := c.HostConfig.DeviceRequests
		if !gpu {
			if len(dr) != 0 || c.Labels[LabelGPU] != "false" {
				t.Errorf("session without gpu: devices %+v, label %q", dr, c.Labels[LabelGPU])
			}
			continue
		}
		if len(dr) != 1 || dr[0].Driver != "cdi" || !slices.Equal(dr[0].DeviceIDs, []string{"nvidia.com/gpu=all"}) {
			t.Errorf("gpu session: device requests %+v", dr)
		}
		if c.Labels[LabelGPU] != "true" {
			t.Errorf("gpu session: label %q", c.Labels[LabelGPU])
		}
	}
}

// TestValidateGPUPolicy checks when a GPU is refused: on a node without GPU
// devices, for a terminal, and under any runtime but runsc, even where the
// node allows other runtimes (dev, ALLOW_RUNC): GPU sessions rely on gVisor's
// nvproxy, and runc would hand the visitor the whole driver surface.
func TestValidateGPUPolicy(t *testing.T) {
	noGPU := testPolicy("strict", false)
	allowRunc := gpuPolicy()
	allowRunc.AllowRunc = true
	dev := gpuPolicy()
	dev.Profile = "dev"

	terminal := validReq(Terminal)
	terminal.GPU = true
	runc := gpuReq()
	runc.Runtime = "runc"

	cases := map[string]struct {
		r    Request
		p    Policy
		want string
	}{
		"node without gpu": {gpuReq(), noGPU, "no GPU"},
		"terminal":         {terminal, gpuPolicy(), "desktop"},
		"runc allowed":     {runc, allowRunc, "runsc"},
		"runc in dev":      {runc, dev, "runsc"},
	}
	for name, c := range cases {
		err := c.r.validate(c.p)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want an error about %q", name, err, c.want)
		}
	}

	ok := gpuReq()
	if err := ok.validate(allowRunc); err != nil {
		t.Errorf("gpu desktop on runsc: %v", err)
	}
}

// TestParseGPU checks that the shared JSON Schema accepts gpu on the agent's
// POST /v1/sessions body and refuses anything but a boolean.
func TestParseGPU(t *testing.T) {
	body := `{"id":"` + strings.Repeat("a", 26) + `","project":"p","image":"img","kind":"desktop","port":3000,"max_age_s":60,"gpu":%s}`

	r, err := Parse([]byte(strings.Replace(body, "%s", "true", 1)), gpuPolicy())
	if err != nil || !r.GPU {
		t.Errorf("gpu true: %+v, %v", r, err)
	}
	if _, err := Parse([]byte(strings.Replace(body, "%s", `"yes"`, 1)), gpuPolicy()); err == nil {
		t.Error("gpu \"yes\" accepted")
	}
}
