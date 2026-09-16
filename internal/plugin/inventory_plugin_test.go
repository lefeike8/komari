package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/komari-monitor/komari/pkg/rpc"
)

func inventoryFixture(t *testing.T) map[string]string {
	t.Helper()
	root := filepath.Join("..", "..", "contrib", "plugins", "komari-inventory")
	files := make(map[string]string)
	for _, name := range []string{
		"komari-plugin.json",
		"script.js",
		"pages/admin.html",
		"pages/admin.js",
		"pages/admin.css",
		"pages/scanner.sh",
	} {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			t.Fatalf("read inventory fixture %s: %v", name, err)
		}
		files[name] = string(data)
	}
	// The plugin test harness identifies itself as Komari 0.0.1. Keep the
	// production constraint in the fixture file, but relax only the in-memory
	// copy so the integration test can load it.
	files["komari-plugin.json"] = strings.Replace(files["komari-plugin.json"], `"komari": ">1.4.3"`, `"komari": ">=0.0.1"`, 1)
	return files
}

func inventoryRPC(t *testing.T, method string, params any) map[string]any {
	t.Helper()
	response := rpc.CallWithContext(context.Background(), nil, method, params)
	if response.Error != nil {
		t.Fatalf("%s: %v", method, response.Error)
	}
	raw, err := json.Marshal(response.Result)
	if err != nil {
		t.Fatalf("%s result marshal: %v", method, err)
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatalf("%s result unmarshal: %v", method, err)
	}
	return result
}

func inventoryField(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func TestInventorySingleUseUpload(t *testing.T) {
	withTempDataDir(t)
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	Init(engine)

	zipPath := writePluginZip(t, inventoryFixture(t))
	if _, err := InstallZip(zipPath); err != nil {
		t.Fatal(err)
	}
	if err := SetEnabled("komari-inventory", true, true); err != nil {
		t.Fatal(err)
	}

	inventoryRPC(t, "plugin:inventorySaveNode", map[string]any{
		"node_id": "node-a",
		"data": map[string]any{
			"notes":    "keep me",
			"services": []any{map[string]any{"name": "manual-service", "type": "manual"}},
		},
	})
	ticket := inventoryRPC(t, "plugin:inventoryCreateUpload", map[string]any{"node_id": "node-a"})
	token, _ := ticket["token"].(string)
	uploadID, _ := ticket["upload_id"].(string)
	if token == "" || uploadID == "" {
		t.Fatalf("incomplete upload ticket: %#v", ticket)
	}

	scanner := httptest.NewRecorder()
	engine.ServeHTTP(scanner, httptest.NewRequest(http.MethodGet, "/api/plugin/inventory/v1/scanner", nil))
	if scanner.Code != http.StatusOK || !strings.Contains(scanner.Body.String(), "KOMARI_INVENTORY_V1") {
		t.Fatalf("scanner response: status=%d body=%q", scanner.Code, scanner.Body.String())
	}
	digest := sha256.Sum256(scanner.Body.Bytes())
	if got, _ := ticket["scanner_sha256"].(string); got != hex.EncodeToString(digest[:]) {
		t.Fatalf("scanner digest = %q, want %q", got, hex.EncodeToString(digest[:]))
	}

	scanOutput := strings.Join([]string{
		"KOMARI_INVENTORY_V1",
		"META\t" + inventoryField("test-host") + "\t" + inventoryField("2026-09-16T00:00:00Z"),
		"SERVICE\t" + inventoryField("docker") + "\t" + inventoryField("komari") + "\t" + inventoryField("running") + "\t" + inventoryField("Up 1 hour") + "\t" + inventoryField("ghcr.io/komari-monitor/komari:latest") + "\t" + inventoryField("0.0.0.0:25774->25774/tcp") + "\t" + inventoryField("docker"),
		"DOMAIN\t" + inventoryField("nginx") + "\t" + inventoryField("status.example.com") + "\t" + inventoryField("http://127.0.0.1:25774"),
		"PORT\t" + inventoryField("tcp") + "\t" + inventoryField("0.0.0.0:443") + "\t" + inventoryField("nginx"),
		"KOMARI_INVENTORY_END",
		"",
	}, "\n")

	submitRequest := httptest.NewRequest(http.MethodPost, "/api/plugin/inventory/v1/submit", strings.NewReader(scanOutput))
	submitRequest.Header.Set("Authorization", "Bearer "+token)
	submitRequest.Header.Set("Content-Type", "text/plain")
	submit := httptest.NewRecorder()
	engine.ServeHTTP(submit, submitRequest)
	if submit.Code != http.StatusOK {
		t.Fatalf("submit status=%d body=%s", submit.Code, submit.Body.String())
	}
	var submitBody map[string]any
	if err := json.Unmarshal(submit.Body.Bytes(), &submitBody); err != nil || submitBody["ok"] != true {
		t.Fatalf("submit body=%s err=%v", submit.Body.String(), err)
	}

	replayRequest := httptest.NewRequest(http.MethodPost, "/api/plugin/inventory/v1/submit", strings.NewReader(scanOutput))
	replayRequest.Header.Set("Authorization", "Bearer "+token)
	replay := httptest.NewRecorder()
	engine.ServeHTTP(replay, replayRequest)
	if replay.Code != http.StatusUnauthorized {
		t.Fatalf("replay status=%d body=%s", replay.Code, replay.Body.String())
	}

	status := inventoryRPC(t, "plugin:inventoryGetUploadStatus", map[string]any{"upload_id": uploadID})
	if status["status"] != "completed" {
		t.Fatalf("upload status = %#v", status)
	}
	node := inventoryRPC(t, "plugin:inventoryGetNode", map[string]any{"node_id": "node-a"})
	data, _ := node["data"].(map[string]any)
	if data["notes"] != "keep me" {
		t.Fatalf("manual notes were overwritten: %#v", data)
	}
	services, _ := data["services"].([]any)
	if len(services) != 1 {
		t.Fatalf("manual services were overwritten: %#v", data["services"])
	}
	lastScan, _ := data["last_scan"].(map[string]any)
	scannedServices, _ := lastScan["services"].([]any)
	if len(scannedServices) != 1 {
		t.Fatalf("scan was not stored: %#v", lastScan)
	}
}
