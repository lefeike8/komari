(function () {
  "use strict";

  const ui = {
    node: document.getElementById("node-select"),
    message: document.getElementById("message"),
    save: document.getElementById("save-button"),
    command: document.getElementById("command-button"),
    commandPanel: document.getElementById("command-panel"),
    commandText: document.getElementById("scan-command"),
    commandExpiry: document.getElementById("command-expiry"),
    uploadStatus: document.getElementById("upload-status"),
    copyCommand: document.getElementById("copy-command"),
    timestamps: document.getElementById("timestamps"),
    services: document.getElementById("services-body"),
    domains: document.getElementById("domains-body"),
    ports: document.getElementById("ports-body"),
    notes: document.getElementById("node-notes"),
    scanPanel: document.getElementById("scan-panel"),
    scanSummary: document.getElementById("scan-summary"),
    scanWarnings: document.getElementById("scan-warnings"),
    scanResults: document.getElementById("scan-results"),
    importSelected: document.getElementById("import-selected")
  };

  let nodes = {};
  let currentNodeId = "";
  let current = emptyNode();
  let activeUpload = null;
  let uploadPollTimer = 0;

  function emptyNode() {
    return { notes: "", services: [], domains: [], ports: [], last_scan: { scanned_at: "", hostname: "", services: [], domains: [], ports: [], warnings: [] }, updated_at: "" };
  }

  function uid(prefix) {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return prefix + "-" + globalThis.crypto.randomUUID();
    return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  async function rpc(method, params) {
    const response = await fetch("/api/rpc2", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params || {} })
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const body = await response.json();
    if (body.error) {
      const error = new Error(body.error.message || "RPC 调用失败");
      error.code = body.error.code;
      error.data = body.error.data;
      throw error;
    }
    return body.result;
  }

  function showMessage(message, isError) {
    ui.message.textContent = message;
    ui.message.className = "inventory-message" + (isError ? " error" : "");
    ui.message.hidden = !message;
  }

  function input(value, field, placeholder, type) {
    const element = document.createElement("input");
    element.type = type || "text";
    element.value = value === undefined || value === null ? "" : String(value);
    element.dataset.field = field;
    if (placeholder) element.placeholder = placeholder;
    return element;
  }

  function select(value, field, options) {
    const element = document.createElement("select");
    element.dataset.field = field;
    options.forEach(function (option) {
      const item = document.createElement("option");
      item.value = option[0];
      item.textContent = option[1];
      item.selected = option[0] === value;
      element.appendChild(item);
    });
    return element;
  }

  function removeButton(handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "danger";
    button.textContent = "删除";
    button.addEventListener("click", handler);
    return button;
  }

  function cell(child) {
    const td = document.createElement("td");
    td.appendChild(child);
    return td;
  }

  function renderServices() {
    ui.services.textContent = "";
    if (!current.services.length) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "empty";
      td.textContent = "尚未记录服务";
      row.appendChild(td);
      ui.services.appendChild(row);
      return;
    }
    current.services.forEach(function (service, index) {
      const row = document.createElement("tr");
      row.dataset.index = String(index);
      row.appendChild(cell(input(service.name, "name", "例如 vaultwarden")));
      row.appendChild(cell(input(service.type, "type", "Docker/systemd/手工")));
      row.appendChild(cell(input(service.state, "state", "running/stopped")));
      row.appendChild(cell(input(service.image, "image", "镜像或版本")));
      row.appendChild(cell(input(service.ports, "ports", "80, 443")));
      row.appendChild(cell(input(service.note, "note", "说明")));
      row.appendChild(cell(removeButton(function () { syncFromTables(); current.services.splice(index, 1); renderServices(); })));
      ui.services.appendChild(row);
    });
  }

  function renderDomains() {
    ui.domains.textContent = "";
    if (!current.domains.length) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "empty";
      td.textContent = "尚未记录域名";
      row.appendChild(td);
      ui.domains.appendChild(row);
      return;
    }
    current.domains.forEach(function (domain, index) {
      const row = document.createElement("tr");
      row.dataset.index = String(index);
      row.appendChild(cell(input(domain.domain, "domain", "example.com")));
      row.appendChild(cell(input(domain.service, "service", "对应服务")));
      row.appendChild(cell(input(domain.source, "source", "manual/nginx/caddy")));
      row.appendChild(cell(input(domain.note, "note", "说明")));
      row.appendChild(cell(removeButton(function () { syncFromTables(); current.domains.splice(index, 1); renderDomains(); })));
      ui.domains.appendChild(row);
    });
  }

  function renderPorts() {
    ui.ports.textContent = "";
    if (!current.ports.length) {
      const row = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "empty";
      td.textContent = "尚未记录端口";
      row.appendChild(td);
      ui.ports.appendChild(row);
      return;
    }
    current.ports.forEach(function (port, index) {
      const row = document.createElement("tr");
      row.dataset.index = String(index);
      row.appendChild(cell(select(port.protocol, "protocol", [["tcp", "TCP"], ["udp", "UDP"]])));
      row.appendChild(cell(input(port.bind, "bind", "0.0.0.0")));
      row.appendChild(cell(input(port.port || "", "port", "443", "number")));
      row.appendChild(cell(select(port.scope, "scope", [["unknown", "未确认"], ["public", "公网"], ["private", "内网"], ["local", "仅本机"]])));
      row.appendChild(cell(input(port.service, "service", "对应服务")));
      row.appendChild(cell(input(port.note, "note", "说明")));
      row.appendChild(cell(removeButton(function () { syncFromTables(); current.ports.splice(index, 1); renderPorts(); })));
      ui.ports.appendChild(row);
    });
  }

  function syncRows(tbody, list) {
    Array.from(tbody.querySelectorAll("tr[data-index]")).forEach(function (row) {
      const target = list[Number(row.dataset.index)];
      if (!target) return;
      row.querySelectorAll("[data-field]").forEach(function (control) {
        target[control.dataset.field] = control.dataset.field === "port" ? Number(control.value) : control.value.trim();
      });
    });
  }

  function syncFromTables() {
    syncRows(ui.services, current.services);
    syncRows(ui.domains, current.domains);
    syncRows(ui.ports, current.ports);
    current.notes = ui.notes.value;
  }

  function renderTimestamps() {
    const parts = [];
    if (current.updated_at) parts.push("保存于 " + new Date(current.updated_at).toLocaleString());
    if (current.last_scan && current.last_scan.scanned_at) parts.push("扫描于 " + new Date(current.last_scan.scanned_at).toLocaleString());
    ui.timestamps.textContent = parts.join(" · ");
  }

  function render() {
    renderServices();
    renderDomains();
    renderPorts();
    ui.notes.value = current.notes || "";
    renderTimestamps();
    renderScan();
  }

  async function loadNodes() {
    const result = await rpc("common:getNodes", {});
    nodes = result || {};
    const list = Object.values(nodes).sort(function (a, b) { return (a.weight || 0) - (b.weight || 0) || String(a.name || "").localeCompare(String(b.name || "")); });
    ui.node.textContent = "";
    list.forEach(function (node) {
      const option = document.createElement("option");
      option.value = node.uuid;
      option.textContent = node.name || node.uuid;
      ui.node.appendChild(option);
    });
    if (!list.length) throw new Error("Komari 中没有节点");
    currentNodeId = list[0].uuid;
    ui.node.value = currentNodeId;
    await loadCurrentNode();
  }

  async function loadCurrentNode() {
    showMessage("正在加载…", false);
    const result = await rpc("plugin:inventoryGetNode", { node_id: currentNodeId });
    current = Object.assign(emptyNode(), result.data || {});
    current.services = Array.isArray(current.services) ? current.services : [];
    current.domains = Array.isArray(current.domains) ? current.domains : [];
    current.ports = Array.isArray(current.ports) ? current.ports : [];
    current.last_scan = Object.assign(emptyNode().last_scan, current.last_scan || {});
    render();
    showMessage("", false);
  }

  async function saveCurrent(successMessage) {
    syncFromTables();
    const result = await rpc("plugin:inventorySaveNode", { node_id: currentNodeId, data: current });
    current.updated_at = result.updated_at;
    renderTimestamps();
    showMessage(successMessage || "已保存", false);
  }

  function unique(list, key) {
    const seen = new Set();
    return list.filter(function (item) {
      const value = key(item);
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  function applicationService(service) {
    return service && (service.type === "docker" || service.type === "podman" || service.type === "systemd");
  }

  function extractPublishedPorts(services) {
    const ports = [];
    services.forEach(function (service) {
      const value = String(service.ports || "");
      const pattern = /(?:\[([^\]]+)\]|([0-9a-fA-F:.*]+)):(\d+)->(\d+)\/(tcp|udp)/gi;
      let match;
      while ((match = pattern.exec(value)) !== null) {
        const bind = match[1] || match[2] || "*";
        ports.push({
          id: uid("port"),
          protocol: match[5].toLowerCase(),
          bind: bind,
          port: Number(match[3]),
          scope: bind === "127.0.0.1" || bind === "::1" ? "local" : "unknown",
          service: service.name,
          source: service.type,
          note: "容器内端口 " + match[4]
        });
      }
    });
    return ports;
  }

  function connectDomainsToServices(domains, services) {
    domains.forEach(function (domain) {
      const target = String(domain.service || "");
      if (!target) return;
      try {
        const hostname = new URL(target).hostname;
        const matched = services.find(function (service) {
          return service.name === hostname || service.name.endsWith("-" + hostname);
        });
        if (matched) {
          domain.service = matched.name;
          domain.note = target;
        }
      } catch (_error) {
        // Keep non-URL targets unchanged for manual confirmation.
      }
    });
    return domains;
  }

  function compactPorts(ports) {
    return unique(ports, function (row) {
      return row.protocol + "\n" + row.port + "\n" + row.service + "\n" + row.scope;
    });
  }

  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\"'\"'") + "'";
  }

  function buildUploadCommand(ticket) {
    if (window.location.protocol !== "https:") throw new Error("为避免凭证泄露，自动上传只允许使用 HTTPS 面板");
    const scannerURL = window.location.origin + ticket.scanner_path;
    const submitURL = window.location.origin + ticket.submit_path;
    return [
      "scan_file=$(mktemp \"${TMPDIR:-/tmp}/komari-inventory.XXXXXX\") || exit 1",
      "result_file=$(mktemp \"${TMPDIR:-/tmp}/komari-inventory-result.XXXXXX\") || { rm -f \"$scan_file\"; exit 1; }",
      "cleanup_inventory_scan() { rm -f \"$scan_file\" \"$result_file\"; }",
      "trap cleanup_inventory_scan EXIT HUP INT TERM",
      "curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 10 --max-time 30 " + shellQuote(scannerURL) + " -o \"$scan_file\" || exit 1",
      "if command -v sha256sum >/dev/null 2>&1; then printf '%s  %s\\n' " + shellQuote(ticket.scanner_sha256) + " \"$scan_file\" | sha256sum -c - >/dev/null; elif command -v shasum >/dev/null 2>&1; then printf '%s  %s\\n' " + shellQuote(ticket.scanner_sha256) + " \"$scan_file\" | shasum -a 256 -c - >/dev/null; else echo '缺少 sha256sum/shasum，已拒绝执行' >&2; exit 1; fi || { echo '扫描脚本校验失败，已拒绝执行' >&2; exit 1; }",
      "if [ \"$(id -u)\" -eq 0 ]; then sh \"$scan_file\" > \"$result_file\"; elif command -v sudo >/dev/null 2>&1; then sudo sh \"$scan_file\" > \"$result_file\"; else sh \"$scan_file\" > \"$result_file\"; fi || exit 1",
      "curl --proto '=https' --tlsv1.2 -fsS --connect-timeout 10 --max-time 30 -H " + shellQuote("Authorization: Bearer " + ticket.token) + " -H 'Content-Type: text/plain' --data-binary @\"$result_file\" " + shellQuote(submitURL),
      "printf '\\n'",
      "cleanup_inventory_scan",
      "trap - EXIT HUP INT TERM"
    ].join("\n");
  }

  function stopUploadPolling() {
    if (uploadPollTimer) window.clearTimeout(uploadPollTimer);
    uploadPollTimer = 0;
  }

  async function pollUploadStatus() {
    if (!activeUpload) return;
    const expected = activeUpload;
    try {
      const result = await rpc("plugin:inventoryGetUploadStatus", { upload_id: expected.upload_id });
      if (activeUpload !== expected) return;
      if (result.status === "completed") {
        stopUploadPolling();
        ui.uploadStatus.textContent = "已收到结果，正在刷新…";
        if (result.node_id === currentNodeId) await loadCurrentNode();
        ui.uploadStatus.textContent = "结果已导入；请在下方确认需要加入台账的项目";
        showMessage("服务器扫描完成，结果已自动导入", false);
        return;
      }
      if (result.status === "failed") {
        stopUploadPolling();
        ui.uploadStatus.textContent = "导入失败：" + (result.error || "结果格式错误");
        showMessage(ui.uploadStatus.textContent, true);
        return;
      }
      if (result.status === "expired" || result.status === "revoked" || result.status === "missing") {
        stopUploadPolling();
        ui.uploadStatus.textContent = "命令已失效，请重新生成";
        return;
      }
      ui.uploadStatus.textContent = result.status === "processing" ? "正在导入结果…" : "等待服务器执行命令…";
    } catch (error) {
      ui.uploadStatus.textContent = "状态查询暂时失败，将自动重试";
    }
    uploadPollTimer = window.setTimeout(pollUploadStatus, 1500);
  }

  async function createUploadCommand() {
    ui.command.disabled = true;
    try {
      const ticket = await rpc("plugin:inventoryCreateUpload", { node_id: currentNodeId });
      activeUpload = { upload_id: ticket.upload_id, node_id: currentNodeId };
      ui.commandText.value = buildUploadCommand(ticket);
      ui.commandExpiry.textContent = "有效期至 " + new Date(ticket.expires_at).toLocaleTimeString();
      ui.uploadStatus.textContent = "等待服务器执行命令…";
      ui.commandPanel.hidden = false;
      stopUploadPolling();
      pollUploadStatus();
      showMessage("一次性命令已生成，请复制到所选服务器执行", false);
    } finally {
      ui.command.disabled = false;
    }
  }

  async function copyUploadCommand() {
    if (!ui.commandText.value) return;
    try {
      await navigator.clipboard.writeText(ui.commandText.value);
    } catch (_error) {
      ui.commandText.focus();
      ui.commandText.select();
      document.execCommand("copy");
    }
    ui.copyCommand.textContent = "已复制";
    window.setTimeout(function () { ui.copyCommand.textContent = "复制命令"; }, 1500);
  }

  function scanRow(type, index, title, secondary, detail, checked) {
    const row = document.createElement("label");
    row.className = "scan-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = checked;
    checkbox.dataset.scanType = type;
    checkbox.dataset.scanIndex = String(index);
    const name = document.createElement("strong");
    name.textContent = title;
    const source = document.createElement("small");
    source.textContent = secondary;
    const info = document.createElement("span");
    info.textContent = detail;
    row.append(checkbox, name, source, info);
    return row;
  }

  function scanGroup(title, items, type, formatter, defaultChecked) {
    const section = document.createElement("div");
    section.className = "scan-group";
    const heading = document.createElement("h3");
    heading.textContent = title + "（" + items.length + "）";
    section.appendChild(heading);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "未发现";
      section.appendChild(empty);
    } else {
      items.forEach(function (item, index) {
        const formatted = formatter(item);
        section.appendChild(scanRow(type, index, formatted[0], formatted[1], formatted[2], defaultChecked(item)));
      });
    }
    return section;
  }

  function renderScan() {
    const scan = current.last_scan || {};
    if (!scan.scanned_at) {
      ui.scanPanel.hidden = true;
      return;
    }
    ui.scanPanel.hidden = false;
    scan.services = (scan.services || []).filter(applicationService);
    scan.domains = connectDomainsToServices(scan.domains || [], scan.services);
    const serviceNames = new Set(scan.services.map(function (item) { return item.name; }));
    scan.ports = compactPorts((scan.ports || []).filter(function (item) {
      return item.source === "docker" || item.source === "podman" || (item.source === "scan" && serviceNames.has(item.service));
    }).concat(extractPublishedPorts(scan.services)));
    ui.scanSummary.textContent = (scan.hostname ? scan.hostname + " · " : "") + new Date(scan.scanned_at).toLocaleString() + "；发现 " + scan.services.length + " 个应用、" + scan.domains.length + " 个域名、" + scan.ports.length + " 个相关端口。";
    const warnings = Array.isArray(scan.warnings) ? scan.warnings : [];
    ui.scanWarnings.hidden = !warnings.length;
    ui.scanWarnings.textContent = warnings.join("\n");
    ui.scanResults.textContent = "";
    ui.scanResults.appendChild(scanGroup("应用服务", scan.services || [], "services", function (item) {
      const typeLabel = item.type === "docker" ? "Docker 应用" : item.type === "podman" ? "Podman 应用" : "系统服务";
      const detail = item.type === "systemd" ? item.note : [item.image, item.ports].filter(Boolean).join(" · ");
      return [item.name, typeLabel, detail];
    }, function () { return true; }));
    ui.scanResults.appendChild(scanGroup("域名候选", scan.domains || [], "domains", function (item) { return [item.domain, item.source, item.service || "等待人工关联服务"]; }, function () { return true; }));
    ui.scanResults.appendChild(scanGroup("相关端口", scan.ports || [], "ports", function (item) { return [String(item.port), item.protocol.toUpperCase() + " · " + (item.scope === "local" ? "仅本机" : "所有网卡"), item.service || "等待人工关联服务"]; }, function () { return true; }));
  }

  function importSelected() {
    syncFromTables();
    const scan = current.last_scan;
    Array.from(ui.scanResults.querySelectorAll("input[type=checkbox]:checked")).forEach(function (checkbox) {
      const type = checkbox.dataset.scanType;
      const item = scan[type][Number(checkbox.dataset.scanIndex)];
      if (!item) return;
      if (type === "services") {
        const exists = current.services.some(function (row) { return row.name === item.name && row.type === item.type; });
        if (!exists) current.services.push(Object.assign({}, item, { id: uid("svc") }));
      } else if (type === "domains") {
        const exists = current.domains.some(function (row) { return row.domain === item.domain; });
        if (!exists) current.domains.push(Object.assign({}, item, { id: uid("domain") }));
      } else if (type === "ports") {
        const exists = current.ports.some(function (row) { return row.protocol === item.protocol && row.bind === item.bind && Number(row.port) === Number(item.port); });
        if (!exists) current.ports.push(Object.assign({}, item, { id: uid("port") }));
      }
    });
    renderServices();
    renderDomains();
    renderPorts();
    showMessage("已导入到编辑区，请检查后点击“保存台账”", false);
  }

  document.getElementById("add-service").addEventListener("click", function () { syncFromTables(); current.services.push({ id: uid("svc"), name: "", type: "manual", state: "", image: "", ports: "", source: "manual", note: "" }); renderServices(); });
  document.getElementById("add-domain").addEventListener("click", function () { syncFromTables(); current.domains.push({ id: uid("domain"), domain: "", service: "", source: "manual", note: "" }); renderDomains(); });
  document.getElementById("add-port").addEventListener("click", function () { syncFromTables(); current.ports.push({ id: uid("port"), protocol: "tcp", bind: "0.0.0.0", port: 0, scope: "unknown", service: "", source: "manual", note: "" }); renderPorts(); });
  ui.node.addEventListener("change", async function () {
    try {
      syncFromTables();
      stopUploadPolling();
      activeUpload = null;
      ui.commandPanel.hidden = true;
      ui.commandText.value = "";
      currentNodeId = ui.node.value;
      await loadCurrentNode();
    } catch (error) {
      showMessage(error.message, true);
    }
  });
  ui.save.addEventListener("click", async function () { ui.save.disabled = true; try { await saveCurrent("台账已保存"); } catch (error) { showMessage(error.message, true); } finally { ui.save.disabled = false; } });
  ui.command.addEventListener("click", async function () { try { await createUploadCommand(); } catch (error) { showMessage(error.message, true); } });
  ui.copyCommand.addEventListener("click", copyUploadCommand);
  ui.importSelected.addEventListener("click", importSelected);

  loadNodes().catch(function (error) { showMessage("加载失败：" + error.message, true); });
})();
