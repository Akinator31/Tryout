package routes

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"testing"
)

// TestPutOverUnixSocket checks that the client sends the whole table, with
// the bearer token, over the unix socket, and reports a refusal.
func TestPutOverUnixSocket(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "gateway.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}

	var got []Route
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut || r.URL.Path != "/routes" || r.Header.Get("Authorization") != "Bearer secret" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.WriteHeader(http.StatusNoContent)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })

	table := []Route{{ID: "a", Target: "http://tryout-s-a:7681", StripPrefix: true}}
	if err := NewClient(sock, "secret").Put(context.Background(), table); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != table[0] {
		t.Errorf("gateway got %+v", got)
	}

	if err := NewClient(sock, "wrong").Put(context.Background(), table); err == nil {
		t.Error("a refused table must be an error")
	}
}
