package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
)

// PrepareTTYD pulls the ttyd image (TTYD_IMAGE) and checks its architecture,
// so that no visitor waits for it and a wrong image stops the agent at
// startup rather than failing every terminal. It runs after CheckProfile,
// which records the node's architecture. Outside dev, an image not pinned
// by digest is only a warning: the operator chose it.
func (a *Agent) PrepareTTYD(ctx context.Context) error {
	ref := a.policy.TTYDImage
	if ref == "" {
		return errors.New("TTYD_IMAGE required: this agent was not built with a ttyd image (published images are)")
	}

	if _, err := a.ensureImage(ctx, ref); err != nil {
		return fmt.Errorf("TTYD_IMAGE: %w", err)
	}

	if a.policy.Profile != "dev" && !strings.Contains(ref, "@sha256:") {
		slog.Warn("TTYD_IMAGE is not pinned by digest: the ttyd that terminals run may change with the tag", "image", ref)
	}
	slog.Info("ttyd image ready", "image", ref)
	return nil
}
