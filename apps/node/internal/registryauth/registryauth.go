// Package registryauth gives the agent credentials for pulling private
// project images (ADR 0017).
//
// It reads a file in the Docker CLI's config.json format and uses only its
// static "auths" entries. Credential helpers ("credsStore", "credHelpers") are
// refused: they are external programs the agent will not run. Errors never
// contain a credential, so they are safe to log.
package registryauth

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"slices"
	"strings"
)

const dockerHub = "docker.io"

type entry struct {
	Auth          string `json:"auth"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	IdentityToken string `json:"identitytoken"`
}

type file struct {
	Auths       map[string]entry  `json:"auths"`
	CredsStore  string            `json:"credsStore"`
	CredHelpers map[string]string `json:"credHelpers"`
}

// Store maps a registry host to its X-Registry-Auth header value.
// A nil Store has no credentials.
type Store struct {
	headers map[string]string
}

// Load reads and checks a config.json-style file. Every entry must be usable:
// a broken entry is a startup error, not a pull that fails later.
func Load(path string) (*Store, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		// The decoder's message can quote a character of the file: report
		// the position only.
		var se *json.SyntaxError
		if errors.As(err, &se) {
			return nil, fmt.Errorf("parse %s: invalid JSON at byte %d", path, se.Offset)
		}
		return nil, fmt.Errorf("parse %s: not a Docker config.json", path)
	}
	var errs []error
	if f.CredsStore != "" || len(f.CredHelpers) > 0 {
		errs = append(errs, fmt.Errorf("%s: credential helpers (credsStore, credHelpers) are not supported; write static \"auths\" entries", path))
	}
	if len(f.Auths) == 0 {
		errs = append(errs, fmt.Errorf("%s: no registry in \"auths\"", path))
	}
	s := &Store{headers: map[string]string{}}
	keysByHost := map[string][]string{}
	for key := range f.Auths {
		host, err := normalizeKey(key)
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: registry %s: %w", path, key, err))
			continue
		}
		keysByHost[host] = append(keysByHost[host], key)
	}
	for _, host := range slices.Sorted(maps.Keys(keysByHost)) {
		keys := keysByHost[host]
		if len(keys) > 1 {
			slices.Sort(keys)
			errs = append(errs, fmt.Errorf("%s: two entries for registry %s: %s", path, host, strings.Join(keys, ", ")))
			continue
		}
		h, err := header(keys[0], f.Auths[keys[0]])
		if err != nil {
			errs = append(errs, fmt.Errorf("%s: registry %s: %w", path, keys[0], err))
			continue
		}
		s.headers[host] = h
	}
	if err := errors.Join(errs...); err != nil {
		return nil, err
	}
	return s, nil
}

// header builds the base64url JSON AuthConfig the Engine API expects.
func header(serverAddress string, e entry) (string, error) {
	type authConfig struct {
		Username      string `json:"username,omitempty"`
		Password      string `json:"password,omitempty"`
		IdentityToken string `json:"identitytoken,omitempty"`
		ServerAddress string `json:"serveraddress"`
	}
	ac := authConfig{Username: e.Username, Password: e.Password, IdentityToken: e.IdentityToken, ServerAddress: serverAddress}
	if e.Auth != "" {
		dec, err := base64.StdEncoding.DecodeString(e.Auth)
		if err != nil {
			return "", errors.New(`"auth" is not valid base64`)
		}
		user, pass, ok := strings.Cut(string(dec), ":")
		if !ok {
			return "", errors.New(`"auth" must encode "user:password"`)
		}
		ac.Username, ac.Password = user, pass
	}
	if ac.IdentityToken == "" && (ac.Username == "" || ac.Password == "") {
		return "", errors.New("no credentials: set \"auth\", \"username\" and \"password\", or \"identitytoken\"")
	}
	b, err := json.Marshal(ac)
	if err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// normalizeKey turns an "auths" key ("https://index.docker.io/v1/",
// "ghcr.io") into the registry host RegistryOf returns. A key scoped to a
// path ("ghcr.io/owner", as Podman allows) is refused rather than widened to
// the whole registry; only Docker Hub's legacy "/v1/" suffix is accepted.
func normalizeKey(key string) (string, error) {
	k := strings.ToLower(key)
	k = strings.TrimPrefix(strings.TrimPrefix(k, "https://"), "http://")
	host, rest, _ := strings.Cut(k, "/")
	host = canonical(host)
	if host == "" {
		return "", errors.New("the key must be a registry host")
	}
	if rest = strings.TrimSuffix(rest, "/"); rest != "" && !(host == dockerHub && rest == "v1") {
		return "", errors.New("keys scoped to a path are not supported: use the registry host alone")
	}
	return host, nil
}

func canonical(host string) string {
	switch host {
	case "index.docker.io", "registry-1.docker.io":
		return dockerHub
	}
	return host
}

// RegistryOf returns the registry host of an image reference, with the
// Docker rules: the first path component is a registry only when it contains
// a dot or a colon, or is "localhost"; otherwise the image is on Docker Hub.
func RegistryOf(ref string) string {
	first, _, hasSlash := strings.Cut(ref, "/")
	if !hasSlash {
		return dockerHub
	}
	first = strings.ToLower(first)
	if strings.ContainsAny(first, ".:") || first == "localhost" {
		return canonical(first)
	}
	return dockerHub
}

// HeaderFor returns the X-Registry-Auth value for ref, or "" when there are
// no credentials for its registry.
func (s *Store) HeaderFor(ref string) string {
	if s == nil {
		return ""
	}
	return s.headers[RegistryOf(ref)]
}

// Registries lists the hosts with credentials, sorted, for the startup log.
func (s *Store) Registries() []string {
	if s == nil {
		return nil
	}
	out := make([]string, 0, len(s.headers))
	for h := range s.headers {
		out = append(out, h)
	}
	slices.Sort(out)
	return out
}
