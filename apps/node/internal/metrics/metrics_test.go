package metrics

import (
	"strings"
	"sync"
	"testing"
)

// TestWrite checks the full exposition of a gauge, a counter and a
// histogram: headers, label order, sorting, cumulative buckets and escaping.
func TestWrite(t *testing.T) {
	var r Registry
	starts := r.NewCounter("starts_total", "Session starts.", "project", "result")
	seconds := r.NewHistogram("start_seconds", "Start time.", []float64{1, 5}, "project")

	starts.Inc("b", "ok")
	starts.Inc("a", "error")
	starts.Inc("b", "ok")
	seconds.Observe(0.5, "a")
	seconds.Observe(1, "a")
	seconds.Observe(3, "a")
	seconds.Observe(9, "a")

	gauge := Gauge{
		Name:    "sessions",
		Help:    "Sessions on the node.\nBy state.",
		Labels:  []string{"project"},
		Samples: []Sample{{Labels: []string{`we"ird\`}, Value: 2}},
	}

	var b strings.Builder
	r.Write(&b, gauge)

	want := `# HELP sessions Sessions on the node.\nBy state.
# TYPE sessions gauge
sessions{project="we\"ird\\"} 2
# HELP starts_total Session starts.
# TYPE starts_total counter
starts_total{project="a",result="error"} 1
starts_total{project="b",result="ok"} 2
# HELP start_seconds Start time.
# TYPE start_seconds histogram
start_seconds_bucket{project="a",le="1"} 2
start_seconds_bucket{project="a",le="5"} 3
start_seconds_bucket{project="a",le="+Inf"} 4
start_seconds_sum{project="a"} 13.5
start_seconds_count{project="a"} 4
`
	if got := b.String(); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

// TestWriteEmpty checks that a family without series still writes its
// headers, so a scrape always lists every metric.
func TestWriteEmpty(t *testing.T) {
	var r Registry
	r.NewCounter("reaped_total", "Reaped sessions.", "reason")

	var b strings.Builder
	r.Write(&b)

	want := "# HELP reaped_total Reaped sessions.\n# TYPE reaped_total counter\n"
	if b.String() != want {
		t.Fatalf("got %q", b.String())
	}
}

// TestConcurrent increments and writes from several goroutines; run with
// -race.
func TestConcurrent(t *testing.T) {
	var r Registry
	c := r.NewCounter("c_total", "c", "k")
	h := r.NewHistogram("h", "h", []float64{1}, "k")

	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 100 {
				c.Inc("x")
				h.Observe(0.5, "x")
				r.Write(&strings.Builder{})
			}
		})
	}
	wg.Wait()

	var b strings.Builder
	r.Write(&b)
	if !strings.Contains(b.String(), `c_total{k="x"} 800`) {
		t.Fatalf("lost increments:\n%s", b.String())
	}
}
