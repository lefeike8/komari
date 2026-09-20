package router

import (
	"testing"

	"github.com/gin-gonic/gin"
)

func TestMonitorOnlyBuildOmitsRemoteControlRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	registerPublicRoutes(engine)
	registerAgentRoutes(engine)
	registerAdminRoutes(engine)

	forbidden := map[string]struct{}{
		"POST /api/clients/register":                     {},
		"GET /api/clients/terminal":                      {},
		"GET /api/clients/transfer/:id":                  {},
		"POST /api/clients/transfer/:id":                 {},
		"GET /api/admin/client/:uuid/terminal":           {},
		"POST /api/admin/client/:uuid/file/upload":       {},
		"GET /api/admin/client/:uuid/file/download":      {},
		"GET /api/admin/client/:uuid/file/preview-token": {},
		"GET /api/preview/client/:uuid/file/download":    {},
		"POST /api/admin/task/exec":                      {},
		"GET /api/admin/task/all":                        {},
		"GET /api/admin/settings/xtermjs":                {},
		"POST /api/admin/settings/xtermjs":               {},
	}
	for _, route := range engine.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := forbidden[key]; exists {
			t.Errorf("forbidden monitor-only route is registered: %s", key)
		}
	}
}
