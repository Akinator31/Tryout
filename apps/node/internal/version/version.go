// Package version holds the version of the node binaries, set at build time:
//
//	go build -ldflags "-X github.com/Akinator31/Tryout/apps/node/internal/version.Version=0.2.0"
//
// The image build passes it from the VERSION build argument.
package version

// Version is the release the binary was built from, or "dev".
var Version = "dev"
