/* =====================================================================
   Setup wizard — build / edit the sweepstake configuration.
   ===================================================================== */

const PALETTE = [
  "#1b5e20", "#4fc3f7", "#fb8c00", "#ec407a", "#e53935", "#8e24aa",
  "#00897b", "#3949ab", "#fdd835", "#6d4c41", "#00acc1", "#7cb342",
];

const setup = {
  step: 1,
  maxStep: 4,
  tournamentName: "",
  subtitle: "",
  members: [],           // { id, name, colour }
  ownership: {},          // teamName -> memberId
  teams: [],              // fetched from /api/teams
  teamsLoaded: false,
  memberSeq: 0,
};

/* ---------- DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
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

function showError(msg) {
  const box = $("#setupError");
  if (!msg) { box.classList.add("d-none"); return; }
  box.textContent = msg;
  box.classList.remove("d-none");
}

function newMemberId() {
  setup.memberSeq += 1;
  return `m${setup.memberSeq}`;
}

/* ---------- Load existing config (edit mode) ---------- */
async function loadExisting() {
  try {
    const res = await fetch("/api/config", { cache: "no-cache" });
    const data = await res.json();
    if (data && data.configured) {
      setup.tournamentName = data.tournamentName || "";
      setup.subtitle = data.subtitle || "";
      setup.members = (data.members || []).map((m) => ({
        id: m.id,
        name: m.name,
        colour: m.colour,
      }));
      // Track the highest numeric id so newly-added members don't collide.
      setup.members.forEach((m) => {
        const n = parseInt(String(m.id).replace(/\D/g, ""), 10);
        if (!Number.isNaN(n) && n > setup.memberSeq) setup.memberSeq = n;
      });
      setup.ownership = { ...(data.ownership || {}) };
    }
  } catch (err) {
    /* first-run: nothing to load */
  }

  if (!setup.members.length) {
    // Seed with two starter members for a friendly blank slate.
    setup.members = [
      { id: newMemberId(), name: "", colour: PALETTE[0] },
      { id: newMemberId(), name: "", colour: PALETTE[1] },
    ];
  }
}

/* ---------- Teams ---------- */
async function loadTeams() {
  if (setup.teamsLoaded) return;
  try {
    const res = await fetch("/api/teams", { cache: "no-cache" });
    if (!res.ok) throw new Error(`teams ${res.status}`);
    const raw = await res.json();
    const list = raw.teams || raw || [];
    // Sort alphabetically for a predictable manual-assignment list.
    setup.teams = list
      .filter((t) => t && t.name_en)
      .sort((a, b) => a.name_en.localeCompare(b.name_en));
    setup.teamsLoaded = true;
  } catch (err) {
    setup.teams = [];
    setup.teamsLoaded = false;
    $("#teamAssign").innerHTML =
      `<div class="loading-teams"><i class="bi bi-wifi-off"></i><br>
       Couldn't load the team list from the live API. You can still save now and
       assign teams later by reopening setup.</div>`;
  }
}

/* ---------- Rendering ---------- */
function renderStepper() {
  $$(".stepper .step").forEach((el) => {
    const s = Number(el.dataset.step);
    el.classList.toggle("active", s === setup.step);
    el.classList.toggle("done", s < setup.step);
  });
}

function renderPanels() {
  $$("[data-panel]").forEach((el) => {
    el.classList.toggle("d-none", Number(el.dataset.panel) !== setup.step);
  });
  $("#backBtn").classList.toggle("d-none", setup.step === 1);
  $("#nextBtn").classList.toggle("d-none", setup.step === setup.maxStep);
  $("#saveBtn").classList.toggle("d-none", setup.step !== setup.maxStep);
}

function renderMembers() {
  const wrap = $("#memberList");
  wrap.innerHTML = "";
  setup.members.forEach((m, idx) => {
    const text = readableTextColour(m.colour);
    const row = document.createElement("div");
    row.className = "member-row";
    row.style.setProperty("--mc", m.colour);
    row.style.setProperty("--mc-text", text);
    row.innerHTML = `
      <div class="member-swatch">${esc((m.name || "?").trim().charAt(0).toUpperCase() || "?")}</div>
      <input class="member-name" type="text" maxlength="24" placeholder="Name"
             value="${esc(m.name)}" data-idx="${idx}" />
      <div class="colour-picker">
        <input type="color" value="${esc(m.colour)}" data-idx="${idx}" title="Pick a colour" />
      </div>
      <button class="member-remove" data-idx="${idx}" title="Remove"${
        setup.members.length <= 2 ? " disabled style='opacity:.3;cursor:not-allowed'" : ""
      }><i class="bi bi-x-circle"></i></button>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll("input.member-name").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.idx);
      setup.members[i].name = e.target.value;
      // Update the swatch initial without a full re-render (keeps focus).
      const swatch = e.target.previousElementSibling;
      swatch.textContent = (e.target.value.trim().charAt(0).toUpperCase()) || "?";
    });
  });
  wrap.querySelectorAll("input[type=color]").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const i = Number(e.target.dataset.idx);
      setup.members[i].colour = e.target.value;
      const row = e.target.closest(".member-row");
      row.style.setProperty("--mc", e.target.value);
      row.style.setProperty("--mc-text", readableTextColour(e.target.value));
    });
  });
  wrap.querySelectorAll(".member-remove").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      if (setup.members.length <= 2) return;
      const i = Number(e.currentTarget.dataset.idx);
      const removed = setup.members[i];
      setup.members.splice(i, 1);
      // Drop ownership entries pointing at the removed member.
      Object.keys(setup.ownership).forEach((team) => {
        if (setup.ownership[team] === removed.id) delete setup.ownership[team];
      });
      renderMembers();
    });
  });
}

function memberById(id) {
  return setup.members.find((m) => m.id === id) || null;
}

function renderAssignCounts() {
  const wrap = $("#assignCounts");
  wrap.innerHTML = "";
  const counts = {};
  setup.members.forEach((m) => (counts[m.id] = 0));
  let unassigned = 0;
  setup.teams.forEach((t) => {
    const owner = setup.ownership[t.name_en];
    if (owner && counts[owner] != null) counts[owner]++;
    else unassigned++;
  });
  setup.members.forEach((m) => {
    const chip = document.createElement("span");
    chip.className = "count-chip";
    chip.innerHTML = `<span class="dot" style="background:${esc(m.colour)}"></span>${esc(m.name || "—")}: ${counts[m.id]}`;
    wrap.appendChild(chip);
  });
  const uchip = document.createElement("span");
  uchip.className = "count-chip";
  uchip.innerHTML = `<span class="dot" style="background:var(--muted-2)"></span>Unassigned: ${unassigned}`;
  wrap.appendChild(uchip);
}

function renderTeamAssign() {
  if (!setup.teams.length) return; // error message already shown
  const wrap = $("#teamAssign");
  const optionsFor = (selected) => {
    let html = `<option value="">Unassigned</option>`;
    setup.members.forEach((m) => {
      html += `<option value="${esc(m.id)}"${selected === m.id ? " selected" : ""}>${esc(m.name || "—")}</option>`;
    });
    return html;
  };
  const grid = document.createElement("div");
  grid.className = "team-assign-grid";
  setup.teams.forEach((t) => {
    const owner = setup.ownership[t.name_en] || "";
    const oc = owner && memberById(owner) ? memberById(owner).colour : "transparent";
    const row = document.createElement("div");
    row.className = "team-assign-row";
    row.style.setProperty("--oc", oc);
    row.innerHTML = `
      ${t.flag ? `<img src="${esc(t.flag)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span style="width:26px"></span>`}
      <span class="tname">${esc(t.name_en)}</span>
      <select data-team="${esc(t.name_en)}">${optionsFor(owner)}</select>`;
    grid.appendChild(row);
  });
  wrap.innerHTML = "";
  wrap.appendChild(grid);

  grid.querySelectorAll("select").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const team = e.target.dataset.team;
      const val = e.target.value;
      if (val) setup.ownership[team] = val;
      else delete setup.ownership[team];
      const m = val ? memberById(val) : null;
      e.target.closest(".team-assign-row").style.setProperty("--oc", m ? m.colour : "transparent");
      renderAssignCounts();
    });
  });
  renderAssignCounts();
}

function renderReview() {
  const wrap = $("#reviewContent");
  const teamsByMember = {};
  setup.members.forEach((m) => (teamsByMember[m.id] = []));
  setup.teams.forEach((t) => {
    const owner = setup.ownership[t.name_en];
    if (owner && teamsByMember[owner]) teamsByMember[owner].push(t);
  });
  const totalAssigned = Object.values(teamsByMember).reduce((n, a) => n + a.length, 0);

  let html = `
    <div class="review-block">
      <h3>Tournament</h3>
      <div style="font-weight:700;font-size:1.1rem">${esc(setup.tournamentName || "—")}</div>
      ${setup.subtitle ? `<div style="color:var(--muted)">${esc(setup.subtitle)}</div>` : ""}
    </div>
    <div class="review-block">
      <h3>${setup.members.length} Members · ${totalAssigned} teams assigned</h3>
      <div class="review-members">`;
  setup.members.forEach((m) => {
    const teams = teamsByMember[m.id] || [];
    html += `
      <div class="review-member" style="--mc:${esc(m.colour)}">
        <div class="rm-head"><span class="dot"></span>${esc(m.name || "—")}
          <span style="color:var(--muted-2);font-weight:500;font-size:.85rem">· ${teams.length} team${teams.length === 1 ? "" : "s"}</span>
        </div>
        <div class="rm-teams">
          ${teams.length
            ? teams.map((t) => `<span class="rm-team">${t.flag ? `<img src="${esc(t.flag)}" alt="">` : ""}${esc(t.name_en)}</span>`).join("")
            : `<span style="color:var(--muted-2);font-size:.85rem">No teams yet</span>`}
        </div>
      </div>`;
  });
  html += `</div></div>`;
  wrap.innerHTML = html;
}

/* ---------- Step flow ---------- */
function syncStep1FromInputs() {
  setup.tournamentName = $("#tournamentName").value.trim();
  setup.subtitle = $("#subtitle").value.trim();
}

function validateStep(step) {
  if (step === 1) {
    syncStep1FromInputs();
    if (!setup.tournamentName) return "Please give your sweepstake a name.";
  }
  if (step === 2) {
    if (setup.members.length < 2) return "You need at least two members.";
    if (setup.members.some((m) => !m.name.trim())) return "Every member needs a name.";
    const names = setup.members.map((m) => m.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) return "Member names must be unique.";
  }
  return null;
}

async function goToStep(step) {
  showError("");
  setup.step = Math.max(1, Math.min(setup.maxStep, step));
  renderStepper();
  renderPanels();

  if (setup.step === 1) {
    $("#tournamentName").value = setup.tournamentName;
    $("#subtitle").value = setup.subtitle;
  }
  if (setup.step === 2) renderMembers();
  if (setup.step === 3) {
    $("#teamAssign").innerHTML = `<div class="loading-teams"><i class="bi bi-hourglass-split"></i> Loading teams…</div>`;
    await loadTeams();
    renderTeamAssign();
  }
  if (setup.step === 4) renderReview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function next() {
  const err = validateStep(setup.step);
  if (err) { showError(err); return; }
  goToStep(setup.step + 1);
}

function back() {
  goToStep(setup.step - 1);
}

/* ---------- Random draw ---------- */
function randomDraw() {
  if (!setup.teams.length) { toast("No teams to draw yet", true); return; }
  const ids = setup.members.map((m) => m.id);
  if (ids.length < 2) { toast("Add members first", true); return; }
  // Fisher-Yates shuffle a copy of the teams.
  const shuffled = setup.teams.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Deal round-robin so counts differ by at most one.
  setup.ownership = {};
  shuffled.forEach((t, i) => {
    setup.ownership[t.name_en] = ids[i % ids.length];
  });
  renderTeamAssign();
  toast("Teams drawn!");
}

function clearAssignments() {
  setup.ownership = {};
  renderTeamAssign();
}

/* ---------- Save ---------- */
async function save() {
  // Re-validate every step before committing.
  for (let s = 1; s <= 2; s++) {
    const err = validateStep(s);
    if (err) { showError(err); goToStep(s); return; }
  }
  const payload = {
    tournamentName: setup.tournamentName,
    subtitle: setup.subtitle,
    members: setup.members.map((m) => ({
      id: m.id,
      name: m.name.trim(),
      colour: m.colour,
      text: readableTextColour(m.colour),
      accent: lightenColour(m.colour, 0.18),
    })),
    ownership: setup.ownership,
  };

  const btn = $("#saveBtn");
  btn.disabled = true;
  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed");
    toast("Saved! Launching dashboard…");
    setTimeout(() => window.location.href = "index.html", 700);
  } catch (err) {
    showError(err.message || "Could not save configuration.");
    btn.disabled = false;
  }
}

/* ---------- Import / export / reset ---------- */
function exportConfig() {
  syncStep1FromInputs();
  const payload = {
    tournamentName: setup.tournamentName,
    subtitle: setup.subtitle,
    members: setup.members.map((m) => ({
      id: m.id, name: m.name.trim(), colour: m.colour,
      text: readableTextColour(m.colour), accent: lightenColour(m.colour, 0.18),
    })),
    ownership: setup.ownership,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "sweepstake-config.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importConfig(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.members)) throw new Error("Invalid config file");
      setup.tournamentName = data.tournamentName || "";
      setup.subtitle = data.subtitle || "";
      setup.members = data.members.map((m) => ({
        id: m.id || newMemberId(),
        name: m.name || "",
        colour: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(m.colour || "") ? m.colour : PALETTE[0],
      }));
      setup.members.forEach((m) => {
        const n = parseInt(String(m.id).replace(/\D/g, ""), 10);
        if (!Number.isNaN(n) && n > setup.memberSeq) setup.memberSeq = n;
      });
      setup.ownership = { ...(data.ownership || {}) };
      toast("Config imported");
      goToStep(1);
    } catch (err) {
      toast("Couldn't read that file", true);
    }
  };
  reader.readAsText(file);
}

async function resetAll() {
  if (!confirm("Start over? This deletes the saved sweepstake configuration.")) return;
  try {
    await fetch("/api/config", { method: "DELETE" });
  } catch (err) { /* ignore */ }
  window.location.href = "welcome.html";
}

/* ---------- Init ---------- */
function bindEvents() {
  $("#nextBtn").addEventListener("click", next);
  $("#backBtn").addEventListener("click", back);
  $("#saveBtn").addEventListener("click", save);
  $("#addMemberBtn").addEventListener("click", () => {
    const used = new Set(setup.members.map((m) => m.colour.toLowerCase()));
    const colour = PALETTE.find((c) => !used.has(c.toLowerCase())) || PALETTE[setup.members.length % PALETTE.length];
    setup.members.push({ id: newMemberId(), name: "", colour });
    renderMembers();
  });
  $("#drawBtn").addEventListener("click", randomDraw);
  $("#clearAssignBtn").addEventListener("click", clearAssignments);
  $("#exportBtn").addEventListener("click", exportConfig);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", (e) => {
    if (e.target.files[0]) importConfig(e.target.files[0]);
    e.target.value = "";
  });
  $("#resetBtn").addEventListener("click", resetAll);
}

async function init() {
  bindEvents();
  await loadExisting();
  goToStep(1);
  // Pre-fetch teams in the background so step 3 is instant.
  loadTeams();
}

document.addEventListener("DOMContentLoaded", init);
