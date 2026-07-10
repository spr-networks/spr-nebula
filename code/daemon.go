package main

// Supervision of the nebula daemon as a child process: the generated config is
// tested with `nebula -test` before every (re)start, and unexpected exits are
// retried with a small backoff.

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Supervisor struct {
	mtx       sync.Mutex
	cmd       *exec.Cmd
	done      chan struct{}
	stopping  bool
	startedAt time.Time
}

func (s *Supervisor) Running() bool {
	s.mtx.Lock()
	defer s.mtx.Unlock()
	return s.cmd != nil
}

func (s *Supervisor) Start() error {
	s.mtx.Lock()
	defer s.mtx.Unlock()
	if s.cmd != nil {
		return nil
	}
	s.stopping = false

	cfg := snapshotConfig()
	if !cfg.Enabled {
		return fmt.Errorf("plugin is disabled")
	}
	if err := credentialsReady(); err != nil {
		return err
	}
	yml := genNebulaYAML(&cfg)
	if err := writeFileAtomic(NebulaConfigFile, []byte(yml), 0600); err != nil {
		return err
	}
	if out, err := testNebulaConfig(); err != nil {
		return fmt.Errorf("nebula config test failed: %v: %s", err, out)
	}

	cmd := exec.Command(NebulaBin, "-config", NebulaConfigFile)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	log.Printf("nebula started (pid %d, mode %s)", cmd.Process.Pid, cfg.Mode)
	done := make(chan struct{})
	s.cmd, s.done = cmd, done
	s.startedAt = time.Now()
	go s.waiter(cmd, done)
	return nil
}

func (s *Supervisor) waiter(cmd *exec.Cmd, done chan struct{}) {
	err := cmd.Wait()
	close(done)
	s.mtx.Lock()
	restart := !s.stopping
	if s.cmd == cmd {
		s.cmd = nil
	}
	s.mtx.Unlock()
	if restart {
		log.Printf("nebula exited unexpectedly: %v — restarting in 5s", err)
		time.Sleep(5 * time.Second)
		if err := s.Start(); err != nil {
			log.Println("nebula restart skipped:", err)
		}
	}
}

func (s *Supervisor) Stop() {
	s.mtx.Lock()
	s.stopping = true
	cmd, done := s.cmd, s.done
	s.mtx.Unlock()
	if cmd == nil {
		return
	}
	cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		cmd.Process.Kill()
		<-done
	}
}

func (s *Supervisor) Restart() error {
	s.Stop()
	return s.Start()
}

// RestartIfEnabled restarts (or starts) nebula when the plugin is enabled;
// used after credential changes.
func (s *Supervisor) RestartIfEnabled() {
	if !snapshotConfig().Enabled {
		return
	}
	if err := s.Restart(); err != nil {
		log.Println("nebula restart:", err)
	}
}

func testNebulaConfig() (string, error) {
	if !fileExists(NebulaBin) {
		// host/dev environment without the daemon binary
		return "", nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, NebulaBin, "-test", "-config", NebulaConfigFile).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

var (
	nebulaVersionOnce sync.Once
	nebulaVersionStr  string
)

func nebulaVersion() string {
	nebulaVersionOnce.Do(func() {
		if !fileExists(NebulaBin) {
			return
		}
		out, err := exec.Command(NebulaBin, "-version").CombinedOutput()
		if err == nil {
			nebulaVersionStr = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(string(out)), "Version:"))
		}
	})
	return nebulaVersionStr
}

// ---- status --------------------------------------------------------------

type LighthouseStatus struct {
	Host      string
	Reachable bool
}

type StatusResponse struct {
	Enabled        bool
	Running        bool
	Mode           string
	ListenPort     int
	InterfaceName  string
	InterfaceUp    bool
	InterfaceIPs   []string
	Lighthouses    []LighthouseStatus
	CAConfigured   bool
	CertConfigured bool
	NebulaVersion  string      `json:",omitempty"`
	StartedAt      string      `json:",omitempty"` // RFC3339, present while running
	CertInfo       interface{} `json:",omitempty"`
	Message        string      `json:",omitempty"`
}

func (s *Supervisor) startedAtRFC3339() string {
	s.mtx.Lock()
	defer s.mtx.Unlock()
	if s.cmd == nil || s.startedAt.IsZero() {
		return ""
	}
	return s.startedAt.Format(time.RFC3339)
}

func interfaceStatus() (bool, []string) {
	iface, err := net.InterfaceByName(NebulaInterface)
	if err != nil {
		return false, nil
	}
	ips := []string{}
	if addrs, err := iface.Addrs(); err == nil {
		for _, a := range addrs {
			ips = append(ips, a.String())
		}
	}
	return iface.Flags&net.FlagUp != 0, ips
}

// pingLighthouses checks lighthouse connectivity over the overlay (ICMP via
// the tun device; our generated firewall allows all outbound).
func pingLighthouses(hosts []string) []LighthouseStatus {
	if len(hosts) > 8 {
		hosts = hosts[:8]
	}
	res := make([]LighthouseStatus, len(hosts))
	var wg sync.WaitGroup
	for i, h := range hosts {
		wg.Add(1)
		go func(i int, h string) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			// h passed validOverlayIP; argv exec, no shell
			err := exec.CommandContext(ctx, "ping", "-c", "1", "-W", "2", h).Run()
			res[i] = LighthouseStatus{Host: h, Reachable: err == nil}
		}(i, h)
	}
	wg.Wait()
	return res
}

func (s *Supervisor) buildStatus() StatusResponse {
	cfg := snapshotConfig()
	up, ips := interfaceStatus()
	st := StatusResponse{
		Enabled:        cfg.Enabled,
		Running:        s.Running(),
		Mode:           cfg.Mode,
		ListenPort:     cfg.ListenPort,
		InterfaceName:  NebulaInterface,
		InterfaceUp:    up,
		InterfaceIPs:   ips,
		Lighthouses:    []LighthouseStatus{},
		CAConfigured:   caConfigured(),
		CertConfigured: certConfigured(),
		NebulaVersion:  nebulaVersion(),
		StartedAt:      s.startedAtRFC3339(),
	}
	if raw := certInfo(); raw != nil {
		st.CertInfo = raw
	}
	if st.Running && cfg.Mode == "node" && up {
		st.Lighthouses = pingLighthouses(cfg.LighthouseHosts)
	}
	if !st.Running {
		if !cfg.Enabled {
			st.Message = "plugin is disabled"
		} else if err := credentialsReady(); err != nil {
			st.Message = err.Error()
		} else {
			st.Message = "nebula is not running"
		}
	}
	return st
}
