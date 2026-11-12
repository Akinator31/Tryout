// Package spec validates agent API requests against the Tryout JSON Schema.
//
// tryout.schema.json is a copy of schema/tryout.schema.json at the
// repository root (go:embed cannot reach outside the module); keep it in sync
// with scripts/sync-schema.sh. The control plane validates its configuration
// against the same file, so a project accepted there has the shape the agent
// expects here.
package spec

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

var printer = message.NewPrinter(language.English)

//go:embed tryout.schema.json
var schemaJSON []byte

var sessionRequest = mustCompile("#/$defs/session_request")

func mustCompile(ref string) *jsonschema.Schema {
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaJSON))
	if err != nil {
		panic(err)
	}
	c := jsonschema.NewCompiler()
	const url = "tryout.schema.json"
	if err := c.AddResource(url, doc); err != nil {
		panic(err)
	}
	s, err := c.Compile(url + ref)
	if err != nil {
		panic(err)
	}
	return s
}

// ValidateSessionRequest checks the raw JSON body of POST /v1/sessions.
// Unknown fields are rejected: a field this agent does not know might be a
// setting it would otherwise silently ignore.
func ValidateSessionRequest(body []byte) error {
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if err := sessionRequest.Validate(inst); err != nil {
		var ve *jsonschema.ValidationError
		if errors.As(err, &ve) {
			return errors.New(describe(ve))
		}
		return err
	}
	return nil
}

// describe flattens the error tree into "path: message" lines, leaves only.
// A field that fails its own schema is also reported by
// unevaluatedProperties as a "false schema"; that duplicate is dropped, and a
// false schema on a field with no other error is reported as unknown.
func describe(ve *jsonschema.ValidationError) string {
	var errs, unknown []string
	var errPaths []string
	// name and at are set below a propertyNames error, whose leaves point at
	// the document root instead of the object holding the name. The library
	// fills that error's InstanceLocation from a reused buffer, so the field
	// is taken from its schema location (".../properties/env/propertyNames").
	var walk func(e *jsonschema.ValidationError, name, at string)
	walk = func(e *jsonschema.ValidationError, name, at string) {
		if pn, ok := e.ErrorKind.(*kind.PropertyNames); ok {
			field := strings.TrimSuffix(e.SchemaURL, "/propertyNames")
			name, at = pn.Property, "/"+field[strings.LastIndex(field, "/")+1:]
		}
		if len(e.Causes) > 0 {
			for _, c := range e.Causes {
				walk(c, name, at)
			}
			return
		}
		path := "/" + strings.Join(e.InstanceLocation, "/")
		if at != "" {
			path = at
		}
		switch e.ErrorKind.(type) {
		case *kind.FalseSchema:
			unknown = append(unknown, path)
			return
		case *kind.Not:
			if name != "" {
				errs = append(errs, fmt.Sprintf("%s: name %q is reserved", path, name))
			} else {
				errs = append(errs, path+": value is not allowed")
			}
		default:
			msg := e.ErrorKind.LocalizedString(printer)
			if name != "" {
				msg = fmt.Sprintf("name %q: %s", name, msg)
			}
			errs = append(errs, path+": "+msg)
		}
		errPaths = append(errPaths, path)
	}
	walk(ve, "", "")
	for _, u := range unknown {
		if !slices.ContainsFunc(errPaths, func(p string) bool { return p == u || strings.HasPrefix(p, u+"/") }) {
			errs = append(errs, u+": unknown field")
		}
	}
	return strings.Join(errs, "; ")
}

// ReservedEnv returns the literal names and prefixes of $defs/reserved_env,
// so that the agent can check them against the environment it locks.
func ReservedEnv() (names []string, prefixes []string) {
	var doc struct {
		Defs struct {
			Reserved struct {
				AnyOf []struct {
					Pattern string   `json:"pattern"`
					Enum    []string `json:"enum"`
				} `json:"anyOf"`
			} `json:"reserved_env"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(schemaJSON, &doc); err != nil {
		panic(err)
	}
	for _, a := range doc.Defs.Reserved.AnyOf {
		names = append(names, a.Enum...)
		if a.Pattern != "" {
			prefixes = append(prefixes, strings.TrimPrefix(a.Pattern, "^"))
		}
	}
	return names, prefixes
}
