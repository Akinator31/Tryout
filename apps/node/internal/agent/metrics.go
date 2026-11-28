package agent

import (
	"cmp"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/metrics"
	"github.com/Akinator31/Tryout/apps/node/internal/session"
	"github.com/Akinator31/Tryout/apps/node/internal/version"
)

// startBuckets are the upper bounds of the session start time histogram, in
// seconds. A start includes the first pull of an image, which can take
// minutes.
var startBuckets = []float64{0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600}

// agentMetrics are the agent's counters and histograms. Gauges (sessions on
// the node, build info) are read at each scrape instead.
type agentMetrics struct {
	registry     metrics.Registry
	starts       *metrics.Counter
	startSeconds *metrics.Histogram
	reaped       *metrics.Counter
}

// newAgentMetrics declares the agent's metric families.
func newAgentMetrics() *agentMetrics {
	m := &agentMetrics{}
	m.starts = m.registry.NewCounter("tryout_session_starts_total",
		"Session creations by result: ok, full (the node was at MAX_SESSIONS) or error.", "project", "result")
	m.startSeconds = m.registry.NewHistogram("tryout_session_start_seconds",
		"Time to start a session, image pull included, for successful starts.", startBuckets, "project")
	m.reaped = m.registry.NewCounter("tryout_sessions_reaped_total",
		"Sessions removed by the reconcile loop, by reason: expired, dead or stuck.", "reason")
	return m
}

// observeStart records the outcome of a session creation.
func (m *agentMetrics) observeStart(project string, took time.Duration, err error) {
	switch {
	case err == nil:
		m.starts.Inc(project, "ok")
		m.startSeconds.Observe(took.Seconds(), project)
	case errors.Is(err, errNodeFull), errors.Is(err, errGPUFull):
		m.starts.Inc(project, "full")
	default:
		m.starts.Inc(project, "error")
	}
}

// handleMetrics serves the agent's metrics in the Prometheus text format, on
// the mutual TLS API like every other endpoint. When the Docker daemon does
// not answer, the counters are still served, without the session gauge, and
// tryout_node_docker_up is 0.
func (a *Agent) handleMetrics(w http.ResponseWriter, r *http.Request) {
	gauges := []metrics.Gauge{a.infoGauge(), a.maxSessionsGauge()}

	cs, err := a.docker.ContainerList(r.Context(), session.LabelSession)
	if err != nil {
		gauges = append(gauges, dockerUpGauge(false))
	} else {
		gauges = append(gauges, dockerUpGauge(true), sessionsGauge(cs))
	}

	w.Header().Set("Content-Type", metrics.ContentType)
	a.metrics.registry.Write(w, gauges...)
}

// dockerUpGauge tells whether the node's Docker daemon answered this scrape.
func dockerUpGauge(up bool) metrics.Gauge {
	v := 0.0
	if up {
		v = 1
	}
	return metrics.Gauge{
		Name:    "tryout_node_docker_up",
		Help:    "1 when the node's Docker daemon answered this scrape, else 0.",
		Samples: []metrics.Sample{{Value: v}},
	}
}

// infoGauge describes the agent: always 1, the information is in the labels.
func (a *Agent) infoGauge() metrics.Gauge {
	return metrics.Gauge{
		Name:    "tryout_agent_info",
		Help:    "Agent build and configuration.",
		Labels:  []string{"version", "profile", "default_runtime", "arch"},
		Samples: []metrics.Sample{{Labels: []string{version.Version, a.policy.Profile, a.policy.DefaultRuntime, a.arch}, Value: 1}},
	}
}

// sessionsGauge counts the session containers by project and Docker state.
func sessionsGauge(cs []dockerapi.ContainerSummary) metrics.Gauge {
	type key struct{ project, state string }
	counts := map[key]int{}
	for _, c := range cs {
		counts[key{c.Labels[session.LabelProject], c.State}]++
	}
	order := slices.Collect(maps.Keys(counts))

	g := metrics.Gauge{
		Name:   "tryout_node_sessions",
		Help:   "Session containers on the node, by project and Docker state.",
		Labels: []string{"project", "state"},
	}
	slices.SortFunc(order, func(x, y key) int {
		return cmp.Or(strings.Compare(x.project, y.project), strings.Compare(x.state, y.state))
	})
	for _, k := range order {
		g.Samples = append(g.Samples, metrics.Sample{Labels: []string{k.project, k.state}, Value: float64(counts[k])})
	}
	return g
}

// maxSessionsGauge is the node's MAX_SESSIONS.
func (a *Agent) maxSessionsGauge() metrics.Gauge {
	return metrics.Gauge{
		Name:    "tryout_node_sessions_max",
		Help:    "Most sessions the node runs at once (MAX_SESSIONS).",
		Samples: []metrics.Sample{{Value: float64(a.maxSessions)}},
	}
}
