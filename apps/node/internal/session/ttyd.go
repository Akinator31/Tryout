package session

import (
	"encoding/json"
	"errors"
	"slices"
	"strconv"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// TTYDMode says who serves a terminal's page.
type TTYDMode string

const (
	// TTYDAgent: the agent mounts its own ttyd and runs the image's command
	// in it, so the image needs no web server. The default for terminals.
	TTYDAgent TTYDMode = "agent"
	// TTYDImage: the image serves its own page on the request's port.
	TTYDImage TTYDMode = "image"
)

const (
	// ttydPort is where the agent's ttyd listens, on the session network.
	ttydPort = 7681
	// ttydDir is where the ttyd image is mounted, read-only. The image holds
	// a single static binary, /ttyd.
	ttydDir = "/opt/tryout"
)

// ttydTheme is the terminal's xterm.js theme, from the design tokens: the
// page background, the main text colour, the brand colour for the cursor.
var ttydTheme = map[string]string{
	"background":          "#000000",
	"foreground":          "#ece9e2",
	"cursor":              "#ffb000",
	"cursorAccent":        "#000000",
	"selectionBackground": "#2a2a2a",
}

// ttydFont is the terminal's font stack: IBM Plex Mono when the visitor has
// it, as on the embed page, else the system's monospace font.
const ttydFont = `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

// Image is what the agent read from a session's image: its entrypoint and
// command, which the agent's ttyd runs unless the request names a command.
type Image struct {
	Entrypoint []string
	Cmd        []string
}

// errNoProgram refuses a terminal with nothing for ttyd to run.
var errNoProgram = errors.New("the image has no entrypoint or command: set the project's command")

// program is what the agent's ttyd runs: the request's command, else the
// image's entrypoint followed by its command, as docker run would. Its first
// argument, the program itself, cannot be empty.
func program(r Request, img Image) ([]string, error) {
	p := r.Command
	if len(p) == 0 {
		p = slices.Concat(img.Entrypoint, img.Cmd)
	}

	if len(p) == 0 || p[0] == "" {
		return nil, errNoProgram
	}
	return p, nil
}

// ttydArgs are the options of the agent's ttyd, all locked: writable, one
// client at a time, the session's base path, the Tryout theme and no
// "leave this page?" prompt. ttyd reads a client option's value as JSON when
// it parses, so the font stack, which starts with a quoted name, is sent as a
// JSON string. "--" ends the options, so that an argument of the program
// that starts with a dash is not read as one of ttyd's.
func ttydArgs(r Request) []string {
	theme, _ := json.Marshal(ttydTheme)
	font, _ := json.Marshal(ttydFont)
	return []string{
		"--writable",
		"--max-clients", "1",
		"--port", strconv.Itoa(ttydPort),
		"--base-path", "/s/" + r.ID,
		"--client-option", "disableLeaveAlert=true",
		"--client-option", "fontFamily=" + string(font),
		"--client-option", "theme=" + string(theme),
		"--",
	}
}

// ttydMount mounts the ttyd image read-only at ttydDir.
func ttydMount(image string) dockerapi.Mount {
	return dockerapi.Mount{Type: "image", Source: image, Target: ttydDir, ReadOnly: true}
}

// withTTYD makes c run the image's program in the agent's ttyd: the ttyd
// image mounted read-only, ttyd as the entrypoint and the program after its
// options. The image's own user, working directory and environment stay.
func withTTYD(c *dockerapi.ContainerCreate, r Request, img Image) error {
	prog, err := program(r, img)
	if err != nil {
		return err
	}

	c.Entrypoint = []string{ttydDir + "/ttyd"}
	c.Cmd = append(ttydArgs(r), prog...)
	c.HostConfig.Mounts = append(c.HostConfig.Mounts, ttydMount(r.ttydImage))
	return nil
}
