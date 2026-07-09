package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func validNodeConfig() Config {
	c := defaultConfig()
	c.Enabled = true
	c.CIDR = "192.168.100.0/24"
	c.LighthouseHosts = []string{"192.168.100.1"}
	c.StaticHostMap = map[string][]string{
		"192.168.100.1": {"lighthouse.example.com:4242", "203.0.113.9:4242"},
	}
	return c
}

func TestValidateConfigOK(t *testing.T) {
	c := validNodeConfig()
	if err := c.Validate(); err != nil {
		t.Fatalf("expected valid config, got %v", err)
	}

	lh := defaultConfig()
	lh.Mode = "lighthouse"
	lh.ListenPort = 4242
	if err := lh.Validate(); err != nil {
		t.Fatalf("expected valid lighthouse config, got %v", err)
	}
}

func TestValidateConfigRejects(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*Config)
	}{
		{"bad mode", func(c *Config) { c.Mode = "meshy" }},
		{"empty mode", func(c *Config) { c.Mode = "" }},
		{"bad port", func(c *Config) { c.ListenPort = 70000 }},
		{"negative port", func(c *Config) { c.ListenPort = -1 }},
		{"bad cidr", func(c *Config) { c.CIDR = "not-a-cidr" }},
		{"v6 cidr", func(c *Config) { c.CIDR = "fd00::/64" }},
		{"bad lighthouse ip", func(c *Config) { c.LighthouseHosts = []string{"192.168.100.999"} }},
		{"lighthouse not in static map", func(c *Config) { c.LighthouseHosts = []string{"192.168.100.7"} }},
		{"bad static map key", func(c *Config) { c.StaticHostMap["nope"] = []string{"1.2.3.4:4242"} }},
		{"static map missing port", func(c *Config) { c.StaticHostMap["192.168.100.1"] = []string{"1.2.3.4"} }},
		{"static map bad port", func(c *Config) { c.StaticHostMap["192.168.100.1"] = []string{"1.2.3.4:0"} }},
		{"static map shell chars", func(c *Config) { c.StaticHostMap["192.168.100.1"] = []string{"evil;rm -rf:4242"} }},
		{"static map yaml injection", func(c *Config) { c.StaticHostMap["192.168.100.1"] = []string{"a\"]\n  inject: [\"x:4242"} }},
		{"empty endpoints", func(c *Config) { c.StaticHostMap["192.168.100.1"] = []string{} }},
		{"bad relay", func(c *Config) { c.Relays = []string{"relay1"} }},
	}
	for _, tc := range cases {
		c := validNodeConfig()
		tc.mutate(&c)
		if err := c.Validate(); err == nil {
			t.Errorf("%s: expected validation error, got nil", tc.name)
		}
	}

	// lighthouse mode with hosts listed
	lh := defaultConfig()
	lh.Mode = "lighthouse"
	lh.LighthouseHosts = []string{"192.168.100.1"}
	lh.StaticHostMap = map[string][]string{"192.168.100.1": {"1.2.3.4:4242"}}
	if err := lh.Validate(); err == nil {
		t.Error("lighthouse with hosts: expected validation error")
	}
	// lighthouse mode requires fixed port
	lh2 := defaultConfig()
	lh2.Mode = "lighthouse"
	lh2.ListenPort = 0
	if err := lh2.Validate(); err == nil {
		t.Error("lighthouse with port 0: expected validation error")
	}
}

func TestGenNebulaYAMLNode(t *testing.T) {
	c := validNodeConfig()
	c.Relays = []string{"192.168.100.1"}
	yml := genNebulaYAML(&c)

	for _, want := range []string{
		"am_lighthouse: false",
		`  "192.168.100.1": ["lighthouse.example.com:4242", "203.0.113.9:4242"]`,
		"  hosts:\n    - \"192.168.100.1\"",
		"port: 4242",
		"punch: true",
		"respond: true",
		"  relays:\n    - \"192.168.100.1\"",
		"use_relays: true",
		"dev: nebula1",
		"outbound_action: drop",
		"inbound_action: drop",
		"outbound:\n    - port: any\n      proto: any\n      host: any",
		"inbound: []",
		"#     proto: icmp", // the documented allow-ICMP example
		"ca: /configs/spr-nebula/ca.crt",
		"cert: /configs/spr-nebula/host.crt",
		"key: /configs/spr-nebula/host.key",
	} {
		if !strings.Contains(yml, want) {
			t.Errorf("generated yaml missing %q\n---\n%s", want, yml)
		}
	}
}

func TestGenNebulaYAMLLighthouse(t *testing.T) {
	c := defaultConfig()
	c.Mode = "lighthouse"
	c.ListenPort = 4242
	yml := genNebulaYAML(&c)
	for _, want := range []string{
		"am_lighthouse: true",
		"hosts: []",
		"static_host_map: {}",
	} {
		if !strings.Contains(yml, want) {
			t.Errorf("lighthouse yaml missing %q\n---\n%s", want, yml)
		}
	}
}

func TestGenNebulaYAMLInboundICMP(t *testing.T) {
	c := validNodeConfig()
	c.InboundAllowICMP = true
	yml := genNebulaYAML(&c)
	if !strings.Contains(yml, "  inbound:\n    - port: any\n      proto: icmp\n      host: any") {
		t.Errorf("expected inbound icmp rule\n---\n%s", yml)
	}
	if strings.Contains(yml, "inbound: []") {
		t.Errorf("did not expect empty inbound list\n---\n%s", yml)
	}
}

func TestResolveCertNetwork(t *testing.T) {
	cases := []struct {
		ip, cidr, want string
		wantErr        bool
	}{
		{"192.168.100.5", "192.168.100.0/24", "192.168.100.5/24", false},
		{"192.168.100.5/24", "192.168.100.0/24", "192.168.100.5/24", false},
		{"192.168.100.5/16", "192.168.100.0/24", "192.168.100.5/16", false},
		{"192.168.100.5/24", "", "192.168.100.5/24", false},
		{"192.168.100.5", "", "", true},            // no prefix and no CIDR
		{"10.9.9.9", "192.168.100.0/24", "", true}, // outside network
		{"192.168.100.5/40", "", "", true},
		{"fd00::1/64", "", "", true},
		{"bogus", "192.168.100.0/24", "", true},
		{"192.168.100.5;rm -rf /", "", "", true},
	}
	for _, tc := range cases {
		got, err := resolveCertNetwork(tc.ip, tc.cidr)
		if tc.wantErr {
			if err == nil {
				t.Errorf("resolveCertNetwork(%q, %q): expected error, got %q", tc.ip, tc.cidr, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("resolveCertNetwork(%q, %q): %v", tc.ip, tc.cidr, err)
		} else if got != tc.want {
			t.Errorf("resolveCertNetwork(%q, %q) = %q, want %q", tc.ip, tc.cidr, got, tc.want)
		}
	}
}

func TestValidNames(t *testing.T) {
	for _, ok := range []string{"laptop", "alex phone 2", "node-1.example", "a"} {
		if err := validCertName(ok); err != nil {
			t.Errorf("expected %q valid: %v", ok, err)
		}
	}
	for _, bad := range []string{"", " leading", "trailing ", "semi;colon", "back`tick", "$dollar", strings.Repeat("a", 100), "new\nline"} {
		if err := validCertName(bad); err == nil {
			t.Errorf("expected %q invalid", bad)
		}
	}
	for _, bad := range []string{"", "has space", "quo\"te"} {
		if err := validGroup(bad); err == nil {
			t.Errorf("expected group %q invalid", bad)
		}
	}
}

func TestValidDuration(t *testing.T) {
	for _, ok := range []string{"87600h", "1h30m", "300s"} {
		if err := validDuration(ok); err != nil {
			t.Errorf("expected %q valid: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "-5h", "0s", "1000000h", "5 hours", "1d"} {
		if err := validDuration(bad); err == nil {
			t.Errorf("expected %q invalid", bad)
		}
	}
}

func TestImportPEMValidation(t *testing.T) {
	cert := "-----BEGIN NEBULA CERTIFICATE-----\nAAAA\n-----END NEBULA CERTIFICATE-----\n"
	key := "-----BEGIN NEBULA X25519 PRIVATE KEY-----\nAAAA\n-----END NEBULA X25519 PRIVATE KEY-----\n"
	if err := validateCertPEM(cert, "cert"); err != nil {
		t.Errorf("cert PEM: %v", err)
	}
	if err := validateKeyPEM(key, "key"); err != nil {
		t.Errorf("key PEM: %v", err)
	}
	if err := validateCertPEM(key, "cert"); err == nil {
		t.Error("key accepted as certificate")
	}
	if err := validateKeyPEM(cert, "key"); err == nil {
		t.Error("certificate accepted as key")
	}
	if err := validateCertPEM("-----BEGIN CERTIFICATE-----", "cert"); err == nil {
		t.Error("x509 PEM accepted as nebula certificate")
	}
	if err := validateCertPEM(strings.Repeat("x", maxPEMSize+1), "cert"); err == nil {
		t.Error("oversized PEM accepted")
	}
}

func TestNormalizePEM(t *testing.T) {
	proper := "-----BEGIN NEBULA X25519 PRIVATE KEY-----\nQUFBQUFBQUFBQUFBQUFBQQ==\n-----END NEBULA X25519 PRIVATE KEY-----\n"
	// newlines replaced with spaces (single-line/password input paste)
	flattened := "-----BEGIN NEBULA X25519 PRIVATE KEY----- QUFBQUFBQUFBQUFBQUFBQQ== -----END NEBULA X25519 PRIVATE KEY-----"
	if got := normalizePEM(flattened); got != proper {
		t.Errorf("normalizePEM(flattened) = %q, want %q", got, proper)
	}
	// already-correct PEM passes through unchanged
	if got := normalizePEM(proper); got != proper {
		t.Errorf("normalizePEM(proper) = %q, want %q", got, proper)
	}
	if got := normalizePEM("  "); got != "" {
		t.Errorf("normalizePEM(blank) = %q, want empty", got)
	}
}

func TestSaveLoadConfigRoundTrip(t *testing.T) {
	dir := t.TempDir()
	oldConfigFile, oldConfigDir := ConfigFile, ConfigDir
	ConfigDir = dir
	ConfigFile = filepath.Join(dir, "config.json")
	defer func() { ConfigFile, ConfigDir = oldConfigFile, oldConfigDir }()

	c := validNodeConfig()
	if err := saveConfig(c); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(ConfigFile)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0600 {
		t.Errorf("config.json mode = %o, want 0600", fi.Mode().Perm())
	}

	Configmtx.Lock()
	gConfig = defaultConfig()
	Configmtx.Unlock()
	if err := loadConfig(); err != nil {
		t.Fatal(err)
	}
	got := snapshotConfig()
	if got.CIDR != c.CIDR || got.Mode != c.Mode || !got.Enabled {
		t.Errorf("round trip mismatch: %+v", got)
	}
	if len(got.StaticHostMap["192.168.100.1"]) != 2 {
		t.Errorf("static host map lost in round trip: %+v", got.StaticHostMap)
	}

	// stored-but-invalid config must be rejected on load
	if err := os.WriteFile(ConfigFile, []byte(`{"Mode":"evil"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadConfig(); err == nil {
		t.Error("expected error loading invalid stored config")
	}
}

func TestConfigResponseHasNoKeyMaterial(t *testing.T) {
	// GET /config returns configResponse; ensure no field could carry key
	// material even if files exist: serialize and scan for suspicious keys.
	resp := configResponse{Config: validNodeConfig(), CAConfigured: true, CertConfigured: true}
	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	for _, banned := range []string{"PRIVATE KEY", "CAKey", "HostKey", "APIToken"} {
		if strings.Contains(string(data), banned) {
			t.Errorf("config response contains %q: %s", banned, data)
		}
	}
}
