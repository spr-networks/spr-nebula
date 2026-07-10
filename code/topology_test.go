package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// fake data source: a node config with one lighthouse and one plain peer
func topoFixture() (Config, StatusResponse) {
	cfg := defaultConfig()
	cfg.Enabled = true
	cfg.CIDR = "192.168.100.0/24"
	cfg.LighthouseHosts = []string{"192.168.100.1"}
	cfg.StaticHostMap = map[string][]string{
		"192.168.100.1": {"lighthouse.example.com:4242"},
		"192.168.100.9": {"203.0.113.9:4242"},
	}
	st := StatusResponse{
		Running:     true,
		Mode:        "node",
		InterfaceUp: true,
		Lighthouses: []LighthouseStatus{{Host: "192.168.100.1", Reachable: true}},
	}
	return cfg, st
}

func findNode(t *testing.T, topo Topology, id string) TopoNode {
	t.Helper()
	for _, n := range topo.Nodes {
		if n.ID == id {
			return n
		}
	}
	t.Fatalf("node %q not found in %+v", id, topo.Nodes)
	return TopoNode{}
}

func TestTopologyDaemonDownRootOnly(t *testing.T) {
	cfg, st := topoFixture()
	st.Running = false
	topo := buildTopology(cfg, st)
	if len(topo.Nodes) != 1 || len(topo.Edges) != 0 {
		t.Fatalf("daemon down: want root only, got %+v", topo)
	}
	root := topo.Nodes[0]
	if root.ID != "root" || root.ConnType != "nebula" || !root.Online {
		t.Errorf("bad root anchor: %+v", root)
	}
}

func TestTopologyNodesAndEdges(t *testing.T) {
	cfg, st := topoFixture()
	topo := buildTopology(cfg, st)

	if len(topo.Nodes) != 3 {
		t.Fatalf("want root + 2 nodes, got %+v", topo.Nodes)
	}
	if topo.Nodes[0].ID != "root" {
		t.Errorf("root anchor must stay first, got %+v", topo.Nodes[0])
	}

	lh := findNode(t, topo, "192.168.100.1")
	if lh.Kind != "lighthouse" || !lh.Online || lh.IP != "192.168.100.1" || lh.ConnType != "nebula" {
		t.Errorf("bad lighthouse node: %+v", lh)
	}
	if lh.Name != "lighthouse.example.com" {
		t.Errorf("lighthouse name should come from its DNS endpoint, got %q", lh.Name)
	}

	host := findNode(t, topo, "192.168.100.9")
	if host.Kind != "host" || host.IP != "192.168.100.9" {
		t.Errorf("bad host node: %+v", host)
	}
	if host.Name != "192.168.100.9" {
		t.Errorf("IP-endpoint host should be named by overlay IP, got %q", host.Name)
	}
	// no probe for a plain host: Online mirrors the daemon-up state
	if !host.Online {
		t.Errorf("unprobed host should inherit daemon-up state: %+v", host)
	}

	if len(topo.Edges) != 2 {
		t.Fatalf("want 2 edges, got %+v", topo.Edges)
	}
	for _, e := range topo.Edges {
		if e.To != "root" || e.Layer != "nebula" || e.Kind != "nebula" {
			t.Errorf("edge must run host->root on the nebula layer: %+v", e)
		}
	}
	if topo.Edges[0].From != "192.168.100.1" || topo.Edges[1].From != "192.168.100.9" {
		t.Errorf("edges not sorted by From: %+v", topo.Edges)
	}
}

func TestTopologyLighthouseUnreachable(t *testing.T) {
	cfg, st := topoFixture()
	st.Lighthouses = []LighthouseStatus{{Host: "192.168.100.1", Reachable: false}}
	topo := buildTopology(cfg, st)
	if lh := findNode(t, topo, "192.168.100.1"); lh.Online {
		t.Errorf("probed-unreachable lighthouse must be offline: %+v", lh)
	}
}

func TestTopologyLighthouseWithoutProbe(t *testing.T) {
	// interface down -> buildStatus skips the ping probe; fall back to daemon-up
	cfg, st := topoFixture()
	st.Lighthouses = nil
	topo := buildTopology(cfg, st)
	if lh := findNode(t, topo, "192.168.100.1"); !lh.Online {
		t.Errorf("unprobed lighthouse should inherit daemon-up state: %+v", lh)
	}
}

func TestTopologyDeduplicatesLighthouseHostMapEntry(t *testing.T) {
	// a lighthouse always has a static host map entry; it must appear once,
	// as Kind "lighthouse"
	cfg, st := topoFixture()
	topo := buildTopology(cfg, st)
	count := 0
	for _, n := range topo.Nodes {
		if n.ID == "192.168.100.1" {
			count++
			if n.Kind != "lighthouse" {
				t.Errorf("lighthouse dedup lost Kind: %+v", n)
			}
		}
	}
	if count != 1 {
		t.Errorf("lighthouse appears %d times, want 1", count)
	}
}

func TestTopologyLighthouseModeSelf(t *testing.T) {
	// this router as the lighthouse: no LighthouseHosts, peers in the host map
	cfg := defaultConfig()
	cfg.Mode = "lighthouse"
	cfg.ListenPort = 4242
	cfg.StaticHostMap = map[string][]string{"192.168.100.9": {"203.0.113.9:4242"}}
	st := StatusResponse{Running: true, Mode: "lighthouse", InterfaceUp: true}
	topo := buildTopology(cfg, st)
	if len(topo.Nodes) != 2 || len(topo.Edges) != 1 {
		t.Fatalf("want root + 1 host, got %+v", topo)
	}
	if n := findNode(t, topo, "192.168.100.9"); n.Kind != "host" {
		t.Errorf("want host node, got %+v", n)
	}
}

func TestTopologyJSONShape(t *testing.T) {
	// wire format matches the spr-tailscale contract: empty optional fields
	// omitted, root anchor present
	cfg, st := topoFixture()
	data, err := json.Marshal(buildTopology(cfg, st))
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	for _, want := range []string{
		`"Nodes":[`, `"Edges":[`,
		`"ID":"root"`, `"ConnType":"nebula"`, `"Online":true`,
		`"Layer":"nebula"`, `"To":"root"`,
	} {
		if !strings.Contains(s, want) {
			t.Errorf("topology JSON missing %s\n---\n%s", want, s)
		}
	}
	// root has no IP/Kind/Name set; omitempty must drop IP
	if strings.Contains(s, `"IP":""`) {
		t.Errorf("empty IP fields must be omitted:\n%s", s)
	}
}
