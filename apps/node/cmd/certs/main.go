// tryout-certs: creates the private PKI of the mutual TLS link between the
// control plane and the agents (ADR 0015, docs/certificates.md).
//
// Layout of the output directory; each sub-directory is what one machine needs:
//
//	ca/ca.crt, ca/ca.key                 the CA: keep it on the operator's machine only
//	control-plane/tls.crt, tls.key, ca.crt   the control plane's client certificate
//	nodes/<name>/tls.crt, tls.key, ca.crt    an agent's server certificate
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/pki"
)

const usage = `usage: tryout-certs <command> [flags]

commands:
  init                     create the CA and the control plane's client certificate
  node <name> --san <host> create the server certificate of a node's agent (--san repeatable)
  client                   issue a new client certificate for the control plane
  inspect                  list the certificates and their expiry dates

common flags:
  --dir <path>      output directory (default ./pki)
  --force           replace existing leaf certificates (the CA is never replaced)
  --if-missing      do nothing, successfully, if the files already exist
  --owner uid:gid   chown the written files (when running as root, e.g. in a container)
  --days <n>        validity of leaf certificates (default 365)
`

var nodeNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

type sanList []string

func (s *sanList) String() string     { return strings.Join(*s, ",") }
func (s *sanList) Set(v string) error { *s = append(*s, strings.Split(v, ",")...); return nil }

type opts struct {
	dir       string
	force     bool
	ifMissing bool
	owner     string
	days      int
	sans      sanList
}

func main() {
	if err := run(os.Args[1:], os.Stdout, time.Now()); err != nil {
		fmt.Fprintln(os.Stderr, "tryout-certs:", err)
		os.Exit(1)
	}
}

func run(args []string, out io.Writer, now time.Time) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(out, usage)
		return nil
	}
	cmd, args := args[0], args[1:]
	var name string
	if cmd == "node" {
		if len(args) == 0 || strings.HasPrefix(args[0], "-") {
			return errors.New("node: missing node name")
		}
		name, args = args[0], args[1:]
		if !nodeNameRe.MatchString(name) {
			return fmt.Errorf("node: invalid name %q (lower-case letters, digits and -, as in the control plane configuration)", name)
		}
	}
	var o opts
	fset := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fset.SetOutput(io.Discard)
	fset.StringVar(&o.dir, "dir", "pki", "")
	fset.BoolVar(&o.force, "force", false, "")
	fset.BoolVar(&o.ifMissing, "if-missing", false, "")
	fset.StringVar(&o.owner, "owner", "", "")
	fset.IntVar(&o.days, "days", 365, "")
	if cmd == "node" {
		fset.Var(&o.sans, "san", "")
	}
	if err := fset.Parse(args); err != nil {
		return fmt.Errorf("%s: %w", cmd, err)
	}
	if fset.NArg() > 0 {
		return fmt.Errorf("%s: unexpected argument %q", cmd, fset.Arg(0))
	}
	if o.days < 1 {
		return errors.New("--days must be at least 1")
	}
	if o.force && o.ifMissing {
		return errors.New("--force and --if-missing are exclusive")
	}
	if _, _, err := (writer{o.owner}).ids(); err != nil {
		return err
	}
	validity := time.Duration(o.days) * 24 * time.Hour

	switch cmd {
	case "init":
		return initPKI(o, out, now, validity)
	case "client":
		return issue(o, out, now, validity, "control-plane", pki.ClientAuth, "tryout-control-plane", nil)
	case "node":
		if len(o.sans) == 0 {
			return errors.New("node: at least one --san is required: the host name or IP address in the node's agent_url")
		}
		return issue(o, out, now, validity, filepath.Join("nodes", name), pki.ServerAuth, "tryout-agent-"+name, o.sans)
	case "inspect":
		return inspect(o.dir, out, now)
	}
	return fmt.Errorf("unknown command %q\n\n%s", cmd, usage)
}

func initPKI(o opts, out io.Writer, now time.Time, validity time.Duration) error {
	caCrt := filepath.Join(o.dir, "ca", "ca.crt")
	if exists(caCrt) {
		if o.ifMissing {
			// Finish an init that stopped between the CA and the client certificate.
			fmt.Fprintf(out, "%s exists, keeping it\n", caCrt)
			return issue(o, out, now, validity, "control-plane", pki.ClientAuth, "tryout-control-plane", nil)
		}
		return fmt.Errorf("%s exists: the CA is never replaced (remove the directory to start over)", caCrt)
	}
	ca, err := pki.NewCA("Tryout CA", now, pki.CAValidity)
	if err != nil {
		return err
	}
	w := writer{owner: o.owner}
	if err := w.dir(filepath.Join(o.dir, "ca"), 0o700); err != nil {
		return err
	}
	if err := w.file(filepath.Join(o.dir, "ca", "ca.key"), ca.KeyPEM, 0o600); err != nil {
		return err
	}
	if err := w.file(caCrt, ca.CertPEM, 0o644); err != nil {
		return err
	}
	fmt.Fprintln(out, "created", caCrt, "and its key: keep ca/ on this machine only")
	o.force = true // a fresh CA invalidates any previous leaf
	return issue(o, out, now, validity, "control-plane", pki.ClientAuth, "tryout-control-plane", nil)
}

func issue(o opts, out io.Writer, now time.Time, validity time.Duration, sub string, u pki.Usage, cn string, sans []string) error {
	dir := filepath.Join(o.dir, sub)
	crt := filepath.Join(dir, "tls.crt")
	if exists(crt) && !o.force {
		if o.ifMissing {
			fmt.Fprintf(out, "%s exists, nothing to do\n", crt)
			return nil
		}
		return fmt.Errorf("%s exists (use --force to replace it)", crt)
	}
	ca, err := pki.LoadPair(filepath.Join(o.dir, "ca", "ca.crt"), filepath.Join(o.dir, "ca", "ca.key"))
	if err != nil {
		return fmt.Errorf("load the CA (run init first): %w", err)
	}
	leaf, err := ca.Issue(u, cn, sans, now, validity)
	if err != nil {
		return err
	}
	w := writer{owner: o.owner}
	if err := w.dir(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	if err := w.dir(dir, 0o755); err != nil {
		return err
	}
	if err := w.file(filepath.Join(dir, "tls.key"), leaf.KeyPEM, 0o600); err != nil {
		return err
	}
	if err := w.file(crt, leaf.CertPEM, 0o644); err != nil {
		return err
	}
	if err := w.file(filepath.Join(dir, "ca.crt"), ca.CertPEM, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(out, "created %s: %s\n", dir, pki.Describe(leaf.Cert))
	return nil
}

func inspect(dir string, out io.Writer, now time.Time) error {
	found := false
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".crt") {
			return nil
		}
		// ca.crt copies next to each leaf repeat ca/ca.crt.
		if filepath.Base(path) == "ca.crt" && filepath.Base(filepath.Dir(path)) != "ca" {
			return nil
		}
		certs, err := pki.LoadCerts(path)
		if err != nil {
			return err
		}
		for _, c := range certs {
			found = true
			line := path + ": " + pki.Describe(c)
			if w := pki.Expiry(c, now, pki.ExpiryWarning); w != "" {
				line += "  WARNING: " + w
			}
			fmt.Fprintln(out, line)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("no certificate under %s", dir)
	}
	return nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

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
