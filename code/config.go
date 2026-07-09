package main

// Plugin configuration: JSON config validated server-side, then rendered into
// nebula's config.yml. No secrets are ever stored in config.json — the CA key
// and host key live as files under /configs/spr-nebula (mode 0600) and are
// never returned by the API.

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var TEST_PREFIX = os.Getenv("TEST_PREFIX")

var (
	ConfigDir        = TEST_PREFIX + "/configs/spr-nebula"
	ConfigFile       = TEST_PREFIX + "/configs/spr-nebula/config.json"
	NebulaConfigFile = TEST_PREFIX + "/configs/spr-nebula/nebula.yml"
	CACertPath       = TEST_PREFIX + "/configs/spr-nebula/ca.crt"
	CAKeyPath        = TEST_PREFIX + "/configs/spr-nebula/ca.key"
	HostCertPath     = TEST_PREFIX + "/configs/spr-nebula/host.crt"
	HostKeyPath      = TEST_PREFIX + "/configs/spr-nebula/host.key"
)

const (
	NebulaBin       = "/nebula"
	NebulaCertBin   = "/nebula-cert"
	NebulaInterface = "nebula1"
)

type PunchyConfig struct {
	Punch   bool
	Respond bool
}

type Config struct {
	Enabled bool
	// "node" (regular member) or "lighthouse"
	Mode string
	// overlay network in CIDR notation, e.g. "192.168.100.0/24".
	// Used as the default prefix when issuing certificates.
	CIDR string
	// UDP port nebula listens on inside the container network.
	// 0 = random (node mode only); lighthouses need a fixed port.
	ListenPort int
	// overlay IPs of the lighthouses this node reports to (node mode)
	LighthouseHosts []string
	// overlay IP -> list of "host:port" real-world addresses
	StaticHostMap map[string][]string
	// overlay IPs of relays this node may use (node mode)
	Relays []string
	// advertise this node as a relay for others
	AmRelay bool
	// allow using relays learned from the lighthouse
	UseRelays bool
	// NAT hole punching
	Punchy PunchyConfig
	// add an inbound overlay-firewall rule allowing ICMP (ping) from any host.
	// Default false: inbound is deny-all.
	InboundAllowICMP bool
}

var (
	Configmtx sync.RWMutex
	gConfig   = defaultConfig()
)

func defaultConfig() Config {
	return Config{
		Enabled:    false,
		Mode:       "node",
		ListenPort: 4242,
		UseRelays:  true,
		Punchy:     PunchyConfig{Punch: true, Respond: true},
	}
}

func snapshotConfig() Config {
	Configmtx.RLock()
	defer Configmtx.RUnlock()
	c := gConfig
	// deep-ish copy of reference fields so callers can't race the globals
	c.LighthouseHosts = append([]string(nil), gConfig.LighthouseHosts...)
	c.Relays = append([]string(nil), gConfig.Relays...)
	c.StaticHostMap = map[string][]string{}
	for k, v := range gConfig.StaticHostMap {
		c.StaticHostMap[k] = append([]string(nil), v...)
	}
	return c
}

func loadConfig() error {
	data, err := os.ReadFile(ConfigFile)
	if err != nil {
		return err
	}
	c := defaultConfig()
	if err := json.Unmarshal(data, &c); err != nil {
		return err
	}
	if err := c.Validate(); err != nil {
		return fmt.Errorf("stored config invalid: %w", err)
	}
	Configmtx.Lock()
	gConfig = c
	Configmtx.Unlock()
	return nil
}

func saveConfig(c Config) error {
	data, err := json.MarshalIndent(c, "", " ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(ConfigFile, data, 0600); err != nil {
		return err
	}
	Configmtx.Lock()
	gConfig = c
	Configmtx.Unlock()
	return nil
}

// writeFileAtomic writes via tmp+rename in the destination directory.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

// ---- validation --------------------------------------------------------
// Everything user-supplied that ends up in nebula.yml or on a nebula-cert
// command line is allow-list validated here. Values are only ever passed as
// exec argv entries (never through a shell) and quoted with %q in YAML.

var (
	certNameRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$`)
	groupRe    = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9._-]{0,62})?$`)
	hostnameRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$`)
	durationRe = regexp.MustCompile(`^[0-9hms]+$`)
)

func validCertName(s string) error {
	if !certNameRe.MatchString(s) {
		return fmt.Errorf("invalid certificate name %q (allowed: letters, digits, space, . _ -; max 64)", s)
	}
	return nil
}

func validGroup(s string) error {
	if !groupRe.MatchString(s) {
		return fmt.Errorf("invalid group %q (allowed: letters, digits, . _ -; max 64)", s)
	}
	return nil
}

func validOverlayIP(s string) error {
	ip := net.ParseIP(s)
	if ip == nil || ip.To4() == nil {
		return fmt.Errorf("invalid overlay IPv4 address %q", s)
	}
	return nil
}

func validDuration(s string) error {
	if !durationRe.MatchString(s) {
		return fmt.Errorf("invalid duration %q", s)
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %v", s, err)
	}
	if d <= 0 || d > 100*365*24*time.Hour {
		return fmt.Errorf("duration %q out of range", s)
	}
	return nil
}

// validEndpoint validates a "host:port" static host map entry, where host is
// an IPv4/IPv6 literal or a DNS hostname.
func validEndpoint(s string) error {
	host, port, err := net.SplitHostPort(s)
	if err != nil {
		return fmt.Errorf("invalid endpoint %q (want host:port): %v", s, err)
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("invalid port in endpoint %q", s)
	}
	if net.ParseIP(host) == nil && !hostnameRe.MatchString(host) {
		return fmt.Errorf("invalid host in endpoint %q", s)
	}
	return nil
}

func (c *Config) Validate() error {
	switch c.Mode {
	case "node", "lighthouse":
	default:
		return fmt.Errorf("invalid mode %q (want node or lighthouse)", c.Mode)
	}
	if c.ListenPort < 0 || c.ListenPort > 65535 {
		return fmt.Errorf("invalid listen port %d", c.ListenPort)
	}
	if c.Mode == "lighthouse" && c.ListenPort == 0 {
		return fmt.Errorf("lighthouse mode requires a fixed listen port")
	}
	if c.CIDR != "" {
		ip, _, err := net.ParseCIDR(c.CIDR)
		if err != nil || ip.To4() == nil {
			return fmt.Errorf("invalid network CIDR %q", c.CIDR)
		}
	}
	if c.Mode == "lighthouse" && len(c.LighthouseHosts) > 0 {
		return fmt.Errorf("lighthouse mode must not list lighthouse hosts")
	}
	if len(c.LighthouseHosts) > 64 {
		return fmt.Errorf("too many lighthouse hosts")
	}
	for _, h := range c.LighthouseHosts {
		if err := validOverlayIP(h); err != nil {
			return fmt.Errorf("lighthouse hosts: %w", err)
		}
	}
	if len(c.StaticHostMap) > 256 {
		return fmt.Errorf("too many static host map entries")
	}
	for k, eps := range c.StaticHostMap {
		if err := validOverlayIP(k); err != nil {
			return fmt.Errorf("static host map: %w", err)
		}
		if len(eps) == 0 || len(eps) > 16 {
			return fmt.Errorf("static host map entry %q needs 1-16 endpoints", k)
		}
		for _, ep := range eps {
			if err := validEndpoint(ep); err != nil {
				return fmt.Errorf("static host map %q: %w", k, err)
			}
		}
	}
	if c.Mode == "node" {
		for _, h := range c.LighthouseHosts {
			if _, ok := c.StaticHostMap[h]; !ok {
				return fmt.Errorf("lighthouse %s has no static host map entry", h)
			}
		}
	}
	if len(c.Relays) > 64 {
		return fmt.Errorf("too many relays")
	}
	for _, r := range c.Relays {
		if err := validOverlayIP(r); err != nil {
			return fmt.Errorf("relays: %w", err)
		}
	}
	return nil
}

// ---- nebula.yml generation ---------------------------------------------

// genNebulaYAML renders the nebula daemon config. All interpolated values
// passed Validate() (strict charsets), and strings are additionally %q-quoted,
// so no user input can alter the YAML structure.
func genNebulaYAML(c *Config) string {
	var b strings.Builder
	w := func(format string, args ...interface{}) {
		fmt.Fprintf(&b, format+"\n", args...)
	}

	w("# Generated by the spr-nebula plugin — do not edit, changes are overwritten")
	w("# on every daemon (re)start. Configure via the plugin UI / API instead.")
	w("")
	w("pki:")
	w("  ca: %s", "/configs/spr-nebula/ca.crt")
	w("  cert: %s", "/configs/spr-nebula/host.crt")
	w("  key: %s", "/configs/spr-nebula/host.key")
	w("")
	if len(c.StaticHostMap) == 0 {
		w("static_host_map: {}")
	} else {
		w("static_host_map:")
		keys := make([]string, 0, len(c.StaticHostMap))
		for k := range c.StaticHostMap {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			quoted := make([]string, 0, len(c.StaticHostMap[k]))
			for _, ep := range c.StaticHostMap[k] {
				quoted = append(quoted, fmt.Sprintf("%q", ep))
			}
			w("  %q: [%s]", k, strings.Join(quoted, ", "))
		}
	}
	w("")
	w("lighthouse:")
	w("  am_lighthouse: %t", c.Mode == "lighthouse")
	w("  interval: 60")
	if c.Mode == "node" && len(c.LighthouseHosts) > 0 {
		w("  hosts:")
		for _, h := range c.LighthouseHosts {
			w("    - %q", h)
		}
	} else {
		w("  hosts: []")
	}
	w("")
	w("listen:")
	w("  host: 0.0.0.0")
	w("  port: %d", c.ListenPort)
	w("")
	w("punchy:")
	w("  punch: %t", c.Punchy.Punch)
	w("  respond: %t", c.Punchy.Respond)
	w("")
	w("relay:")
	if len(c.Relays) > 0 {
		w("  relays:")
		for _, r := range c.Relays {
			w("    - %q", r)
		}
	}
	w("  am_relay: %t", c.AmRelay)
	w("  use_relays: %t", c.UseRelays)
	w("")
	w("tun:")
	w("  disabled: false")
	w("  dev: %s", NebulaInterface)
	w("  drop_local_broadcast: false")
	w("  drop_multicast: false")
	w("  tx_queue: 500")
	w("  mtu: 1300")
	w("")
	w("logging:")
	w("  level: info")
	w("  format: text")
	w("")
	w("firewall:")
	w("  outbound_action: drop")
	w("  inbound_action: drop")
	w("  conntrack:")
	w("    tcp_timeout: 12m")
	w("    udp_timeout: 3m")
	w("    default_timeout: 10m")
	w("")
	w("  # default policy: any outbound traffic from this node is allowed")
	w("  outbound:")
	w("    - port: any")
	w("      proto: any")
	w("      host: any")
	w("")
	w("  # default policy: all inbound overlay traffic is denied.")
	w("  # Example — allow ICMP (ping) from any overlay host (enable with the")
	w("  # \"Allow inbound ICMP\" toggle in the plugin UI, InboundAllowICMP in the API):")
	w("  #   - port: any")
	w("  #     proto: icmp")
	w("  #     host: any")
	if c.InboundAllowICMP {
		w("  inbound:")
		w("    - port: any")
		w("      proto: icmp")
		w("      host: any")
	} else {
		w("  inbound: []")
	}
	return b.String()
}
