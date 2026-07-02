/**
 * Sweepstake configuration (runtime-loaded).
 * ------------------------------------------------------------------
 * The family-specific data (members, colours and team ownership) is no longer
 * hardcoded here. It is created by the setup wizard and stored on the server,
 * then fetched at runtime via fetchConfig() and applied with applyConfig().
 *
 * MEMBERS:      member id -> { name, colour, text, accent }.
 * MEMBER_ORDER: display order for legend / filters.
 * OWNERSHIP:    team name (as it appears in the worldcup26.ir API field
 *               `name_en`) -> member id.
 *
 * Team-name aliases are handled in normaliseTeamName() so small spelling
 * differences (e.g. "Turkiye" vs "Turkey") still resolve correctly.
 */

// Populated at runtime by applyConfig(). Kept as mutable module-level bindings
// so the rest of the app (app.js) can keep referencing them by name.
let MEMBERS = {};
let MEMBER_ORDER = [];
let OWNERSHIP = {};

// Branding, also populated from the saved config.
let CONFIG = { tournamentName: "", subtitle: "" };

// Map small naming differences from the API onto our ownership keys.
const NAME_ALIASES = {
  "Turkiye": "Turkey",
  "Türkiye": "Turkey",
  "Czechia": "Czech Republic",
  "Congo DR": "Democratic Republic of the Congo",
  "DR Congo": "Democratic Republic of the Congo",
  "USA": "United States",
  "Curacao": "Curaçao",
  "Republic of Ireland": "Ireland",
  "South-Korea": "South Korea",
  "Korea Republic": "South Korea",
};

function normaliseTeamName(name) {
  if (!name) return name;
  const trimmed = String(name).trim();
  return NAME_ALIASES[trimmed] || trimmed;
}

function ownerOf(teamName) {
  const key = normaliseTeamName(teamName);
  return OWNERSHIP[key] || null;
}

/**
 * Apply a config object (as returned by GET /api/config) to the runtime
 * bindings the app renders from.
 */
function applyConfig(cfg) {
  if (!cfg) return;
  MEMBERS = {};
  MEMBER_ORDER = [];
  (cfg.members || []).forEach((m) => {
    MEMBERS[m.id] = {
      name: m.name,
      colour: m.colour,
      text: m.text || readableTextColour(m.colour),
      accent: m.accent || lightenColour(m.colour, 0.18),
    };
    MEMBER_ORDER.push(m.id);
  });
  OWNERSHIP = { ...(cfg.ownership || {}) };
  CONFIG = {
    tournamentName: cfg.tournamentName || "",
    subtitle: cfg.subtitle || "",
  };
}

/** Fetch the saved config from the server. Returns the config or null. */
async function fetchConfig() {
  try {
    const res = await fetch("/api/config", { cache: "no-cache" });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.configured ? data : null;
  } catch (err) {
    return null;
  }
}

/* ---------- Colour helpers ---------- */

/** Parse a #rgb or #rrggbb string into { r, g, b } (0-255). */
function hexToRgb(hex) {
  let h = String(hex || "").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n) || h.length !== 6) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(r, g, b) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Choose black or white text for good contrast on the given background colour
 * using the WCAG relative-luminance heuristic.
 */
function readableTextColour(hex) {
  const { r, g, b } = hexToRgb(hex);
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.4 ? "#0b1020" : "#ffffff";
}

/** Lighten a colour by mixing it towards white by `amount` (0-1). */
function lightenColour(hex, amount = 0.18) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c) => c + (255 - c) * amount;
  return rgbToHex(mix(r), mix(g), mix(b));
}
