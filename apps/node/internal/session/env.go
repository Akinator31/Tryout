package session

import (
	"maps"
	"slices"
	"strings"
)

// desktopLockedEnv is the part of lockedEnv specific to desktop sessions:
// the LinuxServer/Selkies boot settings the agent pins (user ids, hardened
// desktop, no Docker, no gamepad) and the features a public sandbox must not
// expose: file transfer, microphone, webcam, printing, gamepads, second screen.
var desktopLockedEnv = map[string]string{
	"PUID":                       "1000",
	"PGID":                       "1000",
	"HARDEN_DESKTOP":             "true",
	"START_DOCKER":               "false",
	"NO_GAMEPAD":                 "true",
	"SELKIES_FILE_TRANSFERS":     "none",
	"SELKIES_MICROPHONE_ENABLED": "false|locked",
	"SELKIES_WEBCAM_ENABLED":     "false|locked",
	"SELKIES_PRINTING_ENABLED":   "false|locked",
	"SELKIES_GAMEPAD_ENABLED":    "false|locked",
	"SELKIES_SECOND_SCREEN":      "false|locked",
}

// desktopDefaults are performance defaults a project may override: Selkies
// otherwise sizes the stream to the client screen (near-4K at 60 fps on a
// HiDPI laptop), which saturates a small node with a single visitor.
var desktopDefaults = map[string]string{
	"SELKIES_MANUAL_RESOLUTION": "true|locked",
	"SELKIES_MANUAL_WIDTH":      "1280",
	"SELKIES_MANUAL_HEIGHT":     "720",
	"SELKIES_SCALING_DPI":       "96",
	"SELKIES_USE_CSS_SCALING":   "true|locked",
	"SELKIES_FRAMERATE":         "15-30",
	"SELKIES_AUDIO_ENABLED":     "false|locked",
}

// lockedEnv is set by the agent and can never be overridden by a project:
// it carries the routing contract (the session's base path, SUBFOLDER for
// Selkies) and, for desktops, desktopLockedEnv. Terminals get HOME=/tmp
// because their root filesystem is read-only.
func lockedEnv(r Request) map[string]string {
	base := "/s/" + r.ID
	env := map[string]string{
		"TRYOUT_SESSION_ID": r.ID,
		"TRYOUT_BASE_PATH":  base,
	}

	switch r.Kind {
	case Terminal:
		env["HOME"] = "/tmp"
	case Desktop:
		maps.Copy(env, desktopLockedEnv)
		env["SUBFOLDER"] = base + "/"
	}
	return env
}

// isReservedEnv reports whether a project may not set the variable k: any
// TRYOUT_ name, and every name lockedEnv sets for either kind. The JSON
// Schema's reserved_env must list the same names (see the tests).
func isReservedEnv(k string) bool {
	if strings.HasPrefix(k, "TRYOUT_") {
		return true
	}

	_, inTerminal := lockedEnv(Request{Kind: Terminal})[k]
	_, inDesktop := lockedEnv(Request{Kind: Desktop})[k]
	return inTerminal || inDesktop
}

// containerEnv merges, by increasing priority: kind defaults, project env,
// locked env. The result is sorted for deterministic container specs.
func containerEnv(r Request) []string {
	merged := map[string]string{}
	if r.Kind == Desktop {
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
