// Package pki issues and loads the certificates of the mutual TLS link
// between the control plane and the agent (ADR 0015).
//
// One private CA per deployment signs two kinds of leaf certificates, each
// with a single extended key usage: agents get serverAuth only, the control
// plane gets clientAuth only. A node's certificate therefore cannot be used
// to impersonate the control plane towards another node.
package pki

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"slices"
	"strings"
	"time"
)

// Default validity periods.
const (
	CAValidity   = 10 * 365 * 24 * time.Hour
	LeafValidity = 365 * 24 * time.Hour
	// ExpiryWarning is how long before expiry the agent starts warning.
	ExpiryWarning = 30 * 24 * time.Hour
)

// Usage is the single extended key usage of a leaf certificate.
type Usage int

const (
	ServerAuth Usage = iota // an agent's API
	ClientAuth              // the control plane
)

func (u Usage) eku() x509.ExtKeyUsage {
	if u == ClientAuth {
		return x509.ExtKeyUsageClientAuth
	}
	return x509.ExtKeyUsageServerAuth
}

// Pair is a certificate and its private key, parsed and PEM-encoded.
type Pair struct {
	Cert *x509.Certificate
	// Chain is the DER chain from the certificate file: the leaf, then any
	// intermediates (a PKI other than tryout-certs may use some).
	Chain   [][]byte
	Key     crypto.Signer
	CertPEM []byte
	KeyPEM  []byte
}

// NewCA creates a self-signed CA that can only sign leaf certificates.
func NewCA(name string, now time.Time, validity time.Duration) (*Pair, error) {
	tpl := &x509.Certificate{
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(validity),
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
	}
	return sign(tpl, nil)
}

// Issue signs a leaf certificate. SANs that parse as IP addresses become IP
// SANs, the others DNS names. A server certificate needs at least one SAN.
func (ca *Pair) Issue(u Usage, name string, sans []string, now time.Time, validity time.Duration) (*Pair, error) {
	if !ca.Cert.IsCA {
		return nil, errors.New("issuer is not a CA")
	}
	if u == ServerAuth && len(sans) == 0 {
		return nil, errors.New("a server certificate needs at least one subject alternative name")
	}
	notAfter := now.Add(validity)
	if notAfter.After(ca.Cert.NotAfter) {
		return nil, fmt.Errorf("the CA expires on %s, before the certificate would", ca.Cert.NotAfter.Format(time.DateOnly))
	}
	tpl := &x509.Certificate{
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              notAfter,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{u.eku()},
	}
	for _, s := range sans {
		if ip := net.ParseIP(s); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
		} else if s != "" {
			tpl.DNSNames = append(tpl.DNSNames, s)
		}
	}
	return sign(tpl, ca)
}

func sign(tpl *x509.Certificate, issuer *Pair) (*Pair, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	tpl.SerialNumber = serial
	parent, signer := tpl, crypto.Signer(key)
	if issuer != nil {
		parent, signer = issuer.Cert, issuer.Key
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, parent, key.Public(), signer)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	return &Pair{
		Cert:    cert,
		Chain:   [][]byte{der},
		Key:     key,
		CertPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		KeyPEM:  pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
	}, nil
}

// LoadPair reads a PEM certificate and its PKCS#8, EC or PKCS#1 private key.
func LoadPair(certFile, keyFile string) (*Pair, error) {
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, err
	}
	tc, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("%s / %s: %w", certFile, keyFile, err)
	}
	signer, ok := tc.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("%s: unsupported key type", keyFile)
	}
	return &Pair{Cert: tc.Leaf, Chain: tc.Certificate, Key: signer, CertPEM: certPEM, KeyPEM: keyPEM}, nil
}

// LoadCerts reads every certificate of a PEM file.
func LoadCerts(file string) ([]*x509.Certificate, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var out []*x509.Certificate
	for {
		var block *pem.Block
		block, b = pem.Decode(b)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			continue
		}
		c, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", file, err)
		}
		out = append(out, c)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no PEM certificate", file)
	}
	return out, nil
}

// ServerConfig is the agent's TLS configuration: TLS 1.3 only, and every
// client must present a certificate signed by clientCAFile with the
// clientAuth usage (Go checks the usage when it verifies the chain).
// It also returns the certificates it loaded, for expiry checks.
func ServerConfig(certFile, keyFile, clientCAFile string) (*tls.Config, []*x509.Certificate, error) {
	pair, err := LoadPair(certFile, keyFile)
	if err != nil {
		return nil, nil, err
	}
	if !hasUsage(pair.Cert, x509.ExtKeyUsageServerAuth) {
		return nil, nil, fmt.Errorf("%s: the certificate does not allow server authentication", certFile)
	}
	cas, err := LoadCerts(clientCAFile)
	if err != nil {
		return nil, nil, err
	}
	pool := x509.NewCertPool()
	for _, c := range cas {
		pool.AddCert(c)
	}
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{{Certificate: pair.Chain, PrivateKey: pair.Key, Leaf: pair.Cert}},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    pool,
		// Go accepts a certificate without an EKU extension (such as the CA
		// itself) for any usage: require a leaf that states clientAuth.
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("no client certificate")
			}
			leaf := cs.PeerCertificates[0]
			if leaf.IsCA || !slices.Contains(leaf.ExtKeyUsage, x509.ExtKeyUsageClientAuth) {
				return errors.New("the client certificate must be a leaf with the clientAuth extended key usage")
			}
			return nil
		},
	}
	return cfg, append([]*x509.Certificate{pair.Cert}, cas...), nil
}

func hasUsage(c *x509.Certificate, u x509.ExtKeyUsage) bool {
	// No EKU extension means any usage.
	return len(c.ExtKeyUsage) == 0 || slices.Contains(c.ExtKeyUsage, u) || slices.Contains(c.ExtKeyUsage, x509.ExtKeyUsageAny)
}

// Expiry describes a certificate that is expired, not yet valid, or expires
// within warn, or returns "" when it is fine. The control plane makes the
// same checks with the same 30-day warning (src/config.ts, loadAgentTls).
func Expiry(c *x509.Certificate, now time.Time, warn time.Duration) string {
	left := c.NotAfter.Sub(now)
	switch {
	case now.Before(c.NotBefore):
		return fmt.Sprintf("certificate %q is not valid before %s", c.Subject.CommonName, c.NotBefore.Format(time.RFC3339))
	case left <= 0:
		return fmt.Sprintf("certificate %q expired on %s", c.Subject.CommonName, c.NotAfter.Format(time.DateOnly))
	case left <= warn:
		return fmt.Sprintf("certificate %q expires on %s (in %d days)", c.Subject.CommonName, c.NotAfter.Format(time.DateOnly), int(left.Hours()/24))
	}
	return ""
}

// Describe returns a one-line summary of a certificate, for the certs tool.
func Describe(c *x509.Certificate) string {
	usage := "ca"
	if !c.IsCA {
		var us []string
		for _, e := range c.ExtKeyUsage {
			switch e {
			case x509.ExtKeyUsageServerAuth:
				us = append(us, "server")
			case x509.ExtKeyUsageClientAuth:
				us = append(us, "client")
			default:
				us = append(us, "other")
			}
		}
		usage = strings.Join(us, "+")
	}
	sans := append([]string{}, c.DNSNames...)
	for _, ip := range c.IPAddresses {
		sans = append(sans, ip.String())
	}
	s := fmt.Sprintf("%s (%s) not after %s", c.Subject.CommonName, usage, c.NotAfter.Format(time.DateOnly))
	if len(sans) > 0 {
		s += " san=" + strings.Join(sans, ",")
	}
	return s
}
