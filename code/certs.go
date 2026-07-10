package main

// Certificate management. The CA private key is generated into
// /configs/spr-nebula/ca.key (0600) and is NEVER returned by any endpoint.
// Device keys created by POST /certs exist only in the HTTP response (and a
// temp dir that is removed before the handler returns) unless Install is set,
// in which case the pair becomes this router's own node credentials.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const maxPEMSize = 64 * 1024

func runNebulaCert(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, NebulaCertBin, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("nebula-cert %s: %v: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func caConfigured() bool   { return fileExists(CACertPath) && fileExists(CAKeyPath) }
func certConfigured() bool { return fileExists(HostCertPath) && fileExists(HostKeyPath) }

// credentialsReady reports whether the node can start.
func credentialsReady() error {
	if !fileExists(CACertPath) {
		return fmt.Errorf("missing CA certificate (create a CA or import one)")
	}
	if !fileExists(HostCertPath) || !fileExists(HostKeyPath) {
		return fmt.Errorf("missing node certificate/key (issue one with Install, or import)")
	}
	return nil
}

type caRequest struct {
	Name     string
	Duration string
	Force    bool
}

// POST /ca — generate a new CA. The private key is written to ca.key (0600)
// and never leaves the container; only the CA certificate is returned.
func (p *nebulaPlugin) handleCreateCA(w http.ResponseWriter, r *http.Request) {
	var req caRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPEMSize)).Decode(&req); err != nil && err != io.EOF {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.Name == "" {
		req.Name = "SPR Nebula CA"
	}
	if err := validCertName(req.Name); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if req.Duration == "" {
		req.Duration = "87600h" // 10 years
	}
	if err := validDuration(req.Duration); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if (fileExists(CACertPath) || fileExists(CAKeyPath)) && !req.Force {
		http.Error(w, "a CA already exists; pass Force to overwrite (this orphans all previously issued certificates)", 409)
		return
	}

	tmpDir, err := os.MkdirTemp(ConfigDir, ".ca-*")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.RemoveAll(tmpDir)

	crt, key := tmpDir+"/ca.crt", tmpDir+"/ca.key"
	// -version 1 for widest client interoperability (v1 certs work with all
	// nebula releases; 1.10 defaults to the newer v2 format).
	if _, err := runNebulaCert("ca", "-version", "1",
		"-name", req.Name, "-duration", req.Duration,
		"-out-crt", crt, "-out-key", key); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := installFile(key, CAKeyPath, 0600); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if err := installFile(crt, CACertPath, 0644); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	caPEM, err := os.ReadFile(CACertPath)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]string{"CACert": string(caPEM)})
}

// GET /ca — public part of the CA only.
func (p *nebulaPlugin) handleGetCA(w http.ResponseWriter, r *http.Request) {
	caPEM, err := os.ReadFile(CACertPath)
	if err != nil {
		http.Error(w, "no CA configured", 404)
		return
	}
	writeJSON(w, map[string]string{"CACert": string(caPEM)})
}

type signRequest struct {
	Name     string
	IP       string // "10.42.0.5" (uses network CIDR prefix) or "10.42.0.5/24"
	Groups   []string
	Duration string
	// Install=true makes the signed pair this router's own node credentials
	// (host.crt/host.key, key persisted 0600, not returned). Otherwise the key
	// is returned exactly once and never stored.
	Install bool
}

// resolveCertNetwork turns the request IP into "a.b.c.d/nn", defaulting the
// prefix length from cfgCIDR and enforcing membership when cfgCIDR is set.
func resolveCertNetwork(reqIP string, cfgCIDR string) (string, error) {
	ipStr, prefix := reqIP, -1
	if i := strings.IndexByte(reqIP, '/'); i >= 0 {
		ipStr = reqIP[:i]
		p, err := strconv.Atoi(reqIP[i+1:])
		if err != nil || p < 0 || p > 32 {
			return "", fmt.Errorf("invalid prefix length in %q", reqIP)
		}
		prefix = p
	}
	ip := net.ParseIP(ipStr)
	if ip == nil || ip.To4() == nil {
		return "", fmt.Errorf("invalid IPv4 address %q", ipStr)
	}
	if cfgCIDR != "" {
		_, ipnet, err := net.ParseCIDR(cfgCIDR)
		if err != nil {
			return "", fmt.Errorf("invalid network CIDR %q", cfgCIDR)
		}
		if !ipnet.Contains(ip) {
			return "", fmt.Errorf("%s is outside the configured network %s", ipStr, cfgCIDR)
		}
		if prefix == -1 {
			prefix, _ = ipnet.Mask.Size()
		}
	}
	if prefix == -1 {
		return "", fmt.Errorf("no prefix length given and no network CIDR configured; use e.g. %s/24", ipStr)
	}
	return fmt.Sprintf("%s/%d", ip.To4().String(), prefix), nil
}

// POST /certs — sign a node certificate.
func (p *nebulaPlugin) handleSignCert(w http.ResponseWriter, r *http.Request) {
	var req signRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPEMSize)).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := validCertName(req.Name); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	for _, g := range req.Groups {
		if err := validGroup(g); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}
	if req.Duration != "" {
		if err := validDuration(req.Duration); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}
	if !caConfigured() {
		http.Error(w, "no CA configured; create or import one first", 400)
		return
	}
	network, err := resolveCertNetwork(req.IP, snapshotConfig().CIDR)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}

	tmpDir, err := os.MkdirTemp(ConfigDir, ".sign-*")
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer os.RemoveAll(tmpDir)

	crt, key := tmpDir+"/node.crt", tmpDir+"/node.key"
	args := []string{"sign",
		"-ca-crt", CACertPath, "-ca-key", CAKeyPath,
		"-name", req.Name, "-networks", network,
		"-out-crt", crt, "-out-key", key}
	if len(req.Groups) > 0 {
		args = append(args, "-groups", strings.Join(req.Groups, ","))
	}
	if req.Duration != "" {
		args = append(args, "-duration", req.Duration)
	}
	if _, err := runNebulaCert(args...); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	crtPEM, err := os.ReadFile(crt)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	if req.Install {
		if err := installFile(key, HostKeyPath, 0600); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if err := installFile(crt, HostCertPath, 0644); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		go p.sup.RestartIfEnabled()
		writeJSON(w, map[string]interface{}{
			"Cert": string(crtPEM), "Installed": true,
		})
		return
	}

	keyPEM, err := os.ReadFile(key)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	// The private key exists only in this response; the temp copy is removed
	// by the deferred cleanup above.
	writeJSON(w, map[string]interface{}{
		"Cert": string(crtPEM), "Key": string(keyPEM), "Installed": false,
	})
}

// installFile copies a freshly generated file into place with the given mode.
func installFile(src, dst string, mode os.FileMode) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return writeFileAtomic(dst, data, mode)
}

type importRequest struct {
	CACert   string
	HostCert string
	HostKey  string
}

var (
	pemHeaderRe = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]+-----`)
	pemFooterRe = regexp.MustCompile(`-----END [A-Z0-9 ]+-----`)
)

// normalizePEM repairs PEM material pasted through single-line form fields
// (e.g. a password input), where newlines get stripped or turned into spaces.
func normalizePEM(s string) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\r\n", "\n")
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "\n") {
		s = pemHeaderRe.ReplaceAllStringFunc(s, func(m string) string { return m + "\n" })
		s = pemFooterRe.ReplaceAllStringFunc(s, func(m string) string { return "\n" + m + "\n" })
		lines := strings.Split(s, "\n")
		for i, l := range lines {
			if !strings.HasPrefix(l, "-----") {
				// base64 body chunks were joined by spaces
				lines[i] = strings.ReplaceAll(strings.TrimSpace(l), " ", "\n")
			}
		}
		s = strings.Join(lines, "\n")
	}
	if !strings.HasSuffix(s, "\n") {
		s += "\n"
	}
	return s
}

func validateCertPEM(s, what string) error {
	if len(s) > maxPEMSize {
		return fmt.Errorf("%s too large", what)
	}
	if !strings.Contains(s, "-----BEGIN NEBULA CERTIFICATE-----") {
		return fmt.Errorf("%s does not look like a nebula certificate", what)
	}
	return nil
}

func validateKeyPEM(s, what string) error {
	if len(s) > maxPEMSize {
		return fmt.Errorf("%s too large", what)
	}
	if !strings.Contains(s, "-----BEGIN NEBULA ") || !strings.Contains(s, "PRIVATE KEY-----") {
		return fmt.Errorf("%s does not look like a nebula private key", what)
	}
	return nil
}

// POST /keys/import — join an existing network: import ca.crt and/or a
// host cert+key pair issued elsewhere. Keys are stored 0600 in /configs.
func (p *nebulaPlugin) handleImportKeys(w http.ResponseWriter, r *http.Request) {
	var req importRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*maxPEMSize)).Decode(&req); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	req.CACert = normalizePEM(req.CACert)
	req.HostCert = normalizePEM(req.HostCert)
	req.HostKey = normalizePEM(req.HostKey)
	if req.CACert == "" && req.HostCert == "" && req.HostKey == "" {
		http.Error(w, "nothing to import", 400)
		return
	}
	if (req.HostCert == "") != (req.HostKey == "") {
		http.Error(w, "host certificate and key must be imported together", 400)
		return
	}
	if req.CACert != "" {
		if err := validateCertPEM(req.CACert, "CA certificate"); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}
	if req.HostCert != "" {
		if err := validateCertPEM(req.HostCert, "host certificate"); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := validateKeyPEM(req.HostKey, "host key"); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
	}
	// deeper validation via nebula-cert when available (always in-container)
	if fileExists(NebulaCertBin) {
		for what, pem := range map[string]string{"CA certificate": req.CACert, "host certificate": req.HostCert} {
			if pem == "" {
				continue
			}
			if err := printCheck(pem); err != nil {
				http.Error(w, what+": "+err.Error(), 400)
				return
			}
		}
	}
	if req.CACert != "" {
		if err := writeFileAtomic(CACertPath, []byte(req.CACert), 0644); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}
	if req.HostCert != "" {
		if err := writeFileAtomic(HostKeyPath, []byte(req.HostKey), 0600); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if err := writeFileAtomic(HostCertPath, []byte(req.HostCert), 0644); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}
	go p.sup.RestartIfEnabled()
	writeJSON(w, map[string]bool{
		"CAConfigured":   caConfigured(),
		"CertConfigured": certConfigured(),
	})
}

// printCheck round-trips a certificate through `nebula-cert print`.
func printCheck(pem string) error {
	tmp, err := os.CreateTemp(ConfigDir, ".verify-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(pem); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	_, err = runNebulaCert("print", "-path", tmp.Name())
	return err
}

// certInfo returns `nebula-cert print -json` for the node certificate.
func certInfo() json.RawMessage {
	if !fileExists(HostCertPath) || !fileExists(NebulaCertBin) {
		return nil
	}
	out, err := runNebulaCert("print", "-json", "-path", HostCertPath)
	if err != nil {
		return nil
	}
	raw := json.RawMessage(strings.TrimSpace(out))
	if !json.Valid(raw) {
		return nil
	}
	return raw
}
