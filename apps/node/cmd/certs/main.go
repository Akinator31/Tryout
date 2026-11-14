// tryout-certs: creates the private PKI of the mutual TLS link between the
// control plane and the agents (docs/certificates.md).
//
// Layout of the output directory; each sub-directory is what one machine needs:
//
//	ca/ca.crt, ca/ca.key                 the CA: keep it on the operator's machine only
//	control-plane/tls.crt, tls.key, ca.crt   the control plane's client certificate
//	nodes/<name>/tls.crt, tls.key, ca.crt    an agent's server certificate
//
// Files of this package: main.go (command line), commands.go (init, node,
// client, inspect), writer.go (files with fixed modes and owner).
package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

const usage = `usage: tryout-certs <command> [flags]

commands:
  init                     create the CA and the control plane's client certificate
  node <name> --san <host> create the server certificate of a node's agent (--san repeatable)
  client                   issue a new client certificate for the control plane
  inspect                  list the certificates and their expiry dates

common flags:
  --dir <path>      output directory (default ./pki)
  --force           replace existing leaf certificates (the CA is never replaced)
  --if-missing      do nothing, successfully, if the files already exist
  --owner uid:gid   chown the written files (when running as root, e.g. in a container)
  --days <n>        validity of leaf certificates (default 365)
`

// nodeNameRe matches the node names of the control plane configuration.
var nodeNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// opts are the common flags, plus --san for the node command.
type opts struct {
	dir       string
	force     bool
	ifMissing bool
	owner     string
	days      int
	sans      sanList
}

// sanList is the repeatable --san flag; each value may also be a
// comma-separated list.
type sanList []string

func (s *sanList) String() string {
	return strings.Join(*s, ",")
}

func (s *sanList) Set(v string) error {
	*s = append(*s, strings.Split(v, ",")...)
	return nil
}

func main() {
	if err := run(os.Args[1:], os.Stdout, time.Now()); err != nil {
		fmt.Fprintln(os.Stderr, "tryout-certs:", err)
		os.Exit(1)
	}
}

// run parses the command line and runs the command. Every argument is
// checked before anything is written.
func run(args []string, out io.Writer, now time.Time) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(out, usage)
		return nil
	}
	cmd, args := args[0], args[1:]

	var name string
	if cmd == "node" {
		var err error
		if name, args, err = parseNodeName(args); err != nil {
			return err
		}
	}

	o, err := parseFlags(cmd, args)
	if err != nil {
		return err
	}

	c := command{opts: o, out: out, now: now, validity: time.Duration(o.days) * 24 * time.Hour}
	switch cmd {
	case "init":
		return c.initPKI()
	case "client":
		return c.issue(controlPlaneLeaf)
	case "node":
		if len(o.sans) == 0 {
			return errors.New("node: at least one --san is required: the host name or IP address in the node's agent_url")
		}
		return c.issue(nodeLeaf(name, o.sans))
	case "inspect":
		return inspect(o.dir, out, now)
	}
	return fmt.Errorf("unknown command %q\n\n%s", cmd, usage)
}

// parseNodeName takes the node name, the node command's first argument.
func parseNodeName(args []string) (name string, rest []string, err error) {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return "", nil, errors.New("node: missing node name")
	}

	name, rest = args[0], args[1:]
	if !nodeNameRe.MatchString(name) {
		return "", nil, fmt.Errorf("node: invalid name %q (lower-case letters, digits and -, as in the control plane configuration)", name)
	}
	return name, rest, nil
}

// parseFlags parses and checks the flags of cmd.
func parseFlags(cmd string, args []string) (opts, error) {
	var o opts
	fset := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fset.SetOutput(io.Discard)
	fset.StringVar(&o.dir, "dir", "pki", "")
	fset.BoolVar(&o.force, "force", false, "")
	fset.BoolVar(&o.ifMissing, "if-missing", false, "")
	fset.StringVar(&o.owner, "owner", "", "")
	fset.IntVar(&o.days, "days", 365, "")
	if cmd == "node" {
		fset.Var(&o.sans, "san", "")
	}

	if err := fset.Parse(args); err != nil {
		return o, fmt.Errorf("%s: %w", cmd, err)
	}
	if fset.NArg() > 0 {
		return o, fmt.Errorf("%s: unexpected argument %q", cmd, fset.Arg(0))
	}

	if o.days < 1 {
		return o, errors.New("--days must be at least 1")
	}
	if o.force && o.ifMissing {
		return o, errors.New("--force and --if-missing are exclusive")
	}
	if _, _, err := (writer{o.owner}).ids(); err != nil {
		return o, err
	}
	return o, nil
}
