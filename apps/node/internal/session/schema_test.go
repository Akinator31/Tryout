package session

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

// TestEmbeddedSchemaIsInSync checks that the embedded copy matches the source
// of truth at the repository root.
func TestEmbeddedSchemaIsInSync(t *testing.T) {
	src, err := os.ReadFile("../../../../schema/tryout.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(src, schemaJSON) {
		t.Fatal("internal/session/tryout.schema.json is stale: run scripts/sync-schema.sh")
	}
}

// TestSessionRequestFixtures checks every shared fixture: valid ones pass,
// invalid ones fail.
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
				err = validateSchema(body)
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

// TestErrorNamesThePath checks that an error names the failing field.
func TestErrorNamesThePath(t *testing.T) {
	err := validateSchema([]byte(`{"id":"abcdefghijklmnopqrstuvwxyz","project":"p","image":"x","kind":"terminal","ttyd":"image","port":7681,"max_age_s":60,"limits":{"cpus":0}}`))
	if err == nil || !strings.Contains(err.Error(), "/limits/cpus") {
		t.Fatalf("got %v", err)
	}
}

// TestInvalidJSON checks that a body that is not JSON is refused.
func TestInvalidJSON(t *testing.T) {
	if err := validateSchema([]byte(`{`)); err == nil {
		t.Fatal("accepted")
	}
}

// TestUnknownFieldReportedBesideOtherErrors checks that an unknown field is
// reported with the other errors, and that neither the failing field nor its
// valid siblings are also reported as unknown.
func TestUnknownFieldReportedBesideOtherErrors(t *testing.T) {
	err := validateSchema([]byte(`{"id":"abcdefghijklmnopqrstuvwxyz","project":"p","image":"x","kind":"terminal","ttyd":"image","port":0,"max_age_s":60,"privileged":true}`))
	if err == nil || !strings.Contains(err.Error(), "/privileged: unknown field") || !strings.Contains(err.Error(), "/port:") {
		t.Fatalf("got %v", err)
	}
	for _, field := range []string{"/port", "/image", "/kind"} {
		if strings.Contains(err.Error(), field+": unknown field") {
			t.Fatalf("%s reported as unknown: %v", field, err)
		}
	}
}
