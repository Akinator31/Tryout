package main

import (
	"crypto/x509"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/pki"
)

// command is a parsed invocation: the flags, where to report, the current
// time and the validity of the leaf certificates it issues.
type command struct {
	opts
	out      io.Writer
	now      time.Time
	validity time.Duration
}

// leaf describes a leaf certificate to issue: its sub-directory of --dir,
// its single usage, its common name and its subject alternative names.
type leaf struct {
	sub   string
	usage pki.Usage
	cn    string
	sans  []string
}

// controlPlaneLeaf is the control plane's client certificate.
var controlPlaneLeaf = leaf{sub: "control-plane", usage: pki.ClientAuth, cn: "tryout-control-plane"}

// nodeLeaf is the server certificate of a node's agent.
func nodeLeaf(name string, sans []string) leaf {
	return leaf{sub: filepath.Join("nodes", name), usage: pki.ServerAuth, cn: "tryout-agent-" + name, sans: sans}
}

// initPKI creates the CA and the control plane's client certificate. The CA
// is never replaced, even with --force: every certificate depends on it.
// With --if-missing, an existing CA is kept and the client certificate is
// issued if missing, which finishes an init that stopped between the two.
func (c command) initPKI() error {
	caCrt := filepath.Join(c.dir, "ca", "ca.crt")
	if exists(caCrt) {
		if c.ifMissing {
			fmt.Fprintf(c.out, "%s exists, keeping it\n", caCrt)
			return c.issue(controlPlaneLeaf)
		}
		return fmt.Errorf("%s exists: the CA is never replaced (remove the directory to start over)", caCrt)
	}

	ca, err := pki.NewCA("Tryout CA", c.now, pki.CAValidity)
	if err != nil {
		return err
	}
	if err := c.writeCA(ca, caCrt); err != nil {
		return err
	}
	fmt.Fprintln(c.out, "created", caCrt, "and its key: keep ca/ on this machine only")

	c.force = true // a fresh CA invalidates any previous leaf
	return c.issue(controlPlaneLeaf)
}

// writeCA writes the CA's key and certificate; ca/ is private to its owner.
func (c command) writeCA(ca *pki.Pair, caCrt string) error {
	w := writer{owner: c.owner}
	if err := w.dir(filepath.Join(c.dir, "ca"), 0o700); err != nil {
		return err
	}
	if err := w.file(filepath.Join(c.dir, "ca", "ca.key"), ca.KeyPEM, 0o600); err != nil {
		return err
	}
	return w.file(caCrt, ca.CertPEM, 0o644)
}

// issue signs a leaf certificate with the CA of --dir and writes it, its key
// and a copy of the CA certificate to its sub-directory. An existing
// certificate is replaced only with --force; with --if-missing it is kept.
func (c command) issue(l leaf) error {
	dir := filepath.Join(c.dir, l.sub)
	crt := filepath.Join(dir, "tls.crt")
	if exists(crt) && !c.force {
		if c.ifMissing {
			fmt.Fprintf(c.out, "%s exists, nothing to do\n", crt)
			return nil
		}
		return fmt.Errorf("%s exists (use --force to replace it)", crt)
	}

	ca, err := pki.LoadPair(filepath.Join(c.dir, "ca", "ca.crt"), filepath.Join(c.dir, "ca", "ca.key"))
	if err != nil {
		return fmt.Errorf("load the CA (run init first): %w", err)
	}
	cert, err := ca.Issue(l.usage, l.cn, l.sans, c.now, c.validity)
	if err != nil {
		return err
	}

	if err := c.writeLeaf(dir, cert, ca); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "created %s: %s\n", dir, pki.Describe(cert.Cert))
	return nil
}

// writeLeaf writes tls.key, tls.crt and ca.crt to dir, creating dir and its
// parent if needed.
func (c command) writeLeaf(dir string, cert, ca *pki.Pair) error {
	w := writer{owner: c.owner}
	if err := w.dir(filepath.Dir(dir), 0o755); err != nil {
		return err
	}
	if err := w.dir(dir, 0o755); err != nil {
		return err
	}
	if err := w.file(filepath.Join(dir, "tls.key"), cert.KeyPEM, 0o600); err != nil {
		return err
	}
	if err := w.file(filepath.Join(dir, "tls.crt"), cert.CertPEM, 0o644); err != nil {
		return err
	}
	return w.file(filepath.Join(dir, "ca.crt"), ca.CertPEM, 0o644)
}

// inspect prints one line per certificate under dir, with a warning for those
// expired or close to expiry. The ca.crt copies next to each leaf repeat
// ca/ca.crt and are skipped.
func inspect(dir string, out io.Writer, now time.Time) error {
	found := false
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".crt") || isCACopy(path) {
			return nil
		}

		certs, err := pki.LoadCerts(path)
		if err != nil {
			return err
		}
		for _, c := range certs {
			found = true
			fmt.Fprintln(out, inspectLine(path, c, now))
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

// isCACopy reports whether path is a ca.crt copied next to a leaf.
func isCACopy(path string) bool {
	return filepath.Base(path) == "ca.crt" && filepath.Base(filepath.Dir(path)) != "ca"
}

// inspectLine describes one certificate of the inspect output.
func inspectLine(path string, c *x509.Certificate, now time.Time) string {
	line := path + ": " + pki.Describe(c)
	if w := pki.Expiry(c, now, pki.ExpiryWarning); w != "" {
		line += "  WARNING: " + w
	}
	return line
}

// exists reports whether path exists.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
