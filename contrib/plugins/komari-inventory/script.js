const server = require("server");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__storageDir__, "inventory.json");
const DATA_TMP = path.join(__storageDir__, "inventory.json.tmp");
const MAX_ITEMS = 1000;

function text(value, max) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

function id(value) {
  return text(value, 128).replace(/[^a-zA-Z0-9._:-]/g, "");
}

function itemId(value) {
  const cleaned = id(value);
  return cleaned || ("item-" + Date.now() + "-" + Math.random().toString(16).slice(2));
}

function cleanService(value) {
  const row = value && typeof value === "object" ? value : {};
  return {
    id: itemId(row.id),
    name: text(row.name, 160),
    type: text(row.type, 60),
    state: text(row.state, 60),
    image: text(row.image, 300),
    ports: text(row.ports, 300),
    source: text(row.source, 40),
    note: text(row.note, 1000)
  };
}

function cleanDomain(value) {
  const row = value && typeof value === "object" ? value : {};
  return {
    id: itemId(row.id),
    domain: text(row.domain, 253).toLowerCase(),
    service: text(row.service, 160),
    source: text(row.source, 40),
    note: text(row.note, 1000)
  };
}

function cleanPort(value) {
  const row = value && typeof value === "object" ? value : {};
  const port = Number(row.port);
  return {
    id: itemId(row.id),
    protocol: ["tcp", "udp"].indexOf(String(row.protocol).toLowerCase()) >= 0 ? String(row.protocol).toLowerCase() : "tcp",
    bind: text(row.bind, 160),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0,
    scope: ["public", "private", "local", "unknown"].indexOf(String(row.scope)) >= 0 ? String(row.scope) : "unknown",
    service: text(row.service, 160),
    source: text(row.source, 40),
    note: text(row.note, 1000)
  };
}

function cleanScan(value) {
  const scan = value && typeof value === "object" ? value : {};
  return {
    scanned_at: text(scan.scanned_at, 64),
    hostname: text(scan.hostname, 253),
    services: Array.isArray(scan.services) ? scan.services.slice(0, MAX_ITEMS).map(cleanService) : [],
    domains: Array.isArray(scan.domains) ? scan.domains.slice(0, MAX_ITEMS).map(cleanDomain) : [],
    ports: Array.isArray(scan.ports) ? scan.ports.slice(0, MAX_ITEMS).map(cleanPort) : [],
    warnings: Array.isArray(scan.warnings) ? scan.warnings.slice(0, 100).map((v) => text(v, 1000)) : []
  };
}

function cleanNode(value) {
  const node = value && typeof value === "object" ? value : {};
  return {
    notes: text(node.notes, 5000),
    services: Array.isArray(node.services) ? node.services.slice(0, MAX_ITEMS).map(cleanService) : [],
    domains: Array.isArray(node.domains) ? node.domains.slice(0, MAX_ITEMS).map(cleanDomain) : [],
    ports: Array.isArray(node.ports) ? node.ports.slice(0, MAX_ITEMS).map(cleanPort) : [],
    last_scan: cleanScan(node.last_scan),
    updated_at: text(node.updated_at, 64)
  };
}

function emptyStore() {
  return { version: 1, nodes: {} };
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.nodes || typeof parsed.nodes !== "object") {
      return emptyStore();
    }
    return { version: 1, nodes: parsed.nodes };
  } catch (_error) {
    return emptyStore();
  }
}

function writeStore(store) {
  fs.mkdirSync(__storageDir__, { recursive: true });
  fs.writeFileSync(DATA_TMP, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(DATA_TMP, DATA_FILE);
}

function load() {
  server.registerRPC("plugin:inventoryGetNode", (params) => {
    const nodeId = id(params && params.node_id);
    if (!nodeId) throw new Error("node_id is required");
    const store = readStore();
    return { node_id: nodeId, data: cleanNode(store.nodes[nodeId] || {}) };
  });

  server.registerRPC("plugin:inventorySaveNode", (params) => {
    const nodeId = id(params && params.node_id);
    if (!nodeId) throw new Error("node_id is required");
    const store = readStore();
    store.nodes[nodeId] = cleanNode(params && params.data);
    store.nodes[nodeId].updated_at = new Date().toISOString();
    writeStore(store);
    return { ok: true, node_id: nodeId, updated_at: store.nodes[nodeId].updated_at };
  });
}

function unload() {}
