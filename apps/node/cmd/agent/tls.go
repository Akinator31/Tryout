package main

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/pki"
)

// serverTLS loads the listener's mutual TLS configuration and refuses an
// expired certificate. There is no plain-HTTP mode: the TLS handshake is the
// API's only authentication.
func serverTLS(cfg config, now time.Time) (*tls.Config, []*x509.Certificate, error) {
	if missing := missingTLSVars(cfg); len(missing) > 0 {
		return nil, nil, fmt.Errorf("%s required (mutual TLS, see docs/certificates.md)", strings.Join(missing, ", "))
	}

	tlsCfg, certs, err := pki.ServerConfig(cfg.tlsCert, cfg.tlsKey, cfg.tlsClientCA)
	if err != nil {
		return nil, nil, err
	}

	for _, c := range certs {
		if w := pki.Expiry(c, now, 0); w != "" {
			return nil, nil, errors.New(w)
		}
	}
	return tlsCfg, certs, nil
}

// missingTLSVars returns the names of the unset TLS variables, sorted.
func missingTLSVars(cfg config) []string {
	vars := map[string]string{
		"AGENT_TLS_CERT":      cfg.tlsCert,
		"AGENT_TLS_KEY":       cfg.tlsKey,
		"AGENT_TLS_CLIENT_CA": cfg.tlsClientCA,
	}

	var missing []string
	for name, value := range vars {
		if value == "" {
			missing = append(missing, name)
		}
	}
	slices.Sort(missing)
	return missing
}

// warnExpiry logs certificates that are expired or close to expiry. Rotation
// is a restart with new files.
func warnExpiry(certs []*x509.Certificate, now time.Time) {
	for _, c := range certs {
		if w := pki.Expiry(c, now, pki.ExpiryWarning); w != "" {
			slog.Warn(w)
		}
	}
}

// expiryCheckInterval is how often a running agent checks its certificates' expiry.
const expiryCheckInterval = 24 * time.Hour

// warnExpiryForever repeats warnExpiry daily, since a long-running agent
// would otherwise only warn at startup.
func warnExpiryForever(certs []*x509.Certificate) {
	for range time.Tick(expiryCheckInterval) {
		warnExpiry(certs, time.Now())
	}
}
