package jsonrpc

import (
	"testing"

	"github.com/komari-monitor/komari/pkg/rpc"
)

func TestMonitorOnlyBuildOmitsRemoteControlRPCMethods(t *testing.T) {
	methods := []string{
		"admin:exec",
		"admin:getTasks",
		"admin:getTaskById",
		"admin:getTasksByClientId",
		"admin:getSpecificTaskResult",
		"admin:getTaskResultsByTaskId",
		"admin:fileList",
		"admin:fileListRoots",
		"admin:fileStat",
		"admin:fileMkdir",
		"admin:fileDelete",
		"admin:fileMove",
		"admin:fileCopy",
		"admin:fileChmod",
		"admin:fileChown",
		"admin:fileSearch",
		"admin:getXtermjsSettings",
		"admin:setXtermjsSettings",
	}
	for _, method := range methods {
		response := rpc.Call(1, method, nil)
		if response.Error == nil || response.Error.Code != rpc.MethodNotFound {
			t.Errorf("%s is still callable: %+v", method, response)
		}
	}
}
