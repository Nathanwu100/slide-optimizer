import { timingSafeEqual } from "node:crypto";

const MAX_REQUESTS_PER_WINDOW = 30;
const WINDOW_MS = 60_000;
const EVENT_TTL_SECONDS = 60 * 60 * 24 * 30;
const buckets = new Map();

function redisConfig() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "",
  };
}

function setSecurityHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function allowOrigin(request) {
  const configured = process.env.ALLOWED_ORIGIN;
  const requestOrigin = request.headers.origin;
  if (configured) return requestOrigin === configured;
  if (!requestOrigin) return true;
  const directProtocol = request.socket?.encrypted ? "https" : "http";
  const protocol = String(request.headers["x-forwarded-proto"] || directProtocol).split(",")[0].trim();
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "").split(",")[0].trim();
  return Boolean(host) && requestOrigin === `${protocol}://${host}`;
}

function rateLimited(request) {
  const now = Date.now();
  const key = String(request.headers["x-forwarded-for"] || request.socket?.remoteAddress || "unknown").split(",")[0];
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    buckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS_PER_WINDOW;
}

function safeIdentifier(value) {
  const text = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9_-]{16,128}$/.test(text) ? text : "";
}

function boundedInteger(value, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function parseConversion(input) {
  const eventId = safeIdentifier(input?.eventId);
  const anonymousId = safeIdentifier(input?.anonymousId);
  const slidesProcessed = boundedInteger(input?.slidesProcessed, 1, 200);
  const slidesChanged = boundedInteger(input?.slidesChanged, 1, 200);
  const changesApplied = boundedInteger(input?.changesApplied, 1, 2000);
  if (!eventId || !anonymousId || slidesProcessed === null || slidesChanged === null || changesApplied === null) return null;
  if (slidesChanged > slidesProcessed) return null;
  return { eventId, anonymousId, slidesProcessed, slidesChanged, changesApplied };
}

async function redisCommand(config, command) {
  const response = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error("Usage storage is unavailable.");
  return payload.result;
}

async function redisPipeline(config, commands) {
  const response = await fetch(`${config.url.replace(/\/$/, "")}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(payload) || payload.some((item) => item?.error)) {
    throw new Error("Usage storage is unavailable.");
  }
  return payload.map((item) => item?.result);
}

function authorized(request) {
  const expected = process.env.USAGE_ADMIN_TOKEN || "";
  const actual = String(request.headers["x-usage-admin-token"] || "");
  if (!expected || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function numeric(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

async function recordConversion(request, response, config) {
  if (!allowOrigin(request)) return response.status(403).json({ error: "Origin not allowed." });
  if (request.headers["x-lucid-request"] !== "usage-v1") {
    return response.status(400).json({ error: "Missing usage request marker." });
  }
  if (rateLimited(request)) return response.status(429).json({ error: "Too many usage requests." });
  if (typeof request.body === "string" && Buffer.byteLength(request.body) > 5_000) {
    return response.status(413).json({ error: "Usage event is too large." });
  }
  let body;
  try {
    body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  } catch {
    return response.status(400).json({ error: "Invalid conversion event." });
  }
  const conversion = parseConversion(body);
  if (!conversion) return response.status(400).json({ error: "Invalid conversion event." });
  if (!config.url || !config.token) return response.status(202).json({ recorded: false, reason: "not-configured" });

  const claimed = await redisCommand(config, [
    "SET",
    `lucid:usage:event:${conversion.eventId}`,
    "1",
    "NX",
    "EX",
    String(EVENT_TTL_SECONDS),
  ]);
  if (claimed !== "OK") return response.status(200).json({ recorded: false, duplicate: true });

  const day = new Date().toISOString().slice(0, 10);
  try {
    await redisPipeline(config, [
      ["INCR", "lucid:usage:presentations"],
      ["INCRBY", "lucid:usage:slides_processed", conversion.slidesProcessed],
      ["INCRBY", "lucid:usage:slides_changed", conversion.slidesChanged],
      ["INCRBY", "lucid:usage:changes_applied", conversion.changesApplied],
      ["PFADD", "lucid:usage:unique_devices", conversion.anonymousId],
      ["INCR", `lucid:usage:day:${day}:presentations`],
      ["INCRBY", `lucid:usage:day:${day}:slides_processed`, conversion.slidesProcessed],
      ["INCRBY", `lucid:usage:day:${day}:slides_changed`, conversion.slidesChanged],
      ["SET", "lucid:usage:last_conversion_at", new Date().toISOString()],
    ]);
  } catch (error) {
    await redisCommand(config, ["DEL", `lucid:usage:event:${conversion.eventId}`]).catch(() => {});
    throw error;
  }
  return response.status(200).json({ recorded: true });
}

async function usageSummary(request, response, config) {
  if (!authorized(request)) return response.status(401).json({ error: "Invalid dashboard token." });
  if (!config.url || !config.token) return response.status(503).json({ error: "Usage storage is not configured." });
  const day = new Date().toISOString().slice(0, 10);
  const values = await redisPipeline(config, [
    ["GET", "lucid:usage:presentations"],
    ["GET", "lucid:usage:slides_processed"],
    ["GET", "lucid:usage:slides_changed"],
    ["GET", "lucid:usage:changes_applied"],
    ["PFCOUNT", "lucid:usage:unique_devices"],
    ["GET", "lucid:usage:last_conversion_at"],
    ["GET", `lucid:usage:day:${day}:presentations`],
    ["GET", `lucid:usage:day:${day}:slides_processed`],
    ["GET", `lucid:usage:day:${day}:slides_changed`],
  ]);
  return response.status(200).json({
    totals: {
      presentationsConverted: numeric(values[0]),
      slidesProcessed: numeric(values[1]),
      slidesChanged: numeric(values[2]),
      changesApplied: numeric(values[3]),
      approximateUniqueDevices: numeric(values[4]),
    },
    lastConversionAt: values[5] || null,
    today: {
      date: day,
      presentationsConverted: numeric(values[6]),
      slidesProcessed: numeric(values[7]),
      slidesChanged: numeric(values[8]),
    },
  });
}

export default async function handler(request, response) {
  setSecurityHeaders(response);
  const config = redisConfig();
  try {
    if (request.method === "POST") return await recordConversion(request, response, config);
    if (request.method === "GET") return await usageSummary(request, response, config);
    return response.status(405).json({ error: "Method not allowed." });
  } catch (error) {
    console.error("Usage tracking failed", error);
    return response.status(502).json({ error: "Usage tracking is temporarily unavailable." });
  }
}
