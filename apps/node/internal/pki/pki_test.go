package pki

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// mustCA creates a CA valid from now.
func mustCA(t *testing.T) *Pair {
	t.Helper()
	ca, err := NewCA("test CA", time.Now(), CAValidity)
	if err != nil {
		t.Fatal(err)
	}
	return ca
}

// mustIssue issues a leaf certificate with the given usage and SANs.
func mustIssue(t *testing.T, ca *Pair, u Usage, sans ...string) *Pair {
	t.Helper()
	p, err := ca.Issue(u, "leaf", sans, time.Now(), LeafValidity)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// write writes b to dir/name and returns its path.
func write(t *testing.T, dir, name string, b []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestIssueSetsOneUsageAndSANs checks the CA constraints, one extended key
// usage per leaf, IP and DNS SANs, and the issuing refusals.
func TestIssueSetsOneUsageAndSANs(t *testing.T) {
	ca, err := NewCA("test CA", now, CAValidity)
	if err != nil {
		t.Fatal(err)
	}
	if !ca.Cert.IsCA || !ca.Cert.MaxPathLenZero || ca.Cert.KeyUsage&x509.KeyUsageCertSign == 0 {
		t.Errorf("CA constraints: %+v", ca.Cert)
	}

	srv, err := ca.Issue(ServerAuth, "agent", []string{"node.example", "10.0.0.5"}, now, LeafValidity)
	if err != nil {
		t.Fatal(err)
	}
	if srv.Cert.IsCA || len(srv.Cert.ExtKeyUsage) != 1 || srv.Cert.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Errorf("server usage: %v", srv.Cert.ExtKeyUsage)
	}
	if len(srv.Cert.DNSNames) != 1 || srv.Cert.DNSNames[0] != "node.example" ||
		len(srv.Cert.IPAddresses) != 1 || srv.Cert.IPAddresses[0].String() != "10.0.0.5" {
		t.Errorf("SANs: %v %v", srv.Cert.DNSNames, srv.Cert.IPAddresses)
	}
	if got := srv.Cert.NotAfter.Sub(now); got != LeafValidity {
		t.Errorf("validity %v", got)
	}

	cli, err := ca.Issue(ClientAuth, "cp", nil, now, LeafValidity)
	if err != nil {
		t.Fatal(err)
	}
	if len(cli.Cert.ExtKeyUsage) != 1 || cli.Cert.ExtKeyUsage[0] != x509.ExtKeyUsageClientAuth {
		t.Errorf("client usage: %v", cli.Cert.ExtKeyUsage)
	}

	if _, err := ca.Issue(ServerAuth, "agent", nil, now, LeafValidity); err == nil {
		t.Error("a server certificate without SAN must be refused")
	}
	if _, err := ca.Issue(ClientAuth, "cp", nil, now, CAValidity+time.Hour); err == nil {
		t.Error("a leaf must not outlive its CA")
	}
	if _, err := srv.Issue(ClientAuth, "cp", nil, now, LeafValidity); err == nil {
		t.Error("a leaf must not sign")
	}
}

// TestServerConfigRequiresAValidClientCertificate checks the agent's listener:
// TLS 1.3 only, and only client certificates signed by the CA with the
// clientAuth usage.
func TestServerConfigRequiresAValidClientCertificate(t *testing.T) {
	dir := t.TempDir()
	ca := mustCA(t)
	srv := mustIssue(t, ca, ServerAuth, "127.0.0.1")
	cfg, loaded, err := ServerConfig(
		write(t, dir, "tls.crt", srv.CertPEM), write(t, dir, "tls.key", srv.KeyPEM), write(t, dir, "ca.crt", ca.CertPEM))
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != 2 {
		t.Errorf("loaded %d certificates, want server + CA", len(loaded))
	}

	ts := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))
	ts.TLS = cfg
	ts.StartTLS()
	defer ts.Close()

	roots := x509.NewCertPool()
	roots.AddCert(ca.Cert)
	client := func(certs []tls.Certificate, maxVersion uint16) error {
		c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{
			RootCAs: roots, Certificates: certs, MaxVersion: maxVersion,
		}}}
		resp, err := c.Get(ts.URL)
		if err != nil {
			return err
		}
		resp.Body.Close()
		return nil
	}
	pair := func(p *Pair) []tls.Certificate {
		return []tls.Certificate{{Certificate: [][]byte{p.Cert.Raw}, PrivateKey: p.Key}}
	}

	if err := client(pair(mustIssue(t, ca, ClientAuth)), 0); err != nil {
		t.Fatalf("valid client refused: %v", err)
	}

	other := mustCA(t)
	for name, certs := range map[string][]tls.Certificate{
		"no certificate":          nil,
		"another CA":              pair(mustIssue(t, other, ClientAuth)),
		"a node's server cert":    pair(mustIssue(t, ca, ServerAuth, "node.example")),
		"the CA itself as client": pair(ca),
	} {
		if err := client(certs, 0); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	if err := client(pair(mustIssue(t, ca, ClientAuth)), tls.VersionTLS12); err == nil {
		t.Error("TLS 1.2: accepted")
	}
}

// TestServerConfigRefusesBadFiles checks that missing, malformed or
// mismatched files, and a client certificate, are refused.
func TestServerConfigRefusesBadFiles(t *testing.T) {
	dir := t.TempDir()
	ca := mustCA(t)
	srv := mustIssue(t, ca, ServerAuth, "node.example")
	cli := mustIssue(t, ca, ClientAuth)
	crt, key, caf := write(t, dir, "tls.crt", srv.CertPEM), write(t, dir, "tls.key", srv.KeyPEM), write(t, dir, "ca.crt", ca.CertPEM)

	for name, files := range map[string][3]string{
		"missing cert": {filepath.Join(dir, "nope.crt"), key, caf},
		"missing key":  {crt, filepath.Join(dir, "nope.key"), caf},
		"missing CA":   {crt, key, filepath.Join(dir, "nope.crt")},
		"CA not PEM":   {crt, key, write(t, dir, "garbage", []byte("hello"))},
		"key mismatch": {crt, write(t, dir, "other.key", cli.KeyPEM), caf},
		"client cert":  {write(t, dir, "cli.crt", cli.CertPEM), write(t, dir, "cli.key", cli.KeyPEM), caf},
	} {
		if _, _, err := ServerConfig(files[0], files[1], files[2]); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// TestExpiry checks the expiry descriptions: fine, close, expired, not yet valid.
func TestExpiry(t *testing.T) {
	c := &x509.Certificate{NotAfter: now.Add(100 * 24 * time.Hour)}
	if w := Expiry(c, now, ExpiryWarning); w != "" {
		t.Errorf("fresh certificate: %q", w)
	}
	if w := Expiry(c, now.Add(80*24*time.Hour), ExpiryWarning); !strings.Contains(w, "expires") {
		t.Errorf("close to expiry: %q", w)
	}
	if w := Expiry(c, now.Add(101*24*time.Hour), ExpiryWarning); !strings.Contains(w, "expired") {
		t.Errorf("expired: %q", w)
	}
	c.NotBefore = now.Add(time.Hour)
	if w := Expiry(c, now, ExpiryWarning); !strings.Contains(w, "not valid before") {
		t.Errorf("not yet valid: %q", w)
	}
}
