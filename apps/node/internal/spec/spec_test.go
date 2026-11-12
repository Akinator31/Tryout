package spec

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The fixtures are shared with the control plane tests: both validators must
// agree on every file.
const fixtures = "../../../../schema/testdata/session_request"

func TestEmbeddedSchemaIsInSync(t *testing.T) {
	src, err := os.ReadFile("../../../../schema/tryout.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(src, schemaJSON) {
		t.Fatal("internal/spec/tryout.schema.json is stale: run scripts/sync-schema.sh")
	}
}

func TestSessionRequestFixtures(t *testing.T) {
	for _, want := range []string{"valid", "invalid"} {
		files, _ := filepath.Glob(filepath.Join(fixtures, want, "*.json"))
		if len(files) == 0 {
			t.Fatalf("no %s fixtures", want)
		}
		for _, f := range files {
			t.Run(want+"/"+filepath.Base(f), func(t *testing.T) {
				body, err := os.ReadFile(f)
				if err != nil {
					t.Fatal(err)
				}
				err = ValidateSessionRequest(body)
				if want == "valid" && err != nil {
					t.Fatalf("rejected: %v", err)
				}
				if want == "invalid" && err == nil {
					t.Fatal("accepted")
				}
				if err != nil {
					t.Log(err)
				}
			})
		}
	}
}

func TestErrorNamesThePath(t *testing.T) {
	err := ValidateSessionRequest([]byte(`{"id":"abcdefghijklmnopqrstuvwxyz","project":"p","image":"x","kind":"terminal","port":7681,"max_age_s":60,"limits":{"cpus":0}}`))
	if err == nil || !strings.Contains(err.Error(), "/limits/cpus") {
		t.Fatalf("got %v", err)
	}
}

func TestInvalidJSON(t *testing.T) {
	if err := ValidateSessionRequest([]byte(`{`)); err == nil {
		t.Fatal("accepted")
	}
}

func TestUnknownFieldReportedBesideOtherErrors(t *testing.T) {
	err := ValidateSessionRequest([]byte(`{"id":"abcdefghijklmnopqrstuvwxyz","project":"p","image":"x","kind":"terminal","port":0,"max_age_s":60,"privileged":true}`))
	if err == nil || !strings.Contains(err.Error(), "/privileged: unknown field") || !strings.Contains(err.Error(), "/port:") {
		t.Fatalf("got %v", err)
	}
	if strings.Contains(err.Error(), "/port: unknown field") {
		t.Fatalf("failing field also reported as unknown: %v", err)
	}
}
