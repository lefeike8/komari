package plugin

import (
	"strings"
	"testing"

	"github.com/komari-monitor/komari/database/models"
)

func TestMonitorOnlyPolicyRejectsHighRiskPermissions(t *testing.T) {
	previous := enforceMonitorOnlyPluginPolicy
	enforceMonitorOnlyPluginPolicy = true
	t.Cleanup(func() { enforceMonitorOnlyPluginPolicy = previous })

	permissions := models.PluginPermissions{
		AllowSystemRPC:     true,
		AllowHooks:         true,
		AllowHTMLInject:    true,
		AllowExec:          true,
		AllowListen:        true,
		AllowAllFileAccess: true,
	}
	err := validatePluginSecurityPolicy(models.Plugin{Short: "untrusted", Permissions: permissions}, "not-pinned")
	if err == nil {
		t.Fatal("high-risk plugin permissions were accepted")
	}
	for _, name := range forbiddenPluginPermissions(permissions) {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("error %q does not name rejected permission %q", err, name)
		}
	}
}

func TestMonitorOnlyPolicyAllowsRouteOnlyPlugin(t *testing.T) {
	previous := enforceMonitorOnlyPluginPolicy
	enforceMonitorOnlyPluginPolicy = true
	t.Cleanup(func() { enforceMonitorOnlyPluginPolicy = previous })

	err := validatePluginSecurityPolicy(models.Plugin{
		Short:       "inventory",
		Permissions: models.PluginPermissions{AllowRoutes: true},
	}, "any-hash")
	if err != nil {
		t.Fatalf("route-only plugin rejected: %v", err)
	}
}
