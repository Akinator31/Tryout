package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/dockerapi"
	"github.com/Akinator31/Tryout/apps/node/internal/session"
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
	container := func(id string) map[string]any {
		state := "running"
		if id == stopped {
			state = "created"
		}
		labels := map[string]string{session.LabelSession: id, session.LabelExpires: future, session.LabelPort: "7681"}
		labels[session.LabelCreated] = fmt.Sprint(time.Now().Unix())
		return map[string]any{"Id": id, "State": state, "Labels": labels}
	}
	gatewayNetworks := map[string]any{"tryout_default": map[string]any{}, session.Name(attached): map[string]any{}}

	var mu sync.Mutex
	var connected []string
	var a *Agent
	docker := fakeDockerClient(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()

		p := r.URL.Path
		switch {
		case r.Method == http.MethodGet && strings.HasSuffix(p, "/containers/json"):
			_ = json.NewEncoder(w).Encode([]any{container(attached), container(missing), container(creating), container(stopped), container(removing)})

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

	gw := &fakeGateway{}
	a = New(Config{GatewayName: "tryout-gateway"}, docker, nil, gw)
	a.creating[creating] = true
	a.reconcile(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if want := []string{session.Name(missing) + "<-tryout-gateway"}; !slices.Equal(connected, want) {
		t.Errorf("connected %v, want %v", connected, want)
	}

	if len(gw.tables) != 1 {
		t.Fatalf("pushed %d route tables, want 1", len(gw.tables))
	}
	var routed []string
	for _, r := range gw.tables[0] {
		routed = append(routed, r.ID)
		if r.Target != "http://"+session.Name(r.ID)+":7681" {
			t.Errorf("route %s targets %s", r.ID, r.Target)
		}
	}
	if want := []string{attached, missing, creating, removing}; !slices.Equal(routed, want) {
		t.Errorf("routed %v, want the running sessions %v", routed, want)
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
		labels := map[string]string{session.LabelSession: id, session.LabelExpires: future, session.LabelPort: "7681"}
		labels[session.LabelCreated] = fmt.Sprint(time.Now().Add(-age).Unix())
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

	a := New(Config{GatewayName: "tryout-gateway"}, docker, nil, &fakeGateway{})
	a.creating[creating] = true
	a.reconcile(context.Background())

	mu.Lock()
	defer mu.Unlock()
	if want := []string{session.Name(stuck)}; !slices.Equal(removed, want) {
		t.Errorf("removed %v, want %v", removed, want)
	}
}

// TestShouldReap covers each reason to reap a session container, and the
// containers kept. Ages come from the agent's labels, never from the daemon.
func TestShouldReap(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	container := func(state string, age, expiresIn time.Duration) dockerapi.ContainerSummary {
		return dockerapi.ContainerSummary{State: state, Labels: map[string]string{
			session.LabelCreated: fmt.Sprint(now.Add(-age).Unix()),
			session.LabelExpires: fmt.Sprint(now.Add(expiresIn).Unix()),
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
			session.LabelExpires: fmt.Sprint(now.Add(time.Hour).Unix()),
		}}, "stuck"},
	}
	for _, c := range cases {
		if got := shouldReap(c.c, now); got != c.want {
			t.Errorf("%s: shouldReap = %q, want %q", c.name, got, c.want)
		}
	}
}
