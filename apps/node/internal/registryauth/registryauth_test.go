package registryauth

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func b64(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

// decode reads an X-Registry-Auth value the way the Docker daemon does.
func decode(t *testing.T, h string) map[string]string {
	t.Helper()
	raw, err := base64.URLEncoding.DecodeString(h)
	if err != nil {
		t.Fatalf("header is not base64url: %v", err)
	}
	var m map[string]string
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("header is not JSON: %v", err)
	}
	return m
}

func TestRegistryOf(t *testing.T) {
	for ref, want := range map[string]string{
		"alpine":                    "docker.io",
		"alpine:3.22":               "docker.io",
		"library/alpine":            "docker.io",
		"docker.io/library/alpine":  "docker.io",
		"index.docker.io/me/app:1":  "docker.io",
		"ghcr.io/owner/app:edge":    "ghcr.io",
		"GHCR.io/owner/app":         "ghcr.io",
		"registry.example:5000/app": "registry.example:5000",
		"localhost/app":             "localhost",
		"localhost:5000/app@sha256:" + strings.Repeat("a", 64): "localhost:5000",
		"me/app@sha256:" + strings.Repeat("b", 64):             "docker.io",
	} {
		if got := RegistryOf(ref); got != want {
			t.Errorf("RegistryOf(%q) = %q, want %q", ref, got, want)
		}
	}
}

func TestHeaderForMatchingRegistry(t *testing.T) {
	s, err := Load(write(t, `{"auths": {
		"ghcr.io": {"auth": "`+b64("bot:s3cret:with-colon")+`"},
		"https://index.docker.io/v1/": {"username": "hub", "password": "pw"},
		"registry.example:5000": {"identitytoken": "tok"}
	}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Registries(); strings.Join(got, ",") != "docker.io,ghcr.io,registry.example:5000" {
		t.Errorf("Registries() = %v", got)
	}

	h := decode(t, s.HeaderFor("ghcr.io/owner/app:edge"))
	if h["username"] != "bot" || h["password"] != "s3cret:with-colon" || h["serveraddress"] != "ghcr.io" {
		t.Errorf("ghcr header = %v", h)
	}
	h = decode(t, s.HeaderFor("me/app:1"))
	if h["username"] != "hub" || h["password"] != "pw" || h["serveraddress"] != "https://index.docker.io/v1/" {
		t.Errorf("hub header = %v", h)
	}
	h = decode(t, s.HeaderFor("registry.example:5000/app"))
	if h["identitytoken"] != "tok" || h["password"] != "" {
		t.Errorf("token header = %v", h)
	}
	if got := s.HeaderFor("quay.io/other/app"); got != "" {
		t.Errorf("no credentials for quay.io, got header %q", got)
	}
}

func TestNilStoreSendsNothing(t *testing.T) {
	var s *Store
	if got := s.HeaderFor("ghcr.io/owner/app"); got != "" {
		t.Errorf("nil store: got %q", got)
	}
	if got := s.Registries(); len(got) != 0 {
		t.Errorf("nil store registries: %v", got)
	}
}

func TestLoadRefusals(t *testing.T) {
	for name, c := range map[string]struct{ content, want string }{
		"invalid JSON":    {`{`, "parse"},
		"credsStore":      {`{"auths": {}, "credsStore": "desktop"}`, "credential helpers"},
		"credHelpers":     {`{"credHelpers": {"ghcr.io": "gh"}}`, "credential helpers"},
		"bad base64":      {`{"auths": {"ghcr.io": {"auth": "%%%"}}}`, "ghcr.io"},
		"auth no colon":   {`{"auths": {"ghcr.io": {"auth": "` + b64("nocolon") + `"}}}`, "ghcr.io"},
		"empty entry":     {`{"auths": {"ghcr.io": {}}}`, "no credentials"},
		"duplicate hub":   {`{"auths": {"docker.io": {"auth": "` + b64("a:b") + `"}, "https://index.docker.io/v1/": {"auth": "` + b64("c:d") + `"}}}`, "docker.io"},
		"no auths at all": {`{}`, "no registry"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Load(write(t, c.content))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("err = %v, want it to mention %q", err, c.want)
			}
		})
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("a missing file must be refused")
	}
}

func TestErrorsNeverContainSecrets(t *testing.T) {
	_, err := Load(write(t, `{"auths": {"ghcr.io": {"auth": "`+b64("nocolon-supersecret")+`"}}}`))
	if err == nil || strings.Contains(err.Error(), "supersecret") || strings.Contains(err.Error(), b64("nocolon-supersecret")) {
		t.Fatalf("err = %v", err)
	}
}
