package main

import (
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
)

// writer creates files and directories with fixed modes, then optionally
// hands them to another user (the dev compose file runs this tool as root
// and the control plane as the node user).
type writer struct{ owner string }

// dir creates a directory with mode and owner; an existing one is left as is.
func (w writer) dir(path string, mode fs.FileMode) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}

	if err := os.MkdirAll(path, mode); err != nil {
		return err
	}
	if err := os.Chmod(path, mode); err != nil {
		return err
	}
	return w.chown(path)
}

// file writes data with mode and owner through a temporary file and a
// rename, so a file is never seen half written or with the wrong mode.
func (w writer) file(path string, data []byte, mode fs.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	if err := w.chown(tmp); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// chown gives path to --owner, if set.
func (w writer) chown(path string) error {
	if w.owner == "" {
		return nil
	}

	uid, gid, err := w.ids()
	if err != nil {
		return err
	}
	return os.Chown(path, uid, gid)
}

// ids parses --owner as uid:gid; without --owner it returns -1, -1.
func (w writer) ids() (int, int, error) {
	if w.owner == "" {
		return -1, -1, nil
	}

	u, g, ok := strings.Cut(w.owner, ":")
	uid, err1 := strconv.Atoi(u)
	gid, err2 := strconv.Atoi(g)
	if !ok || err1 != nil || err2 != nil || uid < 0 || gid < 0 {
		return 0, 0, fmt.Errorf("--owner must be uid:gid, got %q", w.owner)
	}
	return uid, gid, nil
}
