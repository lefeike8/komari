const server = require("server");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Buffer } = require("buffer");

const DATA_FILE = path.join(__storageDir__, "inventory.json");
const DATA_TMP = path.join(__storageDir__, "inventory.json.tmp");
const SCANNER_FILE = path.join(__dirname, "pages", "scanner.sh");
const SCANNER_SOURCE = fs.readFileSync(SCANNER_FILE, "utf8");
const SCANNER_SHA256 = crypto.createHash("sha256").update(SCANNER_SOURCE).digest("hex");
const MAX_ITEMS = 1000;
const UPLOAD_TTL_MS = 5 * 60 * 1000;
const UPLOAD_HISTORY_MS = 30 * 60 * 1000;
const MAX_UPLOADS = 100;
const MAX_SCAN_LINES = 5000;
const uploads = new Map();
const uploadTokens = new Map();
const requestRates = new Map();
let globalRate = { started_at: 0, count: 0 };

function text(value, max) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, max);
}

function id(value) {
  return text(value, 128).replace(/[^a-zA-Z0-9._:-]/g, "");
}

function itemId(value) {
  const cleaned = id(value);
  return cleaned || ("item-" + crypto.randomBytes(12).toString("hex"));
}

function jsonResponse(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(value));
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function cleanupUploads(now) {
  for (const [uploadId, upload] of uploads) {
    if (upload.status === "pending" && upload.expires_at_ms <= now) {
      upload.status = "expired";
      uploadTokens.delete(upload.token_hash);
    }
    if (upload.created_at_ms + UPLOAD_HISTORY_MS <= now) uploads.delete(uploadId);
  }
  if (uploads.size <= MAX_UPLOADS) return;
  const ordered = Array.from(uploads.values()).sort((a, b) => a.created_at_ms - b.created_at_ms);
  ordered.slice(0, uploads.size - MAX_UPLOADS).forEach((upload) => {
    uploads.delete(upload.id);
    uploadTokens.delete(upload.token_hash);
  });
}

function allowUploadRequest(remoteIP, now) {
  if (globalRate.started_at <= now - 60 * 1000) globalRate = { started_at: now, count: 0 };
  globalRate.count += 1;
  if (globalRate.count > 300) return false;

  const key = text(remoteIP, 128) || "unknown";
  const since = now - 60 * 1000;
  for (const [address, rate] of requestRates) {
    if (rate.started_at <= since) requestRates.delete(address);
  }
  let rate = requestRates.get(key);
  if (!rate) {
    if (requestRates.size >= 1000) return false;
    rate = { started_at: now, count: 0 };
    requestRates.set(key, rate);
  }
  rate.count += 1;
  return rate.count <= 20;
}

function decodeField(value) {
  try {
    return Buffer.from(String(value || ""), "base64").toString("utf8");
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

function parseScanOutput(output) {
  const lines = String(output || "").replace(/\r/g, "").split("\n");
  if (lines.length > MAX_SCAN_LINES) throw new Error("扫描结果行数超过限制");
  const start = lines.indexOf("KOMARI_INVENTORY_V1");
  const end = lines.indexOf("KOMARI_INVENTORY_END");
  if (start < 0 || end <= start) throw new Error("扫描结果格式不完整");

  const scan = { scanned_at: new Date().toISOString(), hostname: "", services: [], domains: [], ports: [], warnings: [] };
  lines.slice(start + 1, end).forEach((line) => {
    if (!line) return;
    const parts = line.split("\t");
    const kind = parts.shift();
    const fields = parts.map(decodeField);
    if (kind === "META") {
      scan.hostname = fields[0] || "";
      scan.scanned_at = fields[1] || scan.scanned_at;
    } else if (kind === "SERVICE") {
      scan.services.push(cleanService({ type: fields[0], name: fields[1], state: fields[2], note: fields[3], image: fields[4], ports: fields[5], source: fields[6] || "scan" }));
    } else if (kind === "PORT") {
      const address = splitAddress(fields[1]);
      if (address.port) scan.ports.push(cleanPort({ protocol: String(fields[0] || "tcp").replace(/[0-9]/g, "").toLowerCase(), bind: address.bind, port: address.port, scope: address.bind === "127.0.0.1" || address.bind === "::1" ? "local" : "unknown", service: fields[2] || "", source: "scan" }));
    } else if (kind === "DOMAIN") {
      scan.domains.push(cleanDomain({ domain: fields[1], service: fields[2], source: fields[0] || "scan" }));
    } else if (kind === "WARNING") {
      scan.warnings.push(text(fields[0] || "未知扫描警告", 1000));
    }
  });

  return cleanScan(scan);
}

function bearerToken(req) {
  const header = req && req.headers ? req.headers.authorization : "";
  const match = /^Bearer\s+([A-Za-z0-9_-]{40,100})$/.exec(String(header || ""));
  return match ? match[1] : "";
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
  server.route("GET", "/api/plugin/inventory/v1/scanner", (_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/x-shellscript; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(SCANNER_SOURCE);
  });

  server.route("POST", "/api/plugin/inventory/v1/submit", (req, res) => {
    const now = Date.now();
    cleanupUploads(now);
    if (!allowUploadRequest(req.context && req.context.remote_ip, now)) {
      jsonResponse(res, 429, { ok: false, error: "请求过于频繁，请稍后重试" });
      return;
    }

    const token = bearerToken(req);
    const hash = token ? tokenHash(token) : "";
    const uploadId = hash ? uploadTokens.get(hash) : "";
    const upload = uploadId ? uploads.get(uploadId) : null;
    if (!upload || upload.status !== "pending" || upload.expires_at_ms <= now) {
      if (upload && upload.status === "pending") upload.status = "expired";
      if (hash) uploadTokens.delete(hash);
      jsonResponse(res, 401, { ok: false, error: "上传凭证无效或已过期" });
      return;
    }

    // Consume before parsing. A malformed or replayed upload must require a
    // fresh command instead of keeping a credential reusable.
    uploadTokens.delete(hash);
    upload.status = "processing";
    try {
      const scan = parseScanOutput(req.body);
      const store = readStore();
      const node = cleanNode(store.nodes[upload.node_id] || {});
      node.last_scan = scan;
      node.updated_at = new Date(now).toISOString();
      store.nodes[upload.node_id] = node;
      writeStore(store);
      upload.status = "completed";
      upload.received_at = node.updated_at;
      jsonResponse(res, 200, { ok: true, message: "扫描结果已安全导入面板" });
    } catch (error) {
      upload.status = "failed";
      upload.error = text(error && error.message ? error.message : error, 300);
      jsonResponse(res, 400, { ok: false, error: upload.error });
    }
  });

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

  server.registerRPC("plugin:inventoryCreateUpload", (params) => {
    const nodeId = id(params && params.node_id);
    if (!nodeId) throw new Error("node_id is required");
    const now = Date.now();
    cleanupUploads(now);

    // Keep only one live credential per node. Generating a new command
    // immediately revokes an older command that was never used.
    for (const upload of uploads.values()) {
      if (upload.node_id === nodeId && upload.status === "pending") {
        upload.status = "revoked";
        uploadTokens.delete(upload.token_hash);
      }
    }

    const token = crypto.randomBytes(32).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const hash = tokenHash(token);
    const uploadId = crypto.randomUUID();
    const upload = {
      id: uploadId,
      node_id: nodeId,
      token_hash: hash,
      status: "pending",
      created_at_ms: now,
      expires_at_ms: now + UPLOAD_TTL_MS,
      received_at: "",
      error: ""
    };
    uploads.set(uploadId, upload);
    uploadTokens.set(hash, uploadId);
    return {
      upload_id: uploadId,
      token,
      expires_at: new Date(upload.expires_at_ms).toISOString(),
      scanner_sha256: SCANNER_SHA256,
      scanner_path: "/api/plugin/inventory/v1/scanner",
      submit_path: "/api/plugin/inventory/v1/submit"
    };
  });

  server.registerRPC("plugin:inventoryGetUploadStatus", (params) => {
    const uploadId = id(params && params.upload_id);
    if (!uploadId) throw new Error("upload_id is required");
    cleanupUploads(Date.now());
    const upload = uploads.get(uploadId);
    if (!upload) return { status: "missing" };
    return {
      status: upload.status,
      node_id: upload.node_id,
      expires_at: new Date(upload.expires_at_ms).toISOString(),
      received_at: upload.received_at,
      error: upload.error
    };
  });
}

function unload() {}
