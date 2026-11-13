package main

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/pki"
)

// TestServerTLSIsRequired checks that the agent refuses to start without its
// three TLS files, naming the missing variables.
func TestServerTLSIsRequired(t *testing.T) {
	_, _, err := serverTLS(config{tlsCert: "/x/tls.crt"}, time.Now())
	if err == nil || !strings.Contains(err.Error(), "AGENT_TLS_CLIENT_CA, AGENT_TLS_KEY required") {
		t.Errorf("missing variables: %v", err)
	}

	unreadable := config{tlsCert: "/nope/tls.crt", tlsKey: "/nope/tls.key", tlsClientCA: "/nope/ca.crt"}
	if _, _, err := serverTLS(unreadable, time.Now()); err == nil {
		t.Error("unreadable files accepted")
	}
}

// TestAPIOverMutualTLS checks that the API is served over mutual TLS only:
// no client certificate, no request. An expired certificate is refused at
// startup.
func TestAPIOverMutualTLS(t *testing.T) {
	dir := t.TempDir()
	ca, _ := pki.NewCA("ca", time.Now(), pki.CAValidity)
	srv, _ := ca.Issue(pki.ServerAuth, "agent", []string{"127.0.0.1"}, time.Now(), pki.LeafValidity)
	cli, _ := ca.Issue(pki.ClientAuth, "cp", nil, time.Now(), pki.LeafValidity)
	files := config{
		tlsCert:     writeTestFile(t, dir, "tls.crt", srv.CertPEM),
		tlsKey:      writeTestFile(t, dir, "tls.key", srv.KeyPEM),
		tlsClientCA: writeTestFile(t, dir, "ca.crt", ca.CertPEM),
	}

	if _, _, err := serverTLS(files, time.Now().Add(pki.LeafValidity+time.Hour)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("expired certificate: %v", err)
	}

	cfg, _, err := serverTLS(files, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(testAgent("dev", false).apiHandler())
	ts.TLS = cfg
	ts.Config.ErrorLog = log.New(io.Discard, "", 0)
	ts.StartTLS()
	defer ts.Close()

	roots := x509.NewCertPool()
	roots.AddCert(ca.Cert)
	get := func(certs []tls.Certificate) (*http.Response, error) {
		c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, Certificates: certs}}}
		return c.Get(ts.URL + "/healthz")
	}

	if _, err := get(nil); err == nil {
		t.Error("request without a client certificate reached the API")
	}

	resp, err := get([]tls.Certificate{{Certificate: [][]byte{cli.Cert.Raw}, PrivateKey: cli.Key}})
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status %d", resp.StatusCode)
	}
}
