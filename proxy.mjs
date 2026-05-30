#!/usr/bin/env node
//
// zai-claude-proxy — Multi-backend proxy for Claude Desktop / Claude Code.
//
// Routes model requests to the correct backend:
//   • Z.AI models (claude-zhipu-*, claude-sonnet-*, claude-haiku-*) → api.z.ai
//   • CC models   (claude-xiaomi-*, claude-opus-4-7)               → CC Proxy (:3334)
//
// Usage:
//   node proxy.mjs
//   ZAI_PROXY_PORT=3333 node proxy.mjs
//
// Claude Desktop config:
//   inferenceGatewayBaseUrl:  http://localhost:3333/anthropic/
//   inferenceGatewayApiKey:   <Z.AI API key>
//
// Claude Code ~/.claude/settings.json:
//   { "env": {
//       "ANTHROPIC_BASE_URL": "http://localhost:3333",
//       "ANTHROPIC_AUTH_TOKEN": "<Z.AI API key>"
//   } }

import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.ZAI_PROXY_PORT || 3333;
const ZAI_BASE = (
  process.env.ZAI_API_URL || "https://api.z.ai/api/anthropic"
).replace(/\/$/, "");
const CC_PROXY = (
  process.env.CC_PROXY_URL || "http://localhost:3334/anthropic"
).replace(/\/$/, "");

/**
 * Model routing table.
 * Each entry: { backend: "zai" | "cc", target: "<upstream model>" }
 *
 * "zai" → Z.AI Anthropic endpoint  (model name replaced in both directions)
 * "cc"  → CC Proxy (:3334)         (forwarded as-is; CC Proxy handles mapping)
 */
const MODEL_ROUTES = {
  // --- Z.AI GLM models ---
  "claude-opus-4-8":          { backend: "zai", target: "GLM-5.1" },
  "claude-opus-4-5-20251101": { backend: "zai", target: "GLM-5.1" },
  "claude-sonnet-4-7":        { backend: "zai", target: "GLM-5-turbo" },
  "claude-sonnet-4-6":        { backend: "zai", target: "GLM-5v-turbo" },
  "claude-sonnet-4-5-20250929": { backend: "zai", target: "GLM-4.7" },
  "claude-haiku-4-5-20251001":  { backend: "zai", target: "GLM-4.6v" },

  // --- Z.AI GLM models (Claude Desktop custom names) ---
  "claude-zhipu-5":  { backend: "zai", target: "GLM-5" },
  "claude-zhipu-51": { backend: "zai", target: "GLM-5.1" },

  // --- CC Proxy models (xiaomi, deepseek, etc.) ---
  "claude-opus-4-7":       { backend: "cc", target: "claude-opus-4-7" },
  "claude-opus-4-6":       { backend: "cc", target: "claude-opus-4-6" },
  "claude-xiaomi-v25-pro": { backend: "cc", target: "claude-xiaomi-v25-pro" },
  "claude-xiaomi-v25":     { backend: "cc", target: "claude-xiaomi-v25" },
};

function route(model) {
  return MODEL_ROUTES[model] || { backend: "zai", target: model };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function modelRegex(mapped) {
  return new RegExp(
    `("model"\\s*:\\s*")${reEscape(mapped)}(")`,
    "g",
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Normalize path: accept both /anthropic/v1/... and /v1/... */
function normalizePath(raw) {
  return raw.replace(/^\/anthropic/, "") || raw;
}

// ---------------------------------------------------------------------------
// Forward to CC Proxy (HTTP passthrough)
// ---------------------------------------------------------------------------

function forwardCC(payload, headers, path, res) {
  const target = CC_PROXY + path;

  const req = http.request(
    target,
    { method: "POST", headers },
    (upRes) => {
      // CC Proxy returns Anthropic-format responses — just pipe through
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    },
  );

  req.on("error", (e) => {
    console.error(`[CC ERROR] ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "api_error",
            message: `CC Proxy (${CC_PROXY}) unreachable: ${e.message}`,
          },
        }),
      );
    }
  });

  req.write(payload);
  req.end();
}

// ---------------------------------------------------------------------------
// Forward to Z.AI (HTTPS with model-name replacement)
// ---------------------------------------------------------------------------

function forwardZAI(payload, headers, rawPath, res, origModel, target, isStream) {
  // Strip /anthropic prefix — ZAI_BASE already includes /api/anthropic
  const zaiPath = normalizePath(rawPath);
  const url = ZAI_BASE + zaiPath;

  const upstream = https.request(
    url,
    { method: "POST", headers },
    (upRes) => {
      // Error: pass through
      if (upRes.statusCode >= 400) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }

      if (!isStream) {
        // Non-streaming: buffer, replace model, return
        let buf = "";
        upRes.on("data", (c) => (buf += c));
        upRes.on("end", () => {
          try {
            const r = JSON.parse(buf);
            if (r.model) r.model = origModel;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(r));
          } catch {
            res.writeHead(200, upRes.headers);
            res.end(buf);
          }
        });
        return;
      }

      // Streaming: replace model name in SSE
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      if (target === origModel) {
        upRes.pipe(res);
        return;
      }

      const re = modelRegex(target);
      let leftover = "";

      upRes.on("data", (chunk) => {
        leftover += chunk.toString();
        const lines = leftover.split("\n");
        leftover = lines.pop() || "";
        for (const line of lines) {
          res.write(line.replace(re, `$1${origModel}$2`) + "\n");
        }
      });

      upRes.on("end", () => {
        if (leftover) {
          res.write(leftover.replace(re, `$1${origModel}$2`));
        }
        res.end();
      });
    },
  );

  upstream.on("error", (e) => {
    console.error(`[ZAI ERROR] ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: e.message },
        }),
      );
    }
  });

  upstream.write(payload);
  upstream.end();
}

// ---------------------------------------------------------------------------
// Proxy core
// ---------------------------------------------------------------------------

function proxyMessages(rawBody, reqHeaders, path, res) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: e.message },
      }),
    );
    return;
  }

  const origModel = parsed.model || "claude-sonnet-4-6";
  const { backend, target } = route(origModel);
  parsed.model = target;

  const payload = JSON.stringify(parsed);
  const fwd = { ...reqHeaders };
  delete fwd.host;
  fwd["content-length"] = Buffer.byteLength(payload);

  const isStream = parsed.stream !== false;
  console.log(
    `[PROXY] ${origModel} → ${target}  |  ${backend.toUpperCase()}  |  stream=${isStream}  |  messages=${parsed.messages?.length || 0}`,
  );

  if (backend === "cc") {
    forwardCC(payload, fwd, path, res);
  } else {
    forwardZAI(payload, fwd, path, res, origModel, target, isStream);
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const MESSAGE_PATHS = new Set(["/v1/messages", "/anthropic/v1/messages"]);
const MODEL_PATHS = new Set(["/v1/models", "/anthropic/v1/models"]);

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url.split("?")[0];

  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", zai: ZAI_BASE, cc: CC_PROXY }));
    return;
  }

  if (req.method === "GET" && MODEL_PATHS.has(path)) {
    const data = Object.keys(MODEL_ROUTES).map((id) => ({
      id,
      display_name: id,
      created_at: new Date().toISOString(),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ object: "list", data, first_id: data[0]?.id, has_more: false }),
    );
    return;
  }

  if (req.method === "POST" && MESSAGE_PATHS.has(path)) {
    const body = await readBody(req);
    proxyMessages(body, req.headers, path, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n  Z.AI Claude Proxy v0.2.0`);
  console.log(`  Listening: http://localhost:${PORT}`);
  console.log(`  Z.AI:      ${ZAI_BASE}`);
  console.log(`  CC Proxy:  ${CC_PROXY}`);
  console.log(`\n  Model routing:`);
  for (const [k, v] of Object.entries(MODEL_ROUTES)) {
    const tag = v.backend === "cc" ? "CC " : "ZAI";
    console.log(`    ${k.padEnd(32)} → ${v.target.padEnd(20)} [${tag}]`);
  }
  console.log(`\n  Claude Desktop:`);
  console.log(`    inferenceGatewayBaseUrl: http://localhost:${PORT}/anthropic/`);
  console.log(`    inferenceGatewayApiKey:  <Z.AI API key>`);
  console.log(`\n  Claude Code ~/.claude/settings.json:`);
  console.log(`    { "env": {`);
  console.log(`        "ANTHROPIC_BASE_URL": "http://localhost:${PORT}",`);
  console.log(`        "ANTHROPIC_AUTH_TOKEN": "<Z.AI API key>"`);
  console.log(`    } }\n`);
});
