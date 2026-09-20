package plugin

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/komari-monitor/komari/database/models"
)

// enforceMonitorOnlyPluginPolicy is disabled only by the plugin package's
// low-level capability tests. Production builds always keep it enabled.
var enforceMonitorOnlyPluginPolicy = true

// komari-passkey 0.1.13-deer.1 is the only pinned exception. It currently
// needs HTML injection and system RPC to add passkey login to the frontend.
// Any byte-level change invalidates the pin and prevents the plugin loading.
const pinnedPasskeyPackageSHA256 = "58ffa68a908fb52843a7347de902d187f6a78cbf71975ad8479547fbaae1021a"

func forbiddenPluginPermissions(p models.PluginPermissions) []string {
	var names []string
	if p.AllowSystemRPC {
		names = append(names, "allowSystemRPC")
	}
	if p.AllowHooks {
		names = append(names, "allowHooks")
	}
	if p.AllowHTMLInject {
		names = append(names, "allowHTMLInject")
	}
	if p.AllowExec {
		names = append(names, "allowExec")
	}
	if p.AllowListen {
		names = append(names, "allowListen")
	}
	if p.AllowAllFileAccess {
		names = append(names, "allowAllFileAccess")
	}
	return names
}

func validatePluginSecurityPolicy(info models.Plugin, packageHash string) error {
	if !enforceMonitorOnlyPluginPolicy {
		return nil
	}
	forbidden := forbiddenPluginPermissions(info.Permissions)
	if len(forbidden) == 0 {
		return nil
	}
	if info.Short == "komari-passkey" && packageHash == pinnedPasskeyPackageSHA256 {
		return nil
	}
	return fmt.Errorf("monitor-only build forbids high-risk plugin permissions: %s", strings.Join(forbidden, ", "))
}

func hashPluginDirectory(root string) (string, error) {
	var files []string
	if err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			files = append(files, path)
		}
		return nil
	}); err != nil {
		return "", err
	}
	sort.Strings(files)
	h := sha256.New()
	for _, name := range files {
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return "", err
		}
		_, _ = io.WriteString(h, filepath.ToSlash(rel))
		_, _ = h.Write([]byte{0})
		file, err := os.Open(name)
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(h, file)
		closeErr := file.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hashPluginArchive(files []*zip.File) (string, error) {
	regular := make([]*zip.File, 0, len(files))
	for _, file := range files {
		if !file.FileInfo().IsDir() {
			regular = append(regular, file)
		}
	}
	sort.Slice(regular, func(i, j int) bool { return regular[i].Name < regular[j].Name })
	h := sha256.New()
	for _, file := range regular {
		_, _ = io.WriteString(h, filepath.ToSlash(file.Name))
		_, _ = h.Write([]byte{0})
		r, err := file.Open()
		if err != nil {
			return "", err
		}
		_, copyErr := io.Copy(h, r)
		closeErr := r.Close()
		if copyErr != nil {
			return "", copyErr
		}
		if closeErr != nil {
			return "", closeErr
		}
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
