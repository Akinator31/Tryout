package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/Akinator31/Tryout/apps/node/internal/registryauth"
)

// TestEnsureImageSendsRegistryAuth checks that a missing image is pulled with
// the credentials of its registry, and only of its registry.
func TestEnsureImageSendsRegistryAuth(t *testing.T) {
	store := loadTestRegistry(t, `{"auths":{"ghcr.io":{"auth":"`+base64.StdEncoding.EncodeToString([]byte("bot:token"))+`"}}}`)

	for ref, wantUser := range map[string]string{"ghcr.io/owner/app:edge": "bot", "quay.io/other/app:1": ""} {
		t.Run(ref, func(t *testing.T) {
			pulls := &fakePulls{}
			a := New(Config{}, fakeDockerClient(t, pulls.serve), store, &fakeGateway{})
			a.arch = "amd64"

			if _, err := a.ensureImage(context.Background(), ref); err != nil {
				t.Fatalf("%s: %v", ref, err)
			}

			gotAuth := pulls.registryAuth()
			if wantUser == "" {
				if gotAuth != "" {
					t.Errorf("%s: credentials sent to the wrong registry", ref)
				}
				return
			}

			raw, err := base64.URLEncoding.DecodeString(gotAuth)
			if err != nil {
				t.Fatalf("%s: X-Registry-Auth %q: %v", ref, gotAuth, err)
			}
			var ac map[string]string
			if err := json.Unmarshal(raw, &ac); err != nil || ac["username"] != wantUser || ac["password"] != "token" {
				t.Errorf("%s: X-Registry-Auth = %s (%v)", ref, raw, err)
			}
		})
	}
}

// loadTestRegistry loads a registry credentials file with the given content.
func loadTestRegistry(t *testing.T, content string) *registryauth.Store {
	t.Helper()

	path := writeTestFile(t, t.TempDir(), "config.json", []byte(content))
	store, err := registryauth.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// fakePulls is a fake Engine API where every image is missing until pulled.
// It records the X-Registry-Auth header of the pull.
type fakePulls struct {
	mu      sync.Mutex
	pulled  bool
	gotAuth string
}

// serve is the fake daemon's HTTP handler.
func (f *fakePulls) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()

	switch {
	case strings.HasSuffix(r.URL.Path, "/images/create"):
		f.pulled, f.gotAuth = true, r.Header.Get("X-Registry-Auth")
		_, _ = w.Write([]byte(`{"status":"done"}`))
	case strings.HasSuffix(r.URL.Path, "/json") && f.pulled:
		_, _ = w.Write([]byte(`{"Id":"sha256:x","Architecture":"amd64","Os":"linux"}`))
	default:
		http.Error(w, `{"message":"no such image"}`, http.StatusNotFound)
	}
}

// registryAuth returns the X-Registry-Auth header of the pull, "" if none.
func (f *fakePulls) registryAuth() string {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.gotAuth
}
