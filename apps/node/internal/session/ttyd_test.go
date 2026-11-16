package session

import (
	"slices"
	"strings"
	"testing"
	"time"
)

// TestTTYDMode checks who serves a terminal's page: the agent's ttyd by
// default, on its own port and without strip_prefix; the image itself with
// ttyd: image, on the request's port; never ttyd for a desktop.
func TestTTYDMode(t *testing.T) {
	p := testPolicy("strict", false)

	r := validReq(Terminal)
	if err := r.validate(p); err != nil || r.TTYD != TTYDAgent || r.Port != ttydPort {
		t.Errorf("default terminal: %v, %+v", err, r)
	}

	r = validReq(Terminal)
	r.TTYD, r.Port = TTYDImage, 8080
	if err := r.validate(p); err != nil || r.Port != 8080 {
		t.Errorf("terminal serving its own page: %v, %+v", err, r)
	}

	r = validReq(Terminal)
	r.Port, r.StripPrefix = 7681, true
	if err := r.validate(p); err != nil || r.TTYD != TTYDImage {
		t.Errorf("a terminal with a port and no ttyd serves its own page, as before: %v, %+v", err, r)
	}

	for name, bad := range map[string]func(*Request){
		"port with the agent's ttyd":         func(r *Request) { r.TTYD, r.Port = TTYDAgent, 7681 },
		"strip_prefix with the agent's ttyd": func(r *Request) { r.StripPrefix = true },
		"image mode without a port":          func(r *Request) { r.TTYD = TTYDImage },
		"command in image mode":              func(r *Request) { r.TTYD, r.Port, r.Command = TTYDImage, 8080, []string{"sh"} },
		"command with a port":                func(r *Request) { r.Port, r.Command = 8080, []string{"sh"} },
		"unknown mode":                       func(r *Request) { r.TTYD = "builtin" },
		"desktop with ttyd":                  func(r *Request) { r.Kind, r.Port, r.TTYD = Desktop, 3000, TTYDImage },
		"desktop with a command":             func(r *Request) { r.Kind, r.Port, r.Command = Desktop, 3000, []string{"sh"} },
	} {
		r := validReq(Terminal)
		bad(&r)
		if err := r.validate(p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	noTTYD := testPolicy("strict", false)
	noTTYD.TTYDImage = ""
	r = validReq(Terminal)
	if err := r.validate(noTTYD); err == nil {
		t.Error("a node without a ttyd image must refuse the agent's ttyd")
	}
}

// TestSpecRunsTheProgramInTTYD checks the container of a terminal with the
// agent's ttyd: the ttyd image mounted read-only, ttyd as the entrypoint with
// its locked options, then the program, after "--".
func TestSpecRunsTheProgramInTTYD(t *testing.T) {
	r := validReq(Terminal)
	if err := r.validate(testPolicy("strict", false)); err != nil {
		t.Fatal(err)
	}

	c, err := Spec(r, Image{Entrypoint: []string{"python3"}, Cmd: []string{"-q"}}, "net", time.Now())
	if err != nil {
		t.Fatal(err)
	}

	if !slices.Equal(c.Entrypoint, []string{"/opt/tryout/ttyd"}) {
		t.Errorf("entrypoint %v", c.Entrypoint)
	}
	args := strings.Join(c.Cmd, " ")
	for _, want := range []string{"--writable", "--max-clients 1", "--port 7681", "--base-path /s/" + r.ID, "disableLeaveAlert=true", `fontFamily="\"IBM Plex Mono\", ui-monospace`} {
		if !strings.Contains(args, want) {
			t.Errorf("ttyd options lack %q: %s", want, args)
		}
	}
	if !strings.HasSuffix(args, " -- python3 -q") {
		t.Errorf("program must follow --: %s", args)
	}

	m := c.HostConfig.Mounts
	if len(m) != 1 || m[0].Type != "image" || m[0].Source != "ttyd@sha256:0123" || m[0].Target != "/opt/tryout" || !m[0].ReadOnly {
		t.Errorf("mounts %+v", m)
	}
	if c.Labels[LabelPort] != "7681" {
		t.Errorf("the gateway must route to ttyd's port: %v", c.Labels)
	}
}

// TestProgram checks what ttyd runs: the request's command first, else the
// image's entrypoint and command; an image with neither is refused.
func TestProgram(t *testing.T) {
	img := Image{Entrypoint: []string{"/entry"}, Cmd: []string{"arg"}}

	if p, _ := program(Request{}, img); !slices.Equal(p, []string{"/entry", "arg"}) {
		t.Errorf("image program: %v", p)
	}
	if p, _ := program(Request{Command: []string{"bash", "-l"}}, img); !slices.Equal(p, []string{"bash", "-l"}) {
		t.Errorf("command: %v", p)
	}
	if _, err := program(Request{}, Image{}); err == nil {
		t.Error("an image with nothing to run must be refused")
	}
	if _, err := program(Request{Command: []string{"", "x"}}, img); err == nil {
		t.Error("an empty program must be refused")
	}
}

// TestDesktopRunsTheImageAsItIs checks that desktops get no ttyd.
func TestDesktopRunsTheImageAsItIs(t *testing.T) {
	r := validReq(Desktop)
	_ = r.validate(testPolicy("strict", false))

	c, err := Spec(r, Image{}, "net", time.Now())
	if err != nil || c.Entrypoint != nil || c.Cmd != nil || c.HostConfig.Mounts != nil {
		t.Errorf("desktop: %v, %+v", err, c)
	}
}
