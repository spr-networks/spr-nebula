package main

// GET /topology — contributes this plugin's overlay graph to SPR's router
// topology view. The struct shapes mirror spr-tailscale's topology contract:
// the SPR host merges the plugin graph into the router topology at the
// "root" anchor node.

import (
	"encoding/json"
	"net"
	"net/http"
	"sort"
)

type TopoNode struct {
	ID       string
	Kind     string
	Name     string
	IP       string `json:",omitempty"`
	ConnType string `json:",omitempty"`
	Online   bool
}

type TopoEdge struct {
	From  string
	To    string
	Layer string
	Kind  string
}

type Topology struct {
	Nodes []TopoNode
	Edges []TopoEdge
}

// topoNodeName picks a display name for an overlay peer: the first DNS-named
// endpoint from its static host map entry reads better than the bare overlay
// IP; otherwise the overlay IP is the name.
func topoNodeName(ip string, endpoints []string) string {
	for _, ep := range endpoints {
		host, _, err := net.SplitHostPort(ep)
		if err != nil || host == "" {
			continue
		}
		if net.ParseIP(host) == nil {
			return host
		}
	}
	return ip
}

// buildTopology renders the configured overlay as a graph anchored at "root"
// (this router). Nodes are the configured lighthouses plus every static host
// map entry. Online is honest: the live lighthouse reachability probe where
// one ran, otherwise the daemon-up state (all we know without a probe). With
// the daemon down the graph is just the root anchor.
func buildTopology(cfg Config, st StatusResponse) Topology {
	topo := Topology{
		Nodes: []TopoNode{{ID: "root", ConnType: "nebula", Online: true}},
		Edges: []TopoEdge{},
	}
	if !st.Running {
		return topo
	}

	probed := map[string]bool{}
	for _, lh := range st.Lighthouses {
		probed[lh.Host] = lh.Reachable
	}
	isLighthouse := map[string]bool{}
	for _, h := range cfg.LighthouseHosts {
		isLighthouse[h] = true
	}

	seen := map[string]bool{}
	add := func(ip, kind string) {
		if seen[ip] {
			return
		}
		seen[ip] = true
		online := st.Running
		if r, ok := probed[ip]; ok {
			online = r
		}
		topo.Nodes = append(topo.Nodes, TopoNode{
			ID:       ip,
			Kind:     kind,
			Name:     topoNodeName(ip, cfg.StaticHostMap[ip]),
			IP:       ip,
			ConnType: "nebula",
			Online:   online,
		})
		topo.Edges = append(topo.Edges, TopoEdge{From: ip, To: "root", Layer: "nebula", Kind: "nebula"})
	}

	for _, h := range cfg.LighthouseHosts {
		add(h, "lighthouse")
	}
	hosts := make([]string, 0, len(cfg.StaticHostMap))
	for ip := range cfg.StaticHostMap {
		hosts = append(hosts, ip)
	}
	sort.Strings(hosts)
	for _, ip := range hosts {
		if isLighthouse[ip] {
			continue // already added with Kind "lighthouse"
		}
		add(ip, "host")
	}

	// deterministic order; keep the root anchor first
	rest := topo.Nodes[1:]
	sort.Slice(rest, func(i, j int) bool {
		if rest[i].Name != rest[j].Name {
			return rest[i].Name < rest[j].Name
		}
		return rest[i].ID < rest[j].ID
	})
	sort.Slice(topo.Edges, func(i, j int) bool { return topo.Edges[i].From < topo.Edges[j].From })
	return topo
}

func (p *nebulaPlugin) handleTopology(w http.ResponseWriter, r *http.Request) {
	topo := buildTopology(snapshotConfig(), p.sup.buildStatus())
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(topo); err != nil {
		http.Error(w, err.Error(), 500)
	}
}
