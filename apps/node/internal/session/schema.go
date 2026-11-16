package session

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

// printer renders the library's error messages in English.
var printer = message.NewPrinter(language.English)

// schemaJSON is the embedded copy of schema/tryout.schema.json at the
// repository root (go:embed cannot reach outside the module); keep it in sync
// with scripts/sync-schema.sh. The control plane validates its configuration
// against the same file, so a project accepted there has the shape the agent
// expects here.
//
//go:embed tryout.schema.json
var schemaJSON []byte

// sessionRequest is the compiled schema of the POST /v1/sessions body.
var sessionRequest = mustCompile("#/$defs/session_request")

// mustCompile compiles the schema at ref in the embedded document. It panics
// at startup on an invalid schema, which the tests would catch first.
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

// validateSchema checks the raw JSON body of POST /v1/sessions.
// Unknown fields are rejected: a field this agent does not know might be a
// setting it would otherwise silently ignore.
func validateSchema(body []byte) error {
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
	var c errorCollector
	c.walk(ve, "", "")
	return strings.Join(c.messages(), "; ")
}

// errorCollector gathers the leaves of a validation error tree.
type errorCollector struct {
	errs     []string // "path: message" of the real errors
	errPaths []string // their paths
	unknown  []string // paths of the false-schema leaves
}

// walk visits the error tree down to its leaves. name and at are set below a
// propertyNames error, whose leaves point at the document root instead of the
// object holding the name. The library fills that error's InstanceLocation
// from a reused buffer, so the field is taken from its schema location
// (".../properties/env/propertyNames").
func (c *errorCollector) walk(e *jsonschema.ValidationError, name, at string) {
	if pn, ok := e.ErrorKind.(*kind.PropertyNames); ok {
		field := strings.TrimSuffix(e.SchemaURL, "/propertyNames")
		name, at = pn.Property, "/"+field[strings.LastIndex(field, "/")+1:]
	}

	if len(e.Causes) > 0 {
		for _, cause := range e.Causes {
			c.walk(cause, name, at)
		}
		return
	}

	path := "/" + strings.Join(e.InstanceLocation, "/")
	if at != "" {
		path = at
	}
	c.addLeaf(e, path, name)
}

// addLeaf records one leaf error at path; name is the offending property
// name below a propertyNames error, if any.
func (c *errorCollector) addLeaf(e *jsonschema.ValidationError, path, name string) {
	switch e.ErrorKind.(type) {
	case *kind.FalseSchema:
		c.unknown = append(c.unknown, path)
		return

	case *kind.Not:
		if name != "" {
			c.errs = append(c.errs, fmt.Sprintf("%s: name %q is reserved", path, name))
		} else {
			c.errs = append(c.errs, path+": value is not allowed")
		}

	default:
		msg := e.ErrorKind.LocalizedString(printer)
		if name != "" {
			msg = fmt.Sprintf("name %q: %s", name, msg)
		}
		c.errs = append(c.errs, path+": "+msg)
	}
	c.errPaths = append(c.errPaths, path)
}

// messages returns the real errors, then an "unknown field" error for each
// false-schema path that has no real error at or below it.
func (c *errorCollector) messages() []string {
	out := c.errs
	for _, u := range c.unknown {
		hasError := slices.ContainsFunc(c.errPaths, func(p string) bool {
			return p == u || strings.HasPrefix(p, u+"/")
		})
		if !hasError {
			out = append(out, u+": unknown field")
		}
	}
	return out
}

// schemaReservedEnv returns the literal names and prefixes of
// $defs/reserved_env, so that the tests can check them against the
// environment the agent locks.
func schemaReservedEnv() (names []string, prefixes []string) {
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
