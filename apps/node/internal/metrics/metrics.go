// Package metrics writes metrics in the Prometheus text exposition format
// (version 0.0.4), without a client library: counters and histograms kept in
// memory, and gauges computed by the caller at each scrape.
package metrics

import (
	"fmt"
	"io"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"sync"
)

// ContentType is the media type of the text exposition format.
const ContentType = "text/plain; version=0.0.4; charset=utf-8"

// Registry holds the counters and histograms of a process and writes them,
// with the gauges of the current scrape, in the order they were declared.
type Registry struct {
	mu       sync.Mutex
	families []family
}

// family is one metric family the registry writes.
type family interface {
	write(w io.Writer)
}

// Sample is one value of a gauge, with its label values in the order of the
// gauge's label names.
type Sample struct {
	Labels []string
	Value  float64
}

// Gauge is a gauge family computed at scrape time and passed to Write.
type Gauge struct {
	Name    string
	Help    string
	Labels  []string
	Samples []Sample
}

// Counter is a counter family with labels. Its series are created on first
// increment.
type Counter struct {
	name, help string
	labels     []string

	mu     sync.Mutex
	series map[string]*counterSeries
}

type counterSeries struct {
	labels []string
	value  float64
}

// Histogram is a histogram family with labels and fixed upper bounds.
type Histogram struct {
	name, help string
	labels     []string
	bounds     []float64

	mu     sync.Mutex
	series map[string]*histogramSeries
}

type histogramSeries struct {
	labels []string
	counts []uint64 // one per bound, not cumulative
	sum    float64
	count  uint64
}

// NewCounter declares a counter family with the given label names.
func (r *Registry) NewCounter(name, help string, labels ...string) *Counter {
	c := &Counter{name: name, help: help, labels: labels, series: map[string]*counterSeries{}}
	r.add(c)
	return c
}

// NewHistogram declares a histogram family with the given upper bounds, in
// increasing order, and label names.
func (r *Registry) NewHistogram(name, help string, bounds []float64, labels ...string) *Histogram {
	h := &Histogram{name: name, help: help, labels: labels, bounds: bounds, series: map[string]*histogramSeries{}}
	r.add(h)
	return h
}

// add appends a family to the registry.
func (r *Registry) add(f family) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.families = append(r.families, f)
}

// Write writes the given gauges, then every declared family.
func (r *Registry) Write(w io.Writer, gauges ...Gauge) {
	for _, g := range gauges {
		g.write(w)
	}

	r.mu.Lock()
	families := slices.Clone(r.families)
	r.mu.Unlock()

	for _, f := range families {
		f.write(w)
	}
}

// Inc adds one to the series with the given label values.
func (c *Counter) Inc(labelValues ...string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	key := seriesKey(labelValues)
	s, ok := c.series[key]
	if !ok {
		s = &counterSeries{labels: slices.Clone(labelValues)}
		c.series[key] = s
	}
	s.value++
}

// Observe records v in the series with the given label values.
func (h *Histogram) Observe(v float64, labelValues ...string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	key := seriesKey(labelValues)
	s, ok := h.series[key]
	if !ok {
		s = &histogramSeries{labels: slices.Clone(labelValues), counts: make([]uint64, len(h.bounds))}
		h.series[key] = s
	}

	// The first bound >= v: buckets are "less than or equal".
	if i, _ := slices.BinarySearch(h.bounds, v); i < len(h.bounds) {
		s.counts[i]++
	}
	s.sum += v
	s.count++
}

// write writes the gauge's samples, in the order given.
func (g Gauge) write(w io.Writer) {
	writeHeader(w, g.Name, g.Help, "gauge")
	for _, s := range g.Samples {
		writeSample(w, g.Name, g.Labels, s.Labels, s.Value)
	}
}

// write writes the counter's series, sorted by label values.
func (c *Counter) write(w io.Writer) {
	c.mu.Lock()
	defer c.mu.Unlock()

	writeHeader(w, c.name, c.help, "counter")
	for _, key := range slices.Sorted(maps.Keys(c.series)) {
		s := c.series[key]
		writeSample(w, c.name, c.labels, s.labels, s.value)
	}
}

// write writes the histogram's series, sorted by label values: cumulative
// buckets, then the sum and the count.
func (h *Histogram) write(w io.Writer) {
	h.mu.Lock()
	defer h.mu.Unlock()

	writeHeader(w, h.name, h.help, "histogram")
	bucketLabels := append(slices.Clone(h.labels), "le")

	for _, key := range slices.Sorted(maps.Keys(h.series)) {
		s := h.series[key]

		var cumulative uint64
		for i, bound := range h.bounds {
			cumulative += s.counts[i]
			writeSample(w, h.name+"_bucket", bucketLabels, append(slices.Clone(s.labels), formatFloat(bound)), float64(cumulative))
		}
		writeSample(w, h.name+"_bucket", bucketLabels, append(slices.Clone(s.labels), "+Inf"), float64(s.count))
		writeSample(w, h.name+"_sum", h.labels, s.labels, s.sum)
		writeSample(w, h.name+"_count", h.labels, s.labels, float64(s.count))
	}
}

// writeHeader writes the HELP and TYPE lines of a family.
func writeHeader(w io.Writer, name, help, kind string) {
	fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s %s\n", name, helpEscaper.Replace(help), name, kind)
}

// writeSample writes one line: name{label="value",...} value.
func writeSample(w io.Writer, name string, labels, values []string, v float64) {
	var b strings.Builder
	b.WriteString(name)

	if len(labels) > 0 {
		b.WriteByte('{')
		for i, l := range labels {
			if i > 0 {
				b.WriteByte(',')
			}
			fmt.Fprintf(&b, `%s="%s"`, l, labelEscaper.Replace(valueAt(values, i)))
		}
		b.WriteByte('}')
	}

	fmt.Fprintf(w, "%s %s\n", b.String(), formatFloat(v))
}

// valueAt returns values[i], or "" when the caller gave fewer values than
// label names.
func valueAt(values []string, i int) string {
	if i < len(values) {
		return values[i]
	}
	return ""
}

// formatFloat formats v as the exposition format expects.
func formatFloat(v float64) string {
	switch {
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	case math.IsNaN(v):
		return "NaN"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// labelEscaper escapes a label value: backslash, double quote and newline.
var labelEscaper = strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)

// helpEscaper escapes a HELP text: backslash and newline.
var helpEscaper = strings.NewReplacer(`\`, `\\`, "\n", `\n`)

// seriesKey identifies a series by its label values. The separator cannot
// appear in a valid UTF-8 label value.
func seriesKey(labelValues []string) string {
	return strings.Join(labelValues, "\xff")
}
