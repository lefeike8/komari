(function () {
  "use strict";

  const ui = {
    node: document.getElementById("node-select"),
    message: document.getElementById("message"),
    save: document.getElementById("save-button"),
    scan: document.getElementById("scan-button"),
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
  let scannerCommand = "";

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

  function decode(value) {
    try {
      const bytes = Uint8Array.from(atob(value || ""), function (char) { return char.charCodeAt(0); });
      return new TextDecoder().decode(bytes);
    } catch (_error) {
      return "";
    }
  }

  function splitAddress(value) {
    const source = String(value || "");
    if (source[0] === "[") {
      const close = source.lastIndexOf("]:");
      if (close >= 0) return { bind: source.slice(1, close), port: Number(source.slice(close + 2)) || 0 };
    }
    const index = source.lastIndexOf(":");
    if (index >= 0) return { bind: source.slice(0, index) || "*", port: Number(source.slice(index + 1)) || 0 };
    return { bind: source, port: 0 };
  }

  function parseScan(output) {
    const lines = String(output || "").replace(/\r/g, "").split("\n");
    const start = lines.indexOf("KOMARI_INVENTORY_V1");
    const end = lines.indexOf("KOMARI_INVENTORY_END");
    if (start < 0 || end <= start) throw new Error("扫描输出不完整，目标 Agent 可能禁用了远程控制或缺少 base64 命令");
    const scan = { scanned_at: new Date().toISOString(), hostname: "", services: [], domains: [], ports: [], warnings: [] };
    lines.slice(start + 1, end).forEach(function (line) {
      const parts = line.split("\t");
      const kind = parts.shift();
      const fields = parts.map(decode);
      if (kind === "META") {
        scan.hostname = fields[0] || "";
        scan.scanned_at = fields[1] || scan.scanned_at;
      } else if (kind === "SERVICE") {
        scan.services.push({ id: uid("svc"), type: fields[0], name: fields[1], state: fields[2], note: fields[3], image: fields[4], ports: fields[5], source: fields[6] || "scan" });
      } else if (kind === "PORT") {
        const address = splitAddress(fields[1]);
        if (address.port) scan.ports.push({ id: uid("port"), protocol: String(fields[0] || "tcp").replace(/[0-9]/g, "").toLowerCase(), bind: address.bind, port: address.port, scope: address.bind === "127.0.0.1" || address.bind === "::1" ? "local" : "unknown", service: fields[2] || "", source: "scan", note: "" });
      } else if (kind === "DOMAIN") {
        scan.domains.push({ id: uid("domain"), domain: fields[1] || "", service: fields[2] || "", source: fields[0] || "scan", note: "" });
      } else if (kind === "WARNING") {
        scan.warnings.push(fields[0] || "未知扫描警告");
      }
    });
    scan.services = unique(scan.services.filter(applicationService), function (row) { return row.type + "\n" + row.name; });
    scan.domains = connectDomainsToServices(unique(scan.domains.filter(function (row) { return row.domain && row.domain !== "localhost"; }), function (row) { return row.domain; }), scan.services);
    scan.ports = scan.ports.concat(extractPublishedPorts(scan.services));
    scan.ports = compactPorts(scan.ports);
    return scan;
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

  async function startExec(twoFactorCode) {
    const params = { command: scannerCommand, clients: [currentNodeId] };
    if (twoFactorCode) params.two_factor_code = twoFactorCode;
    return rpc("admin:exec", params);
  }

  async function waitForTask(taskId) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      try {
        const result = await rpc("admin:getSpecificTaskResult", { task_id: taskId, uuid: currentNodeId });
        if (result && result.exit_code !== null && result.exit_code !== undefined) return result;
      } catch (error) {
        if (error.code !== -32004 && error.code !== -32602) throw error;
      }
      await new Promise(function (resolve) { setTimeout(resolve, 1200); });
    }
    throw new Error("扫描任务等待超时（任务 " + taskId + "）；该节点上的某个探测命令可能没有正常退出");
  }

  async function scan() {
    if (!scannerCommand) scannerCommand = await fetch("./scanner.sh?v=0.2.6", { credentials: "same-origin" }).then(function (response) { if (!response.ok) throw new Error("无法读取扫描脚本"); return response.text(); });
    syncFromTables();
    ui.scan.disabled = true;
    ui.node.disabled = true;
    showMessage("正在请求节点执行一次性扫描…", false);
    try {
      let started;
      try {
        started = await startExec("");
      } catch (error) {
        if (/2fa|two.?factor|verification|动态|验证码/i.test(String(error.message))) {
          const code = window.prompt("该操作需要 Komari 二次验证，请输入当前 2FA 验证码：");
          if (!code) throw new Error("已取消扫描");
          started = await startExec(code.trim());
        } else {
          throw error;
        }
      }
      showMessage("扫描任务已下发，正在等待节点返回…", false);
      const task = await waitForTask(started.task_id);
      if (Number(task.exit_code) !== 0) {
        const result = String(task.result || "exit " + task.exit_code);
        if (/Remote control is disabled/i.test(result)) {
          throw new Error("节点已关闭 Komari Agent 远程控制，无法扫描；请临时启用远程控制后重试，扫描完成即可关闭。");
        }
        throw new Error("节点扫描失败：" + result);
      }
      current.last_scan = parseScan(task.result);
      await saveCurrent("扫描完成，结果已保存；请勾选需要加入台账的项目");
      renderScan();
    } finally {
      ui.scan.disabled = false;
      ui.node.disabled = false;
    }
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
  ui.node.addEventListener("change", async function () { try { syncFromTables(); currentNodeId = ui.node.value; await loadCurrentNode(); } catch (error) { showMessage(error.message, true); } });
  ui.save.addEventListener("click", async function () { ui.save.disabled = true; try { await saveCurrent("台账已保存"); } catch (error) { showMessage(error.message, true); } finally { ui.save.disabled = false; } });
  ui.scan.addEventListener("click", async function () { try { await scan(); } catch (error) { showMessage(error.message, true); } });
  ui.importSelected.addEventListener("click", importSelected);

  loadNodes().catch(function (error) { showMessage("加载失败：" + error.message, true); });
})();
