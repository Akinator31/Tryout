// Package version holds what the node binaries were built with, set at build
// time:
//
//	go build -ldflags "-X github.com/Akinator31/Tryout/apps/node/internal/version.Version=0.2.0"
//
// The image build passes them from the VERSION and TTYD_IMAGE build
// arguments.
package version

// Version is the release the binary was built from, or "dev".
var Version = "dev"

// TTYDImage is the ttyd image the release was built with, pinned by digest:
// the agent's default TTYD_IMAGE. Empty in a local build, where TTYD_IMAGE
// must be set.
var TTYDImage = ""
