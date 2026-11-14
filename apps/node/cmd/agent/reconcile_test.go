package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
)

// TestReconcileReattachesGateway: a recreated gateway (an upgrade) is attached
// only to its compose networks. The reconcile loop must attach it again to the
// network of every running session, and leave alone the networks it already
// has, the sessions still being created, the containers that are not running
// (the gateway does not route them), and a session the API starts removing
// during the pass (a reattachment would land between destroy's disconnect
// and its network removal).
func TestReconcileReattachesGateway(t *testing.T) {
	id := func(c string) string { return strings.Repeat(c, 26) }
	attached, missing, creating, stopped, removing := id("a"), id("b"), id("c"), id("d"), id("e")

	future := fmt.Sprint(time.Now().Add(time.Hour).Unix())
	session := func(id string) map[string]any {
		state := "running"
		if id == stopped {
			state = "created"
		}
		labels := map[string]string{labelSession: id, labelExpires: future, labelPort: "7681"}
		labels[labelCreated] = fmt.Sprint(time.Now().Unix())
		return map[string]any{"Id": id, "State": state, "Labels": labels}
	}
	gatewayNetworks := map[string]any{"tryout_default": map[string]any{}, namePrefix + attached: map[string]any{}}

	var mu sync.Mutex
	var connected []string
	var a *agent
	docker := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()

		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/json"):
			_ = json.NewEncoder(w).Encode([]any{session(attached), session(missing), session(creating), session(stopped), session(removing)})

		case r.Method == http.MethodGet && strings.HasSuffix(p, "/networks"):
			_ = json.NewEncoder(w).Encode([]any{})

		case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/tryout-gateway/json"):
			a.startDestroying(removing) // DELETE /v1/sessions/<removing> arrives after the listing
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": "gw", "NetworkSettings": map[string]any{"Networks": gatewayNetworks}})

		case r.Method == http.MethodPost && strings.HasSuffix(p, "/connect"):
			var body struct{ Container string }
			_ = json.NewDecoder(r.Body).Decode(&body)
			net := strings.TrimSuffix(p[strings.Index(p, "/networks/")+len("/networks/"):], "/connect")
			connected = append(connected, net+"<-"+body.Container)
			w.WriteHeader(http.StatusOK)

		default:
			t.Errorf("unexpected docker call %s %s", r.Method, p)
			http.NotFound(w, r)
		}
	})

	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	t.Cleanup(gw.Close)
	toGateway := func(*http.Request) (*url.URL, error) { return url.Parse(gw.URL) }

	a = &agent{
		cfg:         config{gatewayName: "tryout-gateway"},
		docker:      docker,
		creating:    map[string]bool{creating: true},
		destroying:  map[string]bool{},
		gatewayHTTP: &http.Client{Transport: &http.Transport{Proxy: toGateway}},
		metrics:     newAgentMetrics(),
	}
	a.reconcile(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if want := []string{namePrefix + missing + "<-tryout-gateway"}; !slices.Equal(connected, want) {
		t.Errorf("connected %v, want %v", connected, want)
	}
}

// TestReconcileReapsStuckCreatedContainers: a create aborted by the control
// plane (the visitor left while the session was starting) can leave a
// container in the created state, after destroy already ran. Nobody will
// start it, so the reconcile loop must reap it instead of keeping it until it
// expires, which would fill the node. A created container that is young, or
// whose create is still in progress, is left alone.
func TestReconcileReapsStuckCreatedContainers(t *testing.T) {
	id := func(c string) string { return strings.Repeat(c, 26) }
	stuck, young, creating := id("a"), id("b"), id("c")

	future := fmt.Sprint(time.Now().Add(time.Hour).Unix())
	created := func(id string, age time.Duration) map[string]any {
		labels := map[string]string{labelSession: id, labelExpires: future, labelPort: "7681"}
		labels[labelCreated] = fmt.Sprint(time.Now().Add(-age).Unix())
		return map[string]any{"Id": id, "State": "created", "Labels": labels}
	}

	var mu sync.Mutex
	var removed []string
	docker := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()

		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/json"):
			_ = json.NewEncoder(w).Encode([]any{created(stuck, 2*time.Minute), created(young, 5*time.Second), created(creating, 2*time.Minute)})

		case r.Method == http.MethodDelete && strings.Contains(p, "/containers/"):
			removed = append(removed, p[strings.LastIndex(p, "/")+1:])
			w.WriteHeader(http.StatusNoContent)

		case r.Method == http.MethodGet && strings.HasSuffix(p, "/networks"):
			_ = json.NewEncoder(w).Encode([]any{})

		case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/tryout-gateway/json"):
			_ = json.NewEncoder(w).Encode(map[string]any{"Id": "gw"})

		default: // network disconnect and removal by destroy
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
		}
	})

	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	t.Cleanup(gw.Close)
	toGateway := func(*http.Request) (*url.URL, error) { return url.Parse(gw.URL) }

	a := &agent{
		cfg:         config{gatewayName: "tryout-gateway"},
		docker:      docker,
		creating:    map[string]bool{creating: true},
		destroying:  map[string]bool{},
		gatewayHTTP: &http.Client{Transport: &http.Transport{Proxy: toGateway}},
		metrics:     newAgentMetrics(),
	}
	a.reconcile(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if want := []string{namePrefix + stuck}; !slices.Equal(removed, want) {
		t.Errorf("removed %v, want %v", removed, want)
	}
}

// TestShouldReap covers each reason to reap a session container, and the
// containers kept. Ages come from the agent's labels, never from the daemon.
func TestShouldReap(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	container := func(state string, age, expiresIn time.Duration) dockerapi.ContainerSummary {
		return dockerapi.ContainerSummary{State: state, Labels: map[string]string{
			labelCreated: fmt.Sprint(now.Add(-age).Unix()),
			labelExpires: fmt.Sprint(now.Add(expiresIn).Unix()),
		}}
	}

	cases := []struct {
		name string
		c    dockerapi.ContainerSummary
		want string
	}{
		{"running", container("running", time.Hour, time.Hour), ""},
		{"just created", container("created", 5*time.Second, time.Hour), ""},
		{"created a minute ago", container("created", time.Minute, time.Hour), ""},
		{"stuck in created", container("created", 2*time.Minute, time.Hour), "stuck"},
		{"exited", container("exited", time.Minute, time.Hour), "dead"},
		{"expired", container("running", time.Hour, -time.Second), "expired"},
		{"created before the label existed", dockerapi.ContainerSummary{State: "created", Labels: map[string]string{
			labelExpires: fmt.Sprint(now.Add(time.Hour).Unix()),
		}}, "stuck"},
	}
	for _, c := range cases {
		if got := shouldReap(c.c, now); got != c.want {
			t.Errorf("%s: shouldReap = %q, want %q", c.name, got, c.want)
		}
	}
}
