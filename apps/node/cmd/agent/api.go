package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/Akinator31/Tryout/apps/node/internal/logging"
	"github.com/Akinator31/Tryout/apps/node/internal/version"
)

const (
	// maxSessionRequestBytes bounds the body of POST /v1/sessions.
	maxSessionRequestBytes = 64 << 10
	// createTimeout bounds a session creation: the first pull of an image can
	// be long.
	createTimeout = 10 * time.Minute
)

// apiHandler is the agent's private API, called by the control plane only
// (the mutual TLS handshake authenticates it, see serverTLS).
func (a *agent) apiHandler() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.handleHealthz)
	mux.HandleFunc("GET /metrics", a.handleMetrics)
	mux.HandleFunc("POST /v1/sessions", a.handleCreateSession)
	mux.HandleFunc("DELETE /v1/sessions/{id}", a.handleDeleteSession)
	mux.HandleFunc("GET /v1/sessions", a.handleListSessions)
	return mux
}

// handleHealthz describes the node and its load. The node is healthy when its
// Docker daemon answers: otherwise it answers 503, since it could neither
// start nor list sessions.
func (a *agent) handleHealthz(w http.ResponseWriter, r *http.Request) {
	n, err := a.countSessions(r.Context())
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "docker: " + err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"version":         version.Version,
		"profile":         a.cfg.profile,
		"arch":            a.arch,
		"default_runtime": a.cfg.defaultRuntime,
		"runtimes":        sortedKeys(a.runtimes),
		"sessions":        n,
		"max_sessions":    a.cfg.maxSessions,
	})
}

// handleCreateSession validates the request (400 when invalid) and creates
// the session (409 when that fails, such as a full node).
func (a *agent) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSessionRequestBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	req, err := a.parseSessionReq(body)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), createTimeout)
	defer cancel()
	started := time.Now()
	err = a.create(ctx, req)
	a.metrics.observeStart(req.Project, time.Since(started), err)
	if err != nil {
		slog.Warn("create failed", "id", logging.ID(req.ID), "err", err)
		writeError(w, http.StatusConflict, err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]string{"id": req.ID})
}

// handleDeleteSession destroys a session and pushes the new route table.
// Deleting an unknown session succeeds: the control plane may retry.
func (a *agent) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !sessionIDRe.MatchString(id) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}

	a.remove(r.Context(), id)
	a.pushRoutes(r.Context())
	w.WriteHeader(http.StatusNoContent)
}

// handleListSessions lists the session containers with their project and state.
func (a *agent) handleListSessions(w http.ResponseWriter, r *http.Request) {
	cs, err := a.docker.ContainerList(r.Context(), labelSession)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}

	out := []map[string]string{}
	for _, c := range cs {
		out = append(out, map[string]string{
			"id":      c.Labels[labelSession],
			"project": c.Labels[labelProject],
			"state":   c.State,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// writeJSON writes v as a JSON response with the given status.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// writeError writes {"error": "<message>"} with the given status.
func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
