#!/usr/bin/env node
//
// zai-claude-proxy — Minimal proxy that maps Claude model names → Z.AI GLM models.
//
// Z.AI already provides an Anthropic-compatible endpoint at
//   https://api.z.ai/api/anthropic
// so the proxy only needs to:
//   1. Replace the model name in the request body  (claude-* → GLM-*)
//   2. Replace the model name in the response      (GLM-* → claude-*)
//   3. Forward everything else transparently
//
// Usage:
//   node proxy.mjs
//   ZAI_PROXY_PORT=3333 node proxy.mjs
//
// Configure Claude Code (~/.claude/settings.json):
//   {
//     "env": {
//       "ANTHROPIC_BASE_URL": "http://localhost:3333",
//       "ANTHROPIC_AUTH_TOKEN": "your_zai_api_key"
//     }
//   }

import http from "node:http";
import https from "node:https";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.ZAI_PROXY_PORT || 3333;
const ZAI_BASE = (
  process.env.ZAI_API_URL || "https://api.z.ai/api/anthropic"
).replace(/\/$/, "");

/**
 * Claude model → Z.AI GLM model mapping.
 *
 * Edit this table to add / change mappings.
 * Unmapped model names are passed through as-is.
 */
const MODEL_MAP = {
  // Opus tier
  "claude-opus-4-8": "GLM-5.1",
  "claude-opus-4-7": "GLM-5.1",
  "claude-opus-4-6": "GLM-5.1",
  "claude-opus-4-5-20251101": "GLM-5.1",

  // Sonnet tier
  "claude-sonnet-4-7": "GLM-5-turbo",
  "claude-sonnet-4-6": "GLM-5v-turbo",
  "claude-sonnet-4-5-20250929": "GLM-4.7",

  // Haiku tier
  "claude-haiku-4-5-20251001": "GLM-4.5-Air",
};

function resolveModel(name) {
  return MODEL_MAP[name] || name;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for use inside a RegExp literal. */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return a RegExp that matches `"model":"<mapped>"` in JSON strings. */
function modelRegex(mapped) {
  return new RegExp(`("model"\\s*:\\s*")${reEscape(mapped)}(")`, "g");
}

/** Read the entire request body as a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Proxy core
// ---------------------------------------------------------------------------

/**
 * Forward an Anthropic Messages API request to Z.AI with model name
 * replacement, then rewrite the model name in the response.
 */
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
  const mapped = resolveModel(origModel);
  parsed.model = mapped;

  const payload = JSON.stringify(parsed);
  const target = ZAI_BASE + path;

  // Forward all client headers (includes x-api-key / Authorization with the
  // Z.AI API key that Claude Code sends).  Only rewrite host & length.
  const fwd = { ...reqHeaders };
  delete fwd.host;
  fwd["content-length"] = Buffer.byteLength(payload);

  console.log(
    `[PROXY] ${origModel} → ${mapped}  |  stream=${parsed.stream !== false}  |  messages=${parsed.messages?.length || 0}`,
  );

  const upstream = https.request(
    target,
    { method: "POST", headers: fwd },
    (upRes) => {
      // --- Error responses: pass through as-is ---
      if (upRes.statusCode >= 400) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }

      const isStream = parsed.stream !== false;

      if (!isStream) {
        // --- Non-streaming: buffer, replace model, return ---
        let buf = "";
        upRes.on("data", (c) => (buf += c));
        upRes.on("end", () => {
          try {
            const r = JSON.parse(buf);
            if (r.model) r.model = origModel;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(r));
          } catch {
            // If we can't parse, just pass through
            res.writeHead(200, upRes.headers);
            res.end(buf);
          }
        });
        return;
      }

      // --- Streaming: pass SSE through, replacing model names ---
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // If model wasn't actually mapped, just pipe through
      if (mapped === origModel) {
        upRes.pipe(res);
        return;
      }

      // Otherwise, scan SSE lines and replace "model":"<mapped>" → original
      const re = modelRegex(mapped);
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
    console.error(`[ERROR] ${e.message}`);
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
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const path = req.url.split("?")[0];

  // Health check
  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", upstream: ZAI_BASE }));
    return;
  }

  // Model list — return Claude names so the client is happy
  if (req.method === "GET" && path === "/v1/models") {
    const data = Object.keys(MODEL_MAP).map((id) => ({
      id,
      display_name: id,
      created_at: new Date().toISOString(),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data,
        first_id: data[0]?.id,
        has_more: false,
      }),
    );
    return;
  }

  // Messages API — the main proxy endpoint
  if (req.method === "POST" && path === "/v1/messages") {
    const body = await readBody(req);
    proxyMessages(body, req.headers, path, res);
    return;
  }

  // Anything else → 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n  Z.AI Claude Proxy v0.1.0`);
  console.log(`  Listening: http://localhost:${PORT}`);
  console.log(`  Upstream:  ${ZAI_BASE}`);
  console.log(`\n  Model mapping:`);
  for (const [k, v] of Object.entries(MODEL_MAP)) {
    console.log(`    ${k.padEnd(32)} → ${v}`);
  }
  console.log(`\n  Claude Code ~/.claude/settings.json:`);
  console.log(`    {`);
  console.log(`      "env": {`);
  console.log(`        "ANTHROPIC_BASE_URL": "http://localhost:3333",`);
  console.log(`        "ANTHROPIC_AUTH_TOKEN": "<your Z.AI API key>"`);
  console.log(`      }`);
  console.log(`    }\n`);
});
