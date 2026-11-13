package main

import (
	"bytes"
	"crypto/x509"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/pki"
)

var now = time.Now()

// runOK runs the tool and fails the test on error; it returns the output.
func runOK(t *testing.T, args ...string) string {
	t.Helper()
	var out bytes.Buffer
	if err := run(args, &out, now); err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	return out.String()
}

// mode returns the permission bits of path.
func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return st.Mode().Perm()
}

// TestInitNodeAndInspect checks the whole layout: file modes, one usage per
// leaf, certificates that verify against the CA, and the inspect output.
func TestInitNodeAndInspect(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pki")
	runOK(t, "init", "--dir", dir)
	runOK(t, "node", "cli", "--san", "node.example", "--san", "10.0.0.5", "--dir", dir)

	for path, want := range map[string]os.FileMode{
		"ca":                    0o700,
		"ca/ca.key":             0o600,
		"ca/ca.crt":             0o644,
		"control-plane/tls.key": 0o600,
		"control-plane/tls.crt": 0o644,
		"control-plane/ca.crt":  0o644,
		"nodes/cli/tls.key":     0o600,
		"nodes/cli/tls.crt":     0o644,
		"nodes/cli/ca.crt":      0o644,
	} {
		if got := mode(t, filepath.Join(dir, path)); got != want {
			t.Errorf("%s: mode %v, want %v", path, got, want)
		}
	}

	ca, err := pki.LoadPair(filepath.Join(dir, "ca/ca.crt"), filepath.Join(dir, "ca/ca.key"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca.Cert)

	check := func(sub string, u x509.ExtKeyUsage, dns string) {
		p, err := pki.LoadPair(filepath.Join(dir, sub, "tls.crt"), filepath.Join(dir, sub, "tls.key"))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.Cert.Verify(x509.VerifyOptions{Roots: roots, DNSName: dns, KeyUsages: []x509.ExtKeyUsage{u}}); err != nil {
			t.Errorf("%s: %v", sub, err)
		}
		if len(p.Cert.ExtKeyUsage) != 1 {
			t.Errorf("%s: usages %v", sub, p.Cert.ExtKeyUsage)
		}
	}

	check("control-plane", x509.ExtKeyUsageClientAuth, "")
	check("nodes/cli", x509.ExtKeyUsageServerAuth, "node.example")
	check("nodes/cli", x509.ExtKeyUsageServerAuth, "10.0.0.5")

	out := runOK(t, "inspect", "--dir", dir)
	for _, want := range []string{"Tryout CA (ca)", "tryout-control-plane (client)", "tryout-agent-cli (server)", "san=node.example,10.0.0.5"} {
		if !strings.Contains(out, want) {
			t.Errorf("inspect output lacks %q:\n%s", want, out)
		}
	}
}

// TestExistingFilesAreProtected checks that the CA is never replaced and that
// a leaf is replaced only with --force.
func TestExistingFilesAreProtected(t *testing.T) {
	dir := t.TempDir()
	runOK(t, "init", "--dir", dir)
	caBefore, _ := os.ReadFile(filepath.Join(dir, "ca/ca.crt"))

	var out bytes.Buffer
	if err := run([]string{"init", "--dir", dir}, &out, now); err == nil {
		t.Error("init over an existing CA must fail")
	}
	runOK(t, "init", "--dir", dir, "--if-missing")

	if err := run([]string{"init", "--dir", dir, "--force"}, &out, now); err == nil {
		t.Error("the CA must never be replaced, even with --force")
	}
	if caAfter, _ := os.ReadFile(filepath.Join(dir, "ca/ca.crt")); !bytes.Equal(caBefore, caAfter) {
		t.Error("CA changed")
	}

	runOK(t, "node", "n1", "--san", "a.example", "--dir", dir)
	before, _ := os.ReadFile(filepath.Join(dir, "nodes/n1/tls.crt"))
	if err := run([]string{"node", "n1", "--san", "a.example", "--dir", dir}, &out, now); err == nil {
		t.Error("node over an existing certificate must fail without --force")
	}
	runOK(t, "node", "n1", "--san", "a.example", "--dir", dir, "--if-missing")
	if after, _ := os.ReadFile(filepath.Join(dir, "nodes/n1/tls.crt")); !bytes.Equal(before, after) {
		t.Error("--if-missing replaced the certificate")
	}

	runOK(t, "node", "n1", "--san", "a.example", "--dir", dir, "--force")
	if after, _ := os.ReadFile(filepath.Join(dir, "nodes/n1/tls.crt")); bytes.Equal(before, after) {
		t.Error("--force did not replace the certificate")
	}

	runOK(t, "client", "--dir", dir, "--force")
}

// TestInitIfMissingFinishesAnInterruptedInit checks that init --if-missing
// issues the client certificate when only the CA exists.
func TestInitIfMissingFinishesAnInterruptedInit(t *testing.T) {
	dir := t.TempDir()
	runOK(t, "init", "--dir", dir)
	if err := os.RemoveAll(filepath.Join(dir, "control-plane")); err != nil {
		t.Fatal(err)
	}
	runOK(t, "init", "--dir", dir, "--if-missing")
	if _, err := os.Stat(filepath.Join(dir, "control-plane/tls.crt")); err != nil {
		t.Error("the client certificate was not issued")
	}
}

// TestExistingDirectoryModeIsKept checks that an existing --dir keeps its mode.
func TestExistingDirectoryModeIsKept(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "pki")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	runOK(t, "init", "--dir", dir)
	if got := mode(t, dir); got != 0o700 {
		t.Errorf("--dir mode changed to %v", got)
	}
}

// TestUsageErrors checks that bad command lines are refused before anything
// is written.
func TestUsageErrors(t *testing.T) {
	dir := t.TempDir()
	for _, args := range [][]string{
		{"node", "n1", "--san", "a.example", "--dir", dir}, // no CA yet
		{"init", "--dir", dir, "--owner", "nobody"},
		{"init", "--dir", dir, "--days", "0"},
		{"init", "--dir", dir, "--force", "--if-missing"},
		{"node", "--san", "a.example"},
		{"node", "Bad_Name", "--san", "a.example"},
		{"node", "n1", "--dir", dir},
		{"init", "extra"},
		{"frobnicate"},
		{"inspect", "--dir", dir},
	} {
		if err := run(args, &bytes.Buffer{}, now); err == nil {
			t.Errorf("%v: accepted", args)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "ca")); err == nil {
		t.Error("a refused command wrote files")
	}
}
