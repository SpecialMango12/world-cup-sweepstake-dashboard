/**
 * World Cup 2026 Family Sweepstake Dashboard
 * ------------------------------------------
 * Express server that:
 *   1. Serves the static front-end (public/)
 *   2. Proxies the worldcup26.ir REST API (avoids browser CORS issues)
 *      with an in-memory cache to avoid hammering upstream.
 *
 * Performance strategy (fixes slow first-load):
 *   - Cache is pre-warmed on startup so the first visitor never waits.
 *   - Stale-while-revalidate: once TTL expires, stale data is returned
 *     immediately while a background fetch silently updates the cache.
 *   - Background refresh intervals keep the cache warm at all times,
 *     independent of user requests.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const compression = require("compression");

const app = express();
const PORT = process.env.PORT || 3050;

const UPSTREAM = "https://worldcup26.ir";

// ---------------------------------------------------------------------------
// Sweepstake configuration store
// ---------------------------------------------------------------------------
// Each deployment owns its own configuration (members, colours, team ownership
// and tournament branding). It is stored as a single JSON file on disk so it is
// shared across everyone who visits this server. When the file is absent the
// app is considered "not configured" and the front-end shows the first-run
// welcome / setup flow.
const DATA_DIR    = path.join(__dirname, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const HEX_RE      = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return null; // missing or unreadable -> not configured
  }
}

function writeConfig(config) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: write to a temp file then rename so a crash mid-write can
  // never leave a half-written config on disk.
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

/**
 * Validate and normalise an incoming configuration payload.
 * Returns { config } on success or { error } on failure.
 */
function validateConfig(body) {
  if (!body || typeof body !== "object") {
    return { error: "Configuration must be an object." };
  }

  const tournamentName = String(body.tournamentName || "").trim();
  if (!tournamentName) {
    return { error: "A tournament name is required." };
  }
  const subtitle = String(body.subtitle || "").trim();

  if (!Array.isArray(body.members) || body.members.length < 2) {
    return { error: "At least two members are required." };
  }

  const seenIds = new Set();
  const members = [];
  for (const m of body.members) {
    if (!m || typeof m !== "object") {
      return { error: "Each member must be an object." };
    }
    const id = String(m.id || "").trim();
    const name = String(m.name || "").trim();
    if (!id) return { error: "Every member needs an id." };
    if (!name) return { error: "Every member needs a name." };
    if (seenIds.has(id)) return { error: `Duplicate member id: ${id}` };
    seenIds.add(id);
    if (!HEX_RE.test(String(m.colour || ""))) {
      return { error: `Member "${name}" has an invalid colour.` };
    }
    const colour = String(m.colour);
    const text   = HEX_RE.test(String(m.text || ""))   ? String(m.text)   : "#ffffff";
    const accent = HEX_RE.test(String(m.accent || "")) ? String(m.accent) : colour;
    members.push({ id, name, colour, text, accent });
  }

  // Ownership: keep only entries whose member id exists.
  const ownership = {};
  if (body.ownership && typeof body.ownership === "object") {
    for (const [team, memberId] of Object.entries(body.ownership)) {
      const teamName = String(team).trim();
      const mid = String(memberId).trim();
      if (teamName && seenIds.has(mid)) ownership[teamName] = mid;
    }
  }

  return {
    config: {
      configured: true,
      tournamentName,
      subtitle,
      members,
      ownership,
      updatedAt: new Date().toISOString(),
    },
  };
}

// How long (ms) a cached entry is considered fresh.
const CACHE_TTL = {
  games:    25 * 1000,
  teams:    60 * 60 * 1000,
  groups:   45 * 1000,
  stadiums: 24 * 60 * 60 * 1000,
};

// Maximum age (ms) for stale-while-revalidate: stale entries up to this age
// are returned immediately while a background refresh runs.  Beyond this window
// the server blocks on a fresh fetch (cold cache only — should never happen in
// normal operation thanks to background refresh intervals).
const STALE_TTL = {
  games:    5  * 60 * 1000,
  teams:    24 * 60 * 60 * 1000,
  groups:   5  * 60 * 1000,
  stadiums: 7  * 24 * 60 * 60 * 1000,
};

const cache      = new Map(); // key -> { ts, data }
const refreshing = new Set(); // resources currently being fetched in background

/** Fetch from upstream with up to `retries` retries and exponential backoff. */
async function fetchWithRetry(url, retries = 3, baseDelayMs = 500) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Upstream responded ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      clearTimeout(timeout);
      if (attempt < retries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt); // 500 ms, 1 000 ms, 2 000 ms
        console.warn(`[api] ${url} attempt ${attempt + 1} failed (${err.message}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

/**
 * Fire-and-forget background fetch that updates the cache.
 * Safe to call without awaiting — errors are logged, not thrown.
 */
async function refreshCache(resource) {
  if (refreshing.has(resource)) return; // already in flight, skip
  refreshing.add(resource);
  try {
    const data = await fetchWithRetry(`${UPSTREAM}/get/${resource}`);
    cache.set(resource, { ts: Date.now(), data });
    console.log(`[cache] ${resource} refreshed (${Array.isArray(data) ? data.length : "?"} items)`);
  } catch (err) {
    console.error(`[cache] ${resource} background refresh failed:`, err.message);
  } finally {
    refreshing.delete(resource);
  }
}

async function fetchUpstream(resource) {
  const ttl      = CACHE_TTL[resource]  ?? 30 * 1000;
  const staleTtl = STALE_TTL[resource]  ?? 5 * 60 * 1000;
  const cached   = cache.get(resource);
  const now      = Date.now();

  if (cached) {
    const age = now - cached.ts;

    if (age < ttl) {
      // Cache is fresh — return immediately.
      return { data: cached.data, cached: true, age };
    }

    if (age < staleTtl) {
      // Stale-while-revalidate: return stale data NOW and refresh in background.
      // Users never wait for an upstream fetch after the initial warm-up.
      refreshCache(resource).catch(() => {});
      return { data: cached.data, cached: true, stale: true, age };
    }
  }

  // Cache is cold (empty) or older than the stale window — block on upstream.
  // In normal operation this path is only hit during the startup pre-warm.
  try {
    const data = await fetchWithRetry(`${UPSTREAM}/get/${resource}`);
    cache.set(resource, { ts: now, data });
    return { data, cached: false, age: 0 };
  } catch (err) {
    if (cached) {
      // Last-resort: serve whatever we have rather than returning an error.
      console.warn(`[api] ${resource} fetch failed, serving stale cache (age ${Math.round((now - cached.ts) / 1000)}s):`, err.message);
      return { data: cached.data, cached: true, stale: true, age: now - cached.ts };
    }
    throw err;
  }
}

app.use(compression());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------------------
// Config API
// ---------------------------------------------------------------------------
// GET    /api/config -> current config, or { configured:false } if none saved.
// PUT    /api/config -> validate + persist a new config.
// DELETE /api/config -> reset (start over).
app.get("/api/config", (req, res) => {
  const config = readConfig();
  if (!config) return res.json({ configured: false });
  res.json({ configured: true, ...config });
});

app.put("/api/config", (req, res) => {
  const { config, error } = validateConfig(req.body);
  if (error) return res.status(400).json({ error });
  try {
    writeConfig(config);
    res.json(config);
  } catch (err) {
    console.error("[config] write failed:", err.message);
    res.status(500).json({ error: "Could not save configuration." });
  }
});

app.delete("/api/config", (req, res) => {
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
    res.json({ configured: false });
  } catch (err) {
    console.error("[config] reset failed:", err.message);
    res.status(500).json({ error: "Could not reset configuration." });
  }
});

function makeRoute(resource) {
  app.get(`/api/${resource}`, async (req, res) => {
    try {
      const result = await fetchUpstream(resource);
      res.set("Cache-Control", "no-cache");
      res.set("X-Data-Cached", String(result.cached));
      res.set("X-Data-Stale",  String(!!result.stale));
      res.json(result.data);
    } catch (err) {
      console.error(`[api] ${resource} failed:`, err.message);
      res.status(502).json({
        error:  `Could not load ${resource} from upstream API`,
        detail: err.message,
      });
    }
  });
}

["games", "teams", "groups", "stadiums"].forEach(makeRoute);

// Health endpoint — also reports cache state for diagnostics.
app.get("/api/health", (req, res) => {
  const cacheInfo = {};
  for (const [k, v] of cache.entries()) {
    cacheInfo[k] = {
      ageSeconds: Math.round((Date.now() - v.ts) / 1000),
      items: Array.isArray(v.data) ? v.data.length : typeof v.data,
    };
  }
  res.json({ status: "ok", time: new Date().toISOString(), cache: cacheInfo });
});

/**
 * Pre-warm the cache for all resources at startup.
 * Runs concurrently so the server is ready to serve cached data as quickly
 * as possible (typically within the first upstream round-trip, ~1–3 s).
 */
async function warmCache() {
  console.log("[cache] Pre-warming all resources…");
  await Promise.allSettled(["teams", "stadiums", "games", "groups"].map(refreshCache));
  console.log("[cache] Pre-warm complete.");
}

/**
 * Set up background refresh intervals so the cache stays warm indefinitely,
 * independent of user traffic (including periods of zero requests on EB).
 */
function startBackgroundRefresh() {
  setInterval(() => refreshCache("games"),    CACHE_TTL.games);
  setInterval(() => refreshCache("groups"),   CACHE_TTL.groups);
  setInterval(() => refreshCache("teams"),    CACHE_TTL.teams);
  setInterval(() => refreshCache("stadiums"), CACHE_TTL.stadiums);
  console.log("[cache] Background refresh intervals started.");
}

app.listen(PORT, () => {
  console.log(`\n  ⚽  World Cup Sweepstake Dashboard running`);
  console.log(`  →  http://localhost:${PORT}\n`);
  // Warm the cache immediately, then start background intervals.
  warmCache().then(startBackgroundRefresh).catch((err) =>
    console.error("[cache] Startup warm failed:", err.message)
  );
});
