package main

// spr-nebula plugin backend. Serves JSON endpoints and the bundled UI over the
// SPR plugin unix socket (never a TCP listener). SPR proxies
// /plugins/spr-nebula/* to this socket with the URI prefix stripped.

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

var UNIX_PLUGIN_LISTENER = TEST_PREFIX + "/state/plugins/spr-nebula/socket"

// name of the docker bridge for this plugin's network (see docker-compose.yml
// and plugin.json NetworkCapabilities.Interface)
var gSPRNebulaInterface = "spr-nebula"

type nebulaPlugin struct {
	sup *Supervisor
}

// writeJSON keeps the response contract explicit. net/http otherwise sniffs
// encoded JSON as text/plain, which makes the plugin UI return a string instead
// of decoding the response object.
func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Println("encoding response failed:", err)
	}
}

// configResponse is what GET /config returns: the stored config plus derived
// state. Private keys are never part of Config — nothing to redact, and no
// endpoint ever returns ca.key or host.key.
type configResponse struct {
	Config
	CAConfigured   bool
	CertConfigured bool
}

func (p *nebulaPlugin) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	resp := configResponse{
		Config:         snapshotConfig(),
		CAConfigured:   caConfigured(),
		CertConfigured: certConfigured(),
	}
	writeJSON(w, resp)
}

func (p *nebulaPlugin) handlePutConfig(w http.ResponseWriter, r *http.Request) {
	c := defaultConfig()
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&c); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := c.Validate(); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := saveConfig(c); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if c.Enabled {
		if err := p.sup.Restart(); err != nil {
			http.Error(w, fmt.Sprintf("config saved, but nebula did not start: %v", err), 500)
			return
		}
	} else {
		p.sup.Stop()
	}
	p.handleGetConfig(w, r)
}

func (p *nebulaPlugin) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, p.sup.buildStatus())
}

func (p *nebulaPlugin) handleRestart(w http.ResponseWriter, r *http.Request) {
	if !snapshotConfig().Enabled {
		http.Error(w, "plugin is disabled; enable it in the configuration first", 400)
		return
	}
	if err := p.sup.Restart(); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]string{"status": "restarted"})
}

// spaHandler serves the bundled single-file UI.
type spaHandler struct {
	staticPath string
	indexPath  string
}

func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path, err := filepath.Abs(r.URL.Path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	path = filepath.Join(h.staticPath, path)
	_, err = os.Stat(path)
	if os.IsNotExist(err) {
		http.ServeFile(w, r, filepath.Join(h.staticPath, h.indexPath))
		return
	} else if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.FileServer(http.Dir(h.staticPath)).ServeHTTP(w, r)
}

func logRequest(handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Printf("%s %s %s\n", r.RemoteAddr, r.Method, r.URL)
		handler.ServeHTTP(w, r)
	})
}

func main() {
	log.SetOutput(os.Stdout)

	if err := os.MkdirAll(ConfigDir, 0700); err != nil {
		log.Fatal(err)
	}
	if err := loadConfig(); err != nil {
		log.Println("starting with default config:", err)
	}

	plugin := &nebulaPlugin{sup: &Supervisor{}}
	if snapshotConfig().Enabled {
		if err := plugin.sup.Start(); err != nil {
			log.Println("nebula not started:", err)
		}
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", plugin.handleStatus)
	mux.HandleFunc("GET /topology", plugin.handleTopology)
	mux.HandleFunc("GET /config", plugin.handleGetConfig)
	mux.HandleFunc("PUT /config", plugin.handlePutConfig)
	mux.HandleFunc("POST /restart", plugin.handleRestart)
	mux.HandleFunc("POST /ca", plugin.handleCreateCA)
	mux.HandleFunc("GET /ca", plugin.handleGetCA)
	mux.HandleFunc("POST /certs", plugin.handleSignCert)
	mux.HandleFunc("POST /keys/import", plugin.handleImportKeys)

	// UI (index.html + assets); SPR fetches index.html via the socket
	mux.Handle("/", spaHandler{staticPath: "/ui", indexPath: "index.html"})

	os.Remove(UNIX_PLUGIN_LISTENER)
	if err := os.MkdirAll(filepath.Dir(UNIX_PLUGIN_LISTENER), 0755); err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("unix", UNIX_PLUGIN_LISTENER)
	if err != nil {
		log.Fatal(err)
	}
	if err := os.Chmod(UNIX_PLUGIN_LISTENER, 0770); err != nil {
		log.Fatal(err)
	}

	server := http.Server{Handler: logRequest(mux)}
	log.Println("spr-nebula plugin listening on", UNIX_PLUGIN_LISTENER)
	log.Fatal(server.Serve(listener))
}
