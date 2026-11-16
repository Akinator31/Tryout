package agent

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// TestPrepareTTYD checks that the agent pulls the ttyd image at startup and
// refuses one built for another architecture.
func TestPrepareTTYD(t *testing.T) {
	for arch, wantErr := range map[string]bool{"amd64": false, "arm64": true} {
		pulled := false
		docker := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
			switch {
			case strings.HasSuffix(r.URL.Path, "/images/create"):
				pulled = r.URL.Query().Get("fromImage") == "ttyd@sha256:0123"
				_, _ = w.Write([]byte(`{"status":"done"}`))
			case strings.HasSuffix(r.URL.Path, "/json") && pulled:
				_, _ = w.Write([]byte(`{"Id":"sha256:x","Architecture":"` + arch + `","Os":"linux"}`))
			default:
				http.Error(w, `{"message":"no such image"}`, http.StatusNotFound)
			}
		})
		a := New(Config{Profile: "strict", TTYDImage: "ttyd@sha256:0123"}, docker, nil, &fakeGateway{})
		a.arch = "amd64"

		err := a.PrepareTTYD(context.Background())
		if !pulled || (err != nil) != wantErr {
			t.Errorf("ttyd image for %s: pulled %v, err %v", arch, pulled, err)
		}
	}
}
