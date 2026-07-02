/* =====================================================================
   World Cup 2026 Family Sweepstake Dashboard — front-end logic
   ===================================================================== */

const STAGE_LABELS = {
  group: "Group stage",
  r32: "Round of 32",
  r16: "Round of 16",
  qf: "Quarter-final",
  sf: "Semi-final",
  third: "Third place",
  final: "Final",
};

// UTC offsets for each venue region during summer (BST = UTC+1)
const REGION_UTC_OFFSET = {
  Eastern: -4,  // EDT
  Central: -5,  // CDT
  Western: -7,  // PDT
};

const REFRESH_MS = 30 * 1000;

const state = {
  teams: [],
  games: [],
  groups: [],
  stadiums: [],
  teamById: new Map(),
  stadiumById: new Map(),
  view: "fixtures",
  ownerFilter: null,        // legend click -> highlight one member
  h2h: [],                  // up to two member ids
  filters: { stage: "all", status: "upcoming", search: "" },
  finishedCollapsed: true,  // hide finished matches by default in all/upcoming views
  lastUpdated: null,
};

/* ---------- DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}

/* ---------- Data parsing ---------- */
function parseScorers(raw) {
  if (!raw || raw === "null" || raw === "NULL") return [];
  // Format examples (note: some rows use smart/curly quotes):
  //   {"Name 27'","Other 75' (p)"}
  //   {“J. Quiñones 9'”,”R. Jiménez 67'”}
  const str = String(raw);
  const matches = str.match(/["“”]([^"“”]+)["“”]/g);
  if (matches) return matches.map((m) => m.replace(/["“”]/g, "").trim()).filter(Boolean);
  // Fallback: strip braces and split on commas.
  return str
    .replace(/^[{(]|[})]$/g, "")
    .split(",")
    .map((s) => s.replace(/["“”]/g, "").trim())
    .filter((s) => s && s.toLowerCase() !== "null");
}

function parseDate(localDate, region) {
  // "06/13/2026 21:00"  (MM/DD/YYYY HH:MM) — venue local time
  if (!localDate) return null;
  const m = localDate.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mm, dd, yyyy, hh, min] = m;
  const offsetHours = REGION_UTC_OFFSET[region] ?? -5; // default Central if unknown
  // Convert venue local time → UTC: UTC = local − offset  (offset is negative for Americas)
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh) - offsetHours, Number(min)));
}

function venueRegion(stadiumId) {
  return state.stadiumById.get(String(stadiumId))?.region;
}

function formatBST(date, opts) {
  return date.toLocaleString("en-GB", { timeZone: "Europe/London", ...opts });
}

function gameStatus(g) {
  if (String(g.finished).toUpperCase() === "TRUE") return "finished";
  const te = String(g.time_elapsed || "").toLowerCase();
  if (te && te !== "notstarted" && te !== "not started") return "live";
  return "upcoming";
}

function teamInfo(id, fallbackLabel) {
  if (id && id !== "0" && state.teamById.has(String(id))) {
    return state.teamById.get(String(id));
  }
  return {
    id: id,
    name_en: fallbackLabel || "TBD",
    flag: null,
    owner: null,
    isPlaceholder: true,
  };
}

/* ---------- Loading ---------- */
async function fetchJSON(url, retries = 2, delayMs = 800) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // "no-cache" revalidates with the server but allows the server's own
      // cache (SWR) to respond immediately rather than waiting on upstream.
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`${url} → ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
}

async function loadAll(initial = false) {
  const btn = $("#refreshBtn");
  btn.classList.add("spin");

  // Use allSettled so one slow/failed endpoint doesn't kill the whole update.
  const [teamsResult, gamesResult, groupsResult, stadiumsResult] =
    await Promise.allSettled([
      fetchJSON("/api/teams"),
      fetchJSON("/api/games"),
      fetchJSON("/api/groups"),
      fetchJSON("/api/stadiums"),
    ]);

  const failures = [teamsResult, gamesResult, groupsResult, stadiumsResult].filter(
    (r) => r.status === "rejected"
  );

  let anyDataUpdated = false;

  if (teamsResult.status === "fulfilled") {
    const raw = teamsResult.value;
    const list = raw.teams || raw || [];
    if (list.length) {
      state.teams = list;
      state.teamById = new Map();
      state.teams.forEach((t) => {
        t.owner = ownerOf(t.name_en);
        state.teamById.set(String(t.id), t);
      });
      anyDataUpdated = true;
    }
  }

  if (gamesResult.status === "fulfilled") {
    const raw = gamesResult.value;
    const list = raw.games || raw || [];
    if (list.length) { state.games = list; anyDataUpdated = true; }
  }

  if (groupsResult.status === "fulfilled") {
    const raw = groupsResult.value;
    const list = raw.groups || raw || [];
    if (list.length) { state.groups = list; anyDataUpdated = true; }
  }

  if (stadiumsResult.status === "fulfilled") {
    const raw = stadiumsResult.value;
    const list = raw.stadiums || raw || [];
    if (list.length) {
      state.stadiums = list;
      state.stadiumById = new Map();
      state.stadiums.forEach((s) => state.stadiumById.set(String(s.id), s));
      anyDataUpdated = true;
    }
  }

  if (anyDataUpdated) {
    state.lastUpdated = new Date();
    updateLastUpdated(failures.length > 0);
    renderAll();
    if (!initial && failures.length === 0) toast("Scores refreshed");
  } else {
    // Nothing came back at all.
    failures.forEach((f) => console.error("[loadAll]", f.reason));
    updateLastUpdated(true);
    if (!state.games.length) {
      // First load with nothing — show a persistent message.
      $("#fixtures").innerHTML =
        `<div class="empty-state"><i class="bi bi-wifi-off" style="font-size:2rem"></i>
         <p class="mt-2 mb-0">Cannot reach the live API right now.<br>
         <small>Make sure the server is running, then hit <b>Refresh</b>.</small></p></div>`;
    }
    toast("Live API unavailable — retrying soon", true);
  }

  btn.classList.remove("spin");
}

function updateLastUpdated(stale) {
  const span = $("#lastUpdated");
  if (state.lastUpdated) {
    span.textContent = state.lastUpdated.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const badge = $("#liveBadge");
  const anyLive = state.games.some((g) => gameStatus(g) === "live");
  badge.classList.toggle("stale", stale);
  const label = stale ? "OFFLINE" : anyLive ? "LIVE" : "LATEST";
  badge.innerHTML = `<span class="dot"></span> ${label}`;
}

/* ---------- Members helpers ---------- */
function memberTeams(memberId) {
  return state.teams.filter((t) => t.owner === memberId);
}

function switchView(view) {
  if (state.view === view) return;
  state.view = view;
  document.querySelectorAll("#viewTabs .nav-link").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view)
  );
  document.querySelectorAll(".view").forEach((v) => v.classList.add("d-none"));
  $(`#view-${view}`).classList.remove("d-none");
}

/* ====================================================================
   RENDER
   ==================================================================== */
function renderAll() {
  renderLegend();
  renderH2HPickers();
  renderFixtures();
  renderGroups();
  renderStandings();
}

/* ---------- Legend ---------- */
function renderLegend() {
  const wrap = $("#legend");
  wrap.innerHTML = "";
  MEMBER_ORDER.forEach((id) => {
    const m = MEMBERS[id];
    const teams = memberTeams(id);
    const card = el("div", "legend-card");
    card.style.setProperty("--mc", m.colour);
    card.style.setProperty("--mc-text", m.text);
    if (state.ownerFilter === id) card.classList.add("active");
    card.innerHTML = `
      <div class="legend-swatch">${esc(m.name[0])}</div>
      <div>
        <div class="legend-name">${esc(m.name)}</div>
        <div class="legend-meta">${teams.length} teams${
          state.ownerFilter === id ? " · filtering" : ""
        }</div>
      </div>`;
    card.title = teams.map((t) => t.name_en).join(", ");
    card.addEventListener("click", () => {
      state.ownerFilter = state.ownerFilter === id ? null : id;
      if (state.ownerFilter) switchView("fixtures");
      renderLegend();
      renderFixtures();
    });
    wrap.appendChild(card);
  });
}

/* ---------- Head-to-head ---------- */
function renderH2HPickers() {
  const wrap = $("#h2hPickers");
  wrap.innerHTML = "";
  MEMBER_ORDER.forEach((id) => {
    const m = MEMBERS[id];
    const chip = el("button", "h2h-chip");
    chip.style.setProperty("--mc", m.colour);
    chip.style.setProperty("--mc-text", m.text);
    const selected = state.h2h.includes(id);
    if (selected) chip.classList.add("selected");
    if (!selected && state.h2h.length >= 2) chip.classList.add("disabled");
    chip.innerHTML = `<span class="swatch"></span>${esc(m.name)}`;
    chip.addEventListener("click", () => toggleH2H(id));
    wrap.appendChild(chip);
  });
  $("#h2hClear").classList.toggle("d-none", state.h2h.length === 0);
  renderH2HSummary();
}

function toggleH2H(id) {
  const idx = state.h2h.indexOf(id);
  if (idx >= 0) state.h2h.splice(idx, 1);
  else if (state.h2h.length < 2) state.h2h.push(id);
  if (state.h2h.length === 2) switchView("fixtures");
  renderH2HPickers();
  renderFixtures();
}

function renderH2HSummary() {
  const box = $("#h2hSummary");
  if (state.h2h.length < 2) {
    box.classList.add("d-none");
    return;
  }
  const [a, b] = state.h2h;
  const games = h2hGames();
  const ma = MEMBERS[a], mb = MEMBERS[b];
  let aWins = 0, bWins = 0, draws = 0, finished = 0;
  games.forEach((g) => {
    const st = gameStatus(g);
    if (st !== "finished") return;
    finished++;
    const home = teamInfo(g.home_team_id, g.home_team_label);
    const hs = Number(g.home_score), as = Number(g.away_score);
    const homeOwner = home.owner;
    let winnerOwner = null;
    if (hs > as) winnerOwner = homeOwner;
    else if (as > hs) winnerOwner = teamInfo(g.away_team_id, g.away_team_label).owner;
    if (winnerOwner === a) aWins++;
    else if (winnerOwner === b) bWins++;
    else draws++;
  });
  box.classList.remove("d-none");
  box.innerHTML = `
    Showing <b>${games.length}</b> match${games.length === 1 ? "" : "es"} where
    <b style="color:${ma.colour}">${esc(ma.name)}</b>'s teams meet
    <b style="color:${mb.colour}">${esc(mb.name)}</b>'s teams.
    ${
      finished
        ? `&nbsp; Result so far: <b style="color:${ma.colour}">${esc(ma.name)} ${aWins}</b>
           – <b style="color:${mb.colour}">${bWins} ${esc(mb.name)}</b>${draws ? ` &nbsp;(${draws} draw${draws === 1 ? "" : "s"})` : ""}.`
        : "&nbsp; None of these have been played yet."
    }`;
}

function h2hGames() {
  const [a, b] = state.h2h;
  return state.games.filter((g) => {
    const ho = teamInfo(g.home_team_id, g.home_team_label).owner;
    const ao = teamInfo(g.away_team_id, g.away_team_label).owner;
    return (ho === a && ao === b) || (ho === b && ao === a);
  });
}

/* ---------- Fixtures ---------- */

/** Render a list of games into `container`, grouped by BST day. */
function renderDayGroups(container, gameList, h2hActive) {
  const byDay = new Map();
  gameList.forEach((g) => {
    const d = parseDate(g.local_date, venueRegion(g.stadium_id));
    let key, label;
    if (d) {
      key = formatBST(d, { year: "numeric", month: "2-digit", day: "2-digit" });
      label = formatBST(d, { weekday: "long", day: "numeric", month: "long" });
    } else {
      key = "TBD";
      label = "Date to be confirmed";
    }
    if (!byDay.has(key)) byDay.set(key, { label, games: [] });
    byDay.get(key).games.push(g);
  });
  for (const [, { label, games: dayGames }] of byDay) {
    const title = el("div", "day-group-title");
    title.innerHTML = `<i class="bi bi-calendar3"></i> ${esc(label)} <span class="pill">${dayGames.length} match${dayGames.length === 1 ? "" : "es"}</span>`;
    container.appendChild(title);
    const grid = el("div", "match-grid");
    dayGames.forEach((g) => grid.appendChild(matchCard(g, h2hActive)));
    container.appendChild(grid);
  }
}

function renderFixtures() {
  const wrap = $("#fixtures");
  const f = state.filters;
  const h2hActive = state.h2h.length === 2;

  let games = state.games.slice();

  if (h2hActive) {
    games = h2hGames();
  } else {
    if (f.stage !== "all") games = games.filter((g) => g.type === f.stage);
    if (state.ownerFilter) {
      games = games.filter((g) => {
        const ho = teamInfo(g.home_team_id, g.home_team_label).owner;
        const ao = teamInfo(g.away_team_id, g.away_team_label).owner;
        return ho === state.ownerFilter || ao === state.ownerFilter;
      });
    }
    if (f.search.trim()) {
      const q = f.search.trim().toLowerCase();
      games = games.filter((g) => {
        const h = teamInfo(g.home_team_id, g.home_team_label);
        const a = teamInfo(g.away_team_id, g.away_team_label);
        const hOwner = h.owner ? MEMBERS[h.owner].name : "";
        const aOwner = a.owner ? MEMBERS[a.owner].name : "";
        // Include scorer names so player-name searches work (e.g. "Messi", "Ronaldo")
        const hScorers = parseScorers(g.home_scorers).join(" ");
        const aScorers = parseScorers(g.away_scorers).join(" ");
        return (
          (h.name_en || "").toLowerCase().includes(q) ||
          (a.name_en || "").toLowerCase().includes(q) ||
          hOwner.toLowerCase().includes(q) ||
          aOwner.toLowerCase().includes(q) ||
          hScorers.toLowerCase().includes(q) ||
          aScorers.toLowerCase().includes(q)
        );
      });
    }
  }

  const sortByDateAsc = (g1, g2) => {
    const d1 = parseDate(g1.local_date, venueRegion(g1.stadium_id))?.getTime() ?? 0;
    const d2 = parseDate(g2.local_date, venueRegion(g2.stadium_id))?.getTime() ?? 0;
    if (d1 !== d2) return d1 - d2;
    return Number(g1.id) - Number(g2.id);
  };

  const sortByDateDesc = (g1, g2) => sortByDateAsc(g2, g1);

  // Sort active/upcoming lists chronologically; finished lists are reversed below.
  games.sort(sortByDateAsc);

  // Collapsible finished section: active when not in H2H mode and viewing "all"
  // or "upcoming" — lets users show/hide completed matches without switching views.
  const useCollapsible = !h2hActive && (f.status === "all" || f.status === "upcoming");

  let visibleGames, finishedGames = [];
  if (useCollapsible) {
    finishedGames = games.filter((g) => gameStatus(g) === "finished").sort(sortByDateDesc);
    visibleGames  = games.filter((g) => gameStatus(g) !== "finished");
  } else {
    visibleGames = f.status !== "all" ? games.filter((g) => gameStatus(g) === f.status) : games;
    if (f.status === "finished") visibleGames.sort(sortByDateDesc);
  }

  // Match count summary
  const liveN = visibleGames.filter((g) => gameStatus(g) === "live").length;
  let countHTML = `Showing <b>${visibleGames.length}</b> match${visibleGames.length === 1 ? "" : "es"}`;
  if (useCollapsible && finishedGames.length) {
    countHTML += ` · <b>${finishedGames.length}</b> finished ${state.finishedCollapsed ? "(hidden)" : ""}`;
  }
  if (liveN) countHTML += ` · <span style="color:var(--green)">${liveN} live now</span>`;
  $("#matchCount").innerHTML = countHTML;

  wrap.innerHTML = "";

  if (!visibleGames.length && (!useCollapsible || !finishedGames.length)) {
    wrap.appendChild(
      el("div", "empty-state", `<i class="bi bi-search" style="font-size:1.6rem"></i><p class="mt-2 mb-0">No matches match your filters.</p>`)
    );
    return;
  }

  // Render collapsible finished section toggle FIRST so it's immediately visible,
  // then render upcoming/live games below it.
  if (useCollapsible && finishedGames.length) {
    const collapsed = state.finishedCollapsed;
    const toggleBtn = el("div", "finished-toggle");
    toggleBtn.setAttribute("role", "button");
    toggleBtn.setAttribute("tabindex", "0");
    toggleBtn.innerHTML = `
      <span class="left">
        <i class="bi bi-check-circle-fill"></i>
        <span>${collapsed
          ? `Show ${finishedGames.length} finished match${finishedGames.length === 1 ? "" : "es"}`
          : "Hide finished matches"}</span>
      </span>
      <i class="bi ${collapsed ? "bi-chevron-down" : "bi-chevron-up"} toggle-icon"></i>`;
    const onToggle = () => {
      state.finishedCollapsed = !state.finishedCollapsed;
      renderFixtures();
    };
    toggleBtn.addEventListener("click", onToggle);
    toggleBtn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") onToggle(); });
    wrap.appendChild(toggleBtn);

    if (!collapsed) {
      renderDayGroups(wrap, finishedGames, h2hActive);
    }
  }

  // Render upcoming / live games
  if (visibleGames.length) {
    renderDayGroups(wrap, visibleGames, h2hActive);
  }
}

function teamRowHTML(team, score, status, isWinner) {
  const owner = team.owner ? MEMBERS[team.owner] : null;
  const ownerBar = owner ? owner.colour : "transparent";
  const flag = team.flag
    ? `<img class="team-flag" src="${esc(team.flag)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`
    : `<span class="team-flag" style="display:grid;place-items:center;font-size:.7rem;color:var(--muted-2)">?</span>`;
  const ownerLabel = owner
    ? `<span class="team-owner" style="--oc:${owner.colour}"><span class="swatch"></span>${esc(owner.name)}</span>`
    : `<span class="team-owner none">— unassigned —</span>`;
  const scoreHTML =
    status === "upcoming"
      ? `<span class="team-score pending">–</span>`
      : `<span class="team-score">${esc(score)}</span>`;
  return `
    <div class="team-row ${isWinner ? "winner" : ""}">
      <span class="owner-bar" style="--ob:${ownerBar}"></span>
      ${flag}
      <div class="team-info">
        <span class="team-name">${esc(team.name_en)}</span>
        ${ownerLabel}
      </div>
      ${scoreHTML}
    </div>`;
}

function matchCard(g, h2hActive) {
  const status = gameStatus(g);
  const home = teamInfo(g.home_team_id, g.home_team_label);
  const away = teamInfo(g.away_team_id, g.away_team_label);
  const hs = g.home_score, as = g.away_score;
  const hsN = Number(hs), asN = Number(as);
  const homeWin = status === "finished" && hsN > asN;
  const awayWin = status === "finished" && asN > hsN;

  const stadium = state.stadiumById.get(String(g.stadium_id));
  const date = parseDate(g.local_date, stadium?.region);
  const timeStr = date
    ? formatBST(date, { hour: "2-digit", minute: "2-digit" }) + " BST"
    : "";

  const stageLabel =
    g.type === "group" ? `Group ${esc(g.group)}` : STAGE_LABELS[g.type] || esc(g.group);

  let statusHTML = "";
  if (status === "live")
    statusHTML = `<span class="match-status status-live"><span class="dot"></span>${esc(
      g.time_elapsed
    )}'</span>`;
  else if (status === "finished")
    statusHTML = `<span class="match-status status-finished"><i class="bi bi-check-circle-fill"></i> Full time</span>`;
  else
    statusHTML = `<span class="match-status status-upcoming"><i class="bi bi-clock"></i> ${esc(timeStr)}</span>`;

  const card = el("div", `match-card ${status === "live" ? "is-live" : ""} ${h2hActive ? "has-h2h" : ""}`);

  const homeScorers = parseScorers(g.home_scorers);
  const awayScorers = parseScorers(g.away_scorers);
  const scorersHTML =
    (homeScorers.length || awayScorers.length) && status !== "upcoming"
      ? `<div class="scorers">
           ${homeScorers.map((s) => `<div class="s-line"><i class="bi bi-dot"></i> ${esc(s)} <span style="color:var(--muted-2)">(${esc(home.name_en)})</span></div>`).join("")}
           ${awayScorers.map((s) => `<div class="s-line"><i class="bi bi-dot"></i> ${esc(s)} <span style="color:var(--muted-2)">(${esc(away.name_en)})</span></div>`).join("")}
         </div>`
      : "";

  card.innerHTML = `
    ${h2hActive ? `<div class="h2h-flag">H2H</div>` : ""}
    <div class="match-top">
      <span class="match-stage">${stageLabel}${g.matchday && g.type === "group" ? ` · MD${esc(g.matchday)}` : ""}</span>
      ${statusHTML}
    </div>
    <div class="match-body">
      ${teamRowHTML(home, hs, status, homeWin)}
      <div class="match-vs">VS</div>
      ${teamRowHTML(away, as, status, awayWin)}
    </div>
    ${scorersHTML}
    <div class="match-foot">
      <span class="venue"><i class="bi bi-geo-alt"></i><span>${
        stadium ? esc(stadium.name_en) + ", " + esc(stadium.city_en) : "Venue TBC"
      }</span></span>
      <span>${date ? esc(formatBST(date, { day: "numeric", month: "short" })) : ""}</span>
    </div>`;
  return card;
}

/* ---------- Groups view (computed standings) ---------- */
function computeGroupStandings(groupLetter) {
  const teams = state.teams.filter((t) => t.groups === groupLetter);
  const stats = new Map();
  teams.forEach((t) =>
    stats.set(String(t.id), { team: t, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, Pts: 0 })
  );

  state.games
    .filter((g) => g.type === "group" && g.group === groupLetter && gameStatus(g) === "finished")
    .forEach((g) => {
      const h = stats.get(String(g.home_team_id));
      const a = stats.get(String(g.away_team_id));
      if (!h || !a) return;
      const hs = Number(g.home_score), as = Number(g.away_score);
      h.P++; a.P++;
      h.GF += hs; h.GA += as; a.GF += as; a.GA += hs;
      if (hs > as) { h.W++; a.L++; h.Pts += 3; }
      else if (as > hs) { a.W++; h.L++; a.Pts += 3; }
      else { h.D++; a.D++; h.Pts++; a.Pts++; }
    });

  return [...stats.values()].sort((x, y) => {
    if (y.Pts !== x.Pts) return y.Pts - x.Pts;
    if (y.GF - y.GA !== x.GF - x.GA) return (y.GF - y.GA) - (x.GF - x.GA);
    if (y.GF !== x.GF) return y.GF - x.GF;
    return x.team.name_en.localeCompare(y.team.name_en);
  });
}

// Team ids that reached the knockout bracket. The upstream API seeds the
// knockout fixtures with real team ids once qualification is decided, so this
// is the source of truth for who advanced (incl. best third-placed teams).
function computeAdvancingTeamIds() {
  const advancing = new Set();
  state.games.forEach((g) => {
    if (g.type === "group") return;
    [g.home_team_id, g.away_team_id].forEach((id) => {
      if (id && id !== "0" && state.teamById.has(String(id))) advancing.add(String(id));
    });
  });
  return advancing;
}

// A team is eliminated in the group stage when its group has finished every
// match and it did NOT make it into the knockout bracket. Note that only the
// top two of each group qualify automatically — the eight best third-placed
// teams also advance, so we must not assume everyone below second place is out.
function computeGroupStageEliminatedTeamIds() {
  const eliminated = new Set();
  const advancing = computeAdvancingTeamIds();
  if (advancing.size === 0) return eliminated; // knockout bracket not seeded yet

  const letters = [...new Set(state.teams.map((t) => t.groups).filter(Boolean))];

  letters.forEach((letter) => {
    const groupTeams = state.teams.filter((t) => t.groups === letter);
    const expectedGames = groupTeams.length * (groupTeams.length - 1) / 2;
    const finishedGames = state.games.filter(
      (g) => g.type === "group" && g.group === letter && gameStatus(g) === "finished"
    ).length;

    if (!expectedGames || finishedGames < expectedGames) return;

    groupTeams.forEach((t) => {
      if (!advancing.has(String(t.id))) eliminated.add(String(t.id));
    });
  });

  return eliminated;
}

function renderGroups() {
  const wrap = $("#groups");
  wrap.innerHTML = "";
  const letters = [...new Set(state.teams.map((t) => t.groups))].sort();
  letters.forEach((letter) => {
    const rows = computeGroupStandings(letter);
    const card = el("div", "group-card");
    let body = `
      <div class="group-head"><span class="badge-letter">${esc(letter)}</span> Group ${esc(letter)}</div>
      <div class="group-table-scroll"><table class="group-table">
        <thead><tr>
          <th class="team-col">Team</th>
          <th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th>
        </tr></thead><tbody>`;
    rows.forEach((r, i) => {
      const owner = r.team.owner ? MEMBERS[r.team.owner] : null;
      const gd = r.GF - r.GA;
      body += `
        <tr class="${i < 2 ? "qualify" : ""}">
          <td class="team-col">
            <div class="gt-team">
              <span class="owner-bar" style="--ob:${owner ? owner.colour : "transparent"}"></span>
              <span class="pos-dot">${i + 1}</span>
              ${r.team.flag ? `<img src="${esc(r.team.flag)}" alt="" loading="lazy">` : ""}
              <span>
                <span class="nm">${esc(r.team.name_en)}</span><br>
                <span class="ow" style="--oc:${owner ? owner.colour : "var(--muted-2)"}">${owner ? esc(owner.name) : "—"}</span>
              </span>
            </div>
          </td>
          <td>${r.P}</td><td>${r.W}</td><td>${r.D}</td><td>${r.L}</td>
          <td>${r.GF}</td><td>${r.GA}</td><td>${gd > 0 ? "+" + gd : gd}</td>
          <td class="pts">${r.Pts}</td>
        </tr>`;
    });
    body += `</tbody></table></div>`;
    card.innerHTML = body;
    wrap.appendChild(card);
  });
}

/* ---------- Sweepstake standings ---------- */
function computeMemberStats(memberId) {
  const teams = memberTeams(memberId);
  const teamIds = new Set(teams.map((t) => String(t.id)));
  let W = 0, D = 0, L = 0, GF = 0, GA = 0, Pts = 0, P = 0;
  const eliminated = computeGroupStageEliminatedTeamIds();

  state.games.forEach((g) => {
    if (gameStatus(g) !== "finished") return;
    const homeIs = teamIds.has(String(g.home_team_id));
    const awayIs = teamIds.has(String(g.away_team_id));
    if (!homeIs && !awayIs) return;
    const hs = Number(g.home_score), as = Number(g.away_score);

    if (homeIs && awayIs) {
      // intra-member match: count both sides
    }
    if (homeIs) {
      P++; GF += hs; GA += as;
      if (hs > as) { W++; Pts += 3; }
      else if (as > hs) { L++; if (g.type !== "group") eliminated.add(String(g.home_team_id)); }
      else { D++; Pts++; }
    }
    if (awayIs) {
      P++; GF += as; GA += hs;
      if (as > hs) { W++; Pts += 3; }
      else if (hs > as) { L++; if (g.type !== "group") eliminated.add(String(g.away_team_id)); }
      else { D++; Pts++; }
    }
  });

  return { teams, P, W, D, L, GF, GA, Pts, eliminated };
}

function renderStandings() {
  const wrap = $("#standings");
  wrap.innerHTML = "";
  const rows = MEMBER_ORDER.map((id) => ({ id, ...computeMemberStats(id) }));
  rows.sort((a, b) => {
    if (b.Pts !== a.Pts) return b.Pts - a.Pts;
    if (b.GF - b.GA !== a.GF - a.GA) return (b.GF - b.GA) - (a.GF - a.GA);
    if (b.GF !== a.GF) return b.GF - a.GF;
    return b.W - a.W;
  });

  const intro = el(
    "div",
    "section-sub mb-3",
    `<i class="bi bi-info-circle"></i> Leaderboard from each person's teams across the tournament (3 pts win · 1 pt draw). Eliminated teams are shown crossed-out.`
  );
  wrap.appendChild(intro);

  rows.forEach((r, i) => {
    const m = MEMBERS[r.id];
    const card = el("div", "stand-card");
    card.style.setProperty("--mc", m.colour);
    const teamsHTML = r.teams
      .map((t) => {
        const out = r.eliminated.has(String(t.id));
        return `<span class="mini-team ${out ? "out" : ""}">${
          t.flag ? `<img src="${esc(t.flag)}" alt="">` : ""
        }${esc(t.name_en)}</span>`;
      })
      .join("");
    card.innerHTML = `
      <div class="stand-rank ${i === 0 ? "top" : ""}">${i === 0 ? "🥇" : i + 1}</div>
      <div class="stand-main">
        <div class="stand-name"><span class="swatch"></span>${esc(m.name)}</div>
        <div class="stand-teams">${teamsHTML}</div>
      </div>
      <div class="stand-stats">
        <div class="stand-stat"><div class="v">${r.Pts}</div><div class="l">Pts</div></div>
        <div class="stand-stat"><div class="v">${r.W}-${r.D}-${r.L}</div><div class="l">W-D-L</div></div>
        <div class="stand-stat"><div class="v">${r.GF}:${r.GA}</div><div class="l">Goals</div></div>
      </div>`;
    wrap.appendChild(card);
  });
}

/* ====================================================================
   EVENTS
   ==================================================================== */
function bindEvents() {
  // view tabs
  document.querySelectorAll("#viewTabs .nav-link").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  $("#stageFilter").addEventListener("change", (e) => {
    state.filters.stage = e.target.value;
    renderFixtures();
  });
  $("#statusFilter").addEventListener("change", (e) => {
    state.filters.status = e.target.value;
    renderFixtures();
  });
  let searchT;
  $("#searchInput").addEventListener("input", (e) => {
    clearTimeout(searchT);
    searchT = setTimeout(() => {
      state.filters.search = e.target.value;
      renderFixtures();
    }, 180);
  });
  $("#resetFilters").addEventListener("click", () => {
    state.filters = { stage: "all", status: "upcoming", search: "" };
    state.ownerFilter = null;
    state.finishedCollapsed = true;
    $("#stageFilter").value = "all";
    $("#statusFilter").value = "upcoming";
    $("#searchInput").value = "";
    renderLegend();
    renderFixtures();
  });

  $("#h2hClear").addEventListener("click", () => {
    state.h2h = [];
    renderH2HPickers();
    renderFixtures();
  });

  $("#refreshBtn").addEventListener("click", () => loadAll(false));
}

/* ---------- Branding ---------- */
function applyBranding() {
  const name = CONFIG.tournamentName || "World Cup Sweepstake";
  const subtitle = CONFIG.subtitle || "";
  document.title = `⚽ ${name}`;
  const titleEl = $(".app-title");
  const subEl = $(".app-subtitle");
  if (titleEl) titleEl.textContent = name;
  if (subEl) {
    subEl.textContent = subtitle;
    subEl.classList.toggle("d-none", !subtitle);
  }
}

/* ---------- Init ---------- */
async function init() {
  // Load the saved sweepstake configuration first. If none exists yet, send
  // the visitor to the first-run welcome / setup flow.
  const cfg = await fetchConfig();
  if (!cfg) {
    window.location.replace("welcome.html");
    return;
  }
  applyConfig(cfg);
  applyBranding();

  bindEvents();
  loadAll(true);
  setInterval(() => loadAll(true), REFRESH_MS);
}

document.addEventListener("DOMContentLoaded", init);
