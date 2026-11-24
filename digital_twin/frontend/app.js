/* Chiller FaultGuard v13.0 — Clean Cooling Tower Digital Twin, Quan HGB, Causal DAG, EVN TOU, Field Camera Feed & Air-Gapped RCA
   100% Offline · Zero CDN · Exact Streaming Parity + Causal DAG + EVN Break-Even + Clean Field Camera Extraction */

let isPlaying = false;
let isStepping = false;
let playTimer = null;
let pidSvgRoot = null;
let latestSnap = null;
let latestHw = null;
let hwLoadingPromise = null;
let latestUploadedB64 = null;
let activeTabId = "overview";
const dirtyTabs = { overview: true, trends: true, quantify: true, derisk: true, hardware: true };
let activeHwVisionMode = "fill_strainer";
let lastTimelineScenario = null;
let activeStoryBeat = null;
let tab3BasisMode = "live"; // "live" = auto-triggered from real alert telemetry; "manual" = static What-If template
let tab2PowerMode = "delta"; // "delta" = signed excess ΔkW* around 0; "total" = full 14-Ch kW
let lastBenchRenderKey = "";
let lastRecallRenderKey = "";
let lastCondRenderKey = "";
let step3ViewMode = "dag";  // "dag" = 8-node Causal Root-Cause DAG; "cards" = 4 competing-cause cards
let rcaOpen = false;
let rcaBusy = false;
let lastRcaRequest = { preset: "why_alert", query: "" };
let lastRcaSnapKey = "";
let latestRcaResp = null;
let selectedToolIdx = null;
let reqChain = Promise.resolve();

const auditErrors = [];
window.addEventListener("error", e => auditErrors.push(`JS error: ${e.message}`));
window.addEventListener("unhandledrejection", e => auditErrors.push(`Promise rejection: ${e.reason}`));

function updateAuditHook() {
  const activeTabEl = document.querySelector(".tab-pane.active");
  const livePm = latestSnap && latestSnap.electricity && latestSnap.electricity.live_alert_projection
    ? latestSnap.electricity.live_alert_projection.pm_optimizer
    : null;
  const activeVm = latestHw && latestHw.vision_modes ? latestHw.vision_modes[activeHwVisionMode] : null;
  const payload = {
    errors: auditErrors,
    theme: currentTheme(),
    activeTab: activeTabEl ? activeTabEl.id : "none",
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    overflowY: document.documentElement.scrollHeight - window.innerHeight,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    scenario: latestSnap ? latestSnap.scenario : null,
    status: latestSnap ? latestSnap.status : null,
    ood_flag: latestSnap ? Boolean(latestSnap.prediction && latestSnap.prediction.ood_flag) : false,
    step3View: step3ViewMode,
    dagRoot: latestSnap && latestSnap.causal_graph ? latestSnap.causal_graph.isolated_root_id : null,
    pmVerdict: livePm ? livePm.verdict : null,
    rcaOpen,
    rcaReady: Boolean(latestRcaResp),
    hwPreset: latestHw ? latestHw.active_preset : null,
    hwMode: activeHwVisionMode,
    hwVerdict: activeVm ? activeVm.verdict : null,
    hwCalibrated: Boolean(latestHw && latestHw.calibration_status && latestHw.calibration_status.calibrated),
    hwArucoLocked: Boolean(activeVm && activeVm.aruco_locked),
    hwPartsCount: (latestHw && latestHw.cad_bom && latestHw.cad_bom.parts_count) || (latestHw && latestHw.cad_summary && latestHw.cad_summary.parts_count) || null,
  };
  window.__AUDIT__ = payload;
  if (document.body) document.body.dataset.auditJson = JSON.stringify(payload);
}

function escapeHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const fieldChecks = [
  { id: "nozzles", title: "Spray Deck & Nozzles", hint: "Check uniform water distribution", state: "pending", source: "", detail: "" },
  { id: "fan", title: "CT-1 Fan / Belt / VFD", hint: "Check vibration, belt & VFD current", state: "pending", source: "", detail: "" },
  { id: "fill", title: "Strainers & Fill Media", hint: "Inspect scale / biofilm buildup", state: "pending", source: "", detail: "" },
  { id: "water", title: "Water Treatment & CoC", hint: "Verify biocide log & conductivity", state: "pending", source: "", detail: "" },
];

function resetFieldChecks() {
  fieldChecks.forEach(fc => {
    fc.state = "pending";
    fc.source = "";
    fc.detail = "";
  });
}

function syncFieldChecksFromBackend(raw) {
  if (!raw || (typeof raw === "object" && raw.applied === false)) return;
  const itemsObj = (raw && typeof raw === "object" && raw.items && typeof raw.items === "object")
    ? raw.items
    : raw;
  const keyAliases = {
    nozzles: ["nozzles", "spray_nozzles", "spray_flow"],
    fan: ["fan", "fan_belt", "acoustic_tach"],
    fill: ["fill", "fill_media", "fill_strainer"],
    water: ["water", "water_chem", "basin_water"],
  };
  const normState = v => {
    const s = String(v || "").toLowerCase();
    if (s === "ok" || s === "pass" || s === "clean") return "ok";
    if (s.includes("issue") || s === "fault" || s === "warn" || s === "fail") return "issue";
    return "pending";
  };
  if (Array.isArray(itemsObj)) {
    itemsObj.forEach(entry => {
      if (!entry || !entry.id) return;
      const eid = String(entry.id).toLowerCase();
      const target = fieldChecks.find(fc => (keyAliases[fc.id] || [fc.id]).includes(eid));
      if (!target) return;
      if (entry.state !== undefined || entry.status !== undefined) {
        target.state = normState(entry.state ?? entry.status);
      }
      if (entry.source) target.source = String(entry.source);
      if (entry.metric || entry.finding || entry.detail) {
        target.detail = String(entry.metric || entry.finding || entry.detail);
      }
    });
  } else if (typeof itemsObj === "object") {
    fieldChecks.forEach(fc => {
      const aliases = keyAliases[fc.id] || [fc.id];
      const matchKey = aliases.find(k => itemsObj[k] !== undefined && itemsObj[k] !== null);
      if (!matchKey) return;
      const entry = itemsObj[matchKey];
      if (typeof entry === "string") {
        fc.state = normState(entry);
      } else if (typeof entry === "object") {
        fc.state = normState(entry.state ?? entry.status);
        if (entry.source) fc.source = String(entry.source);
        if (entry.metric || entry.finding || entry.detail || entry.summary) {
          fc.detail = entry.metric
            ? `${entry.metric} (${entry.verdict || entry.status || ""})`
            : String(entry.finding || entry.detail || entry.summary);
        }
      }
    });
  }
}

async function apiJson(url, method = "GET", body = null) {
  const opts = { method, headers: {} };
  if (body !== null) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const errTxt = await resp.text();
    throw new Error(`API ${url} (${resp.status}): ${errTxt}`);
  }
  return await resp.json();
}

function enqueue(fn) {
  reqChain = reqChain.then(fn).catch(err => {
    const el = document.getElementById("advisory-title");
    if (el) el.textContent = err.message;
    stopPlayback();
  });
  return reqChain;
}

function fmt(val, digits = 2, suffix = "") {
  if (val === null || val === undefined || Number.isNaN(val)) return "N/A";
  return `${Number(val).toFixed(digits)}${suffix}`;
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "light";
}

function setPill(id, text, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = cls;
}

/* ==================== LIVE ANIMATED & INTERACTIVE P&ID ==================== */
function buildPidTooltipContent(key, snap) {
  if (!snap) return null;
  const s = snap.signals, p = snap.prediction;
  const aiStr = p.ai_score !== null && p.ai_score !== undefined ? p.ai_score.toFixed(3) : "ABSTAIN";
  const lagChKw = Math.max(0, (s.p_chillers_kw || 0) - (s.p_ch1_kw || 0));
  const map = {
    ct1: {
      title: "CT-1 · Monitored Cooling Tower Fill",
      val: `Status: ${snap.status} | HGB: ${aiStr} | Fan: ${fmt(s.fan_pct, 1, "%")}`,
      role: "Primary monitored tower in Quan frozen HGB (6 native LBNL inputs; binary suspicion).",
    },
    ct2: {
      title: "CT-2..3 · Redundant / Lag Cooling Cells",
      val: `Active Towers: ${s.n_towers_on} ON | Total CT Fans: ${fmt(s.p_ct_fans_kw, 1, " kW")}`,
      role: "N+1 cell enabling planned CT-1 isolation without unplanned fab stop.",
    },
    ch1: {
      title: "CH-1 · Lead Centrifugal Chiller",
      val: `WI-CH1: ${fmt(s.p_ch1_kw, 1, " kW")} | All Chillers: ${fmt(s.p_chillers_kw, 1, " kW")}`,
      role: "Fouled CT-1 raises condenser lift and compressor power (14-Ch boundary).",
    },
    ch2: {
      title: "CH-2..3 · Lag / Standby Chillers",
      val: `Active Chillers: ${s.n_chillers_on} ON | Lag kW: ${fmt(lagChKw, 1, " kW")}`,
      role: "Logged in 14-Ch boundary (CHL_POW_2 + CHL_POW_3).",
    },
    "plant-kw": {
      title: "WI-PLANT · 14-Channel In-Scope Electricity",
      val: `${fmt(s.plant_kw, 1, " kW")} (Δ vs Matched Normal: ${s.signed_delta_kw >= 0 ? "+" : ""}${fmt(s.signed_delta_kw, 1, " kW*")})`,
      role: "3 chillers + 3 CT fans + 3 CW pumps + 5 CHW pumps; verified savings require Pilot.",
    },
    fan: {
      title: "SI-CT1-FAN / WI-CT1 · CT-1 Fan VFD",
      val: `Speed: ${fmt(s.fan_pct, 1, "%")} | Power: ${fmt(s.p_ct1_kw, 1, " kW")}`,
      role: "HGB Feature #2/#6 and Reference Rule (>98% for 15 min).",
    },
    "cw-in": {
      title: "TI-CW-I1 · Hot Condenser Water to CT-1",
      val: `${fmt(s.tower_inlet_c, 2, " °C")} (Native CT_RW_TEMP_1)`,
      role: "HGB Feature #1 input via Water Range ΔT = T_in − T_out.",
    },
    "cw-out": {
      title: "TI-CW-O1 · Nominal CT-1 Outlet (ECWT*)",
      val: `${fmt(s.nominal_tower_outlet_c, 2, " °C*")} (Native CT_SW_TEMP_1)`,
      role: "HGB Feature #4 and 60-min flatline sensor quality gate.",
    },
    "cw-flow": {
      title: "FI-CW-1 · CT-1 Condenser Water Flow",
      val: `${fmt(s.tower_flow_gpm, 1, " GPM")} (${fmt(s.tower_flow_kgs, 1, " kg/s")})`,
      role: "HGB Feature #3; operating gate ≥10 GPM (train bound 30.2–601.1 GPM).",
    },
    range: {
      title: "CT-1 Thermal Range ΔT (Approach Excluded*)",
      val: `Range ΔT: ${fmt(s.tower_range_c, 2, " °C")} | Approach: Pending Weather Audit`,
      role: "Approach excluded because raw LBNL OA_TEMP_WB > OA_TEMP in 99.3% of rows.",
    },
    twb: {
      title: "TI-OAT-WB · Outdoor Wet-Bulb (Excluded*)",
      val: "Excluded from AI (No Silent Auto-Swap)",
      role: "Raw LBNL OA_TEMP_WB > OA_TEMP in 99.31% of rows — withheld honestly.",
    },
    "chw-sup": {
      title: "TI-CHW-S · Nominal CHW Supply*",
      val: `${fmt(s.nominal_chw_supply_c, 2, " °C*")} (Mapping Pending Verification)`,
      role: "Display context only (not in HGB); fab cooling limits belong to Pilot.",
    },
    "chw-ret": {
      title: "TI-CHW-R · Primary CHW Return*",
      val: `${fmt(s.pri_chw_ret_c, 2, " °C*")} | Logged Load*: ${fmt(s.logged_load_kw, 1, " kW*")}`,
      role: "Secondary load is HGB Feature #5; CHW temp mapping pending validation.",
    },
    "chw-flow": {
      title: "FI-CHW · Primary CHW Flow",
      val: `${fmt(s.pri_chw_flow_gpm, 1, " GPM")}`,
      role: "Published LBNL context; 5 CHW pumps included in 14-Ch power.",
    },
    phe: {
      title: "PHE-01 · Out-of-Scope Fab Thermal Interface",
      val: "Boundary Separator (CUB CHW ↔ Fab PCW)",
      role: "Out of electricity scope; FaultGuard is read-only on CUB telemetry.",
    },
    fab: {
      title: "Fab Tools (PCW) · Out of Scope",
      val: "SEMI S23 Context · Reserved for Site Pilot",
      role: "LBNL office replay is PoC only — never claims verified fab yield.",
    },
    guard: {
      title: "Cooling-Service & 3-Bucket Boundary",
      val: "Read-Only Advisory · Zero PLC Write-Back",
      role: "B1: LBNL F1 0.394 | B2: Illustrative 6,624 kWh | B3: Site Pilot.",
    },
  };
  return map[key] || null;
}

function initPidTooltips() {
  const wrap = document.querySelector(".pid-stage-wrap");
  const tip = document.getElementById("pid-tooltip");
  if (!wrap || !tip || !pidSvgRoot) return;
  let lastTipKey = "";
  let lastTipRow = -1;
  let lastTipStatus = "";
  pidSvgRoot.addEventListener("mousemove", evt => {
    const grp = evt.target.closest("[data-pid-tip]");
    if (!grp || !latestSnap) {
      if (lastTipKey) {
        lastTipKey = "";
        tip.classList.add("hidden");
      }
      return;
    }
    const key = grp.getAttribute("data-pid-tip") || "";
    if (key !== lastTipKey || latestSnap.row_index !== lastTipRow || latestSnap.status !== lastTipStatus) {
      const info = buildPidTooltipContent(key, latestSnap);
      if (!info) {
        lastTipKey = "";
        tip.classList.add("hidden");
        return;
      }
      tip.innerHTML = `<strong>${escapeHtml(info.title)}</strong><div class="pt-val">${escapeHtml(info.val)}</div><div class="pt-role">${escapeHtml(info.role)}</div>`;
      lastTipKey = key;
      lastTipRow = latestSnap.row_index;
      lastTipStatus = latestSnap.status;
      tip.classList.remove("hidden");
    }
    const rect = wrap.getBoundingClientRect();
    let x = evt.clientX - rect.left + 14;
    let y = evt.clientY - rect.top + 14;
    if (x + 286 > rect.width) x = Math.max(8, evt.clientX - rect.left - 292);
    if (y + 108 > rect.height) y = Math.max(8, evt.clientY - rect.top - 110);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });
  pidSvgRoot.addEventListener("mouseleave", () => {
    lastTipKey = "";
    tip.classList.add("hidden");
  });
}

async function loadInteractivePid() {
  const host = document.getElementById("pid-container");
  try {
    const resp = await fetch("/assets/chiller_plant_pid.svg?v=13.0.6");
    host.innerHTML = await resp.text();
    pidSvgRoot = host.querySelector("svg");
    applyThemeToPid();
    initPidTooltips();
    if (latestSnap) updatePidMimic(latestSnap);
  } catch (err) {
    host.textContent = `Could not load P&ID: ${err.message}`;
  }
}

function applyThemeToPid() {
  if (pidSvgRoot) pidSvgRoot.classList.toggle("theme-dark", currentTheme() === "dark");
}

function setSvgText(id, text) {
  if (!pidSvgRoot) return;
  const el = pidSvgRoot.getElementById(id);
  if (el) el.textContent = text;
}

function updatePidMimic(snap) {
  if (!pidSvgRoot) return;
  const s = snap.signals, p = snap.prediction, st = snap.status;

  setSvgText("val-chw-sup", fmt(s.nominal_chw_supply_c, 2, " °C*"));
  setSvgText("val-chw-ret", fmt(s.pri_chw_ret_c, 2, " °C*"));
  setSvgText("val-chw-flow", fmt(s.pri_chw_flow_gpm, 0, " GPM"));
  setSvgText("val-cw-in", fmt(s.tower_inlet_c, 2, " °C"));
  setSvgText("val-cw-out", fmt(s.nominal_tower_outlet_c, 2, " °C*"));
  setSvgText("val-cw-flow", fmt(s.tower_flow_gpm, 0, " GPM"));
  setSvgText("val-twb", "Excluded*");
  setSvgText("val-ct1-fan", `Fan: ${fmt(s.fan_pct, 1, "%")}`);
  setSvgText("val-ct1-kw", fmt(s.p_ct1_kw, 1, " kW"));
  setSvgText("val-ch1-kw", fmt(s.p_ch1_kw, 1, " kW"));
  const lagChKw = Math.max(0, Number(s.p_chillers_kw || 0) - Number(s.p_ch1_kw || 0));
  setSvgText("val-ch2-kw", fmt(lagChKw, 1, " kW"));
  setSvgText("val-plant-kw", fmt(s.plant_kw, 1, " kW"));
  setSvgText("val-approach", fmt(s.tower_range_c, 2, " °C"));
  const appEl = pidSvgRoot.getElementById("val-approach");
  if (appEl) appEl.setAttribute("font-size", "18");

  // Dynamic Lag Chiller / Tower Staging Visuals (mapped cleanly to LBNL n_chillers_on / n_towers_on)
  const ch2Grp = pidSvgRoot.getElementById("chiller-2");
  if (ch2Grp) ch2Grp.setAttribute("opacity", s.n_chillers_on > 1 ? "0.98" : "0.66");
  setSvgText("ch2-title", s.n_chillers_on > 1 ? `CH-2..3 (${s.n_chillers_on} ON)` : "CH-2 (STANDBY)");
  const ct2Grp = pidSvgRoot.getElementById("cooling-tower-2");
  if (ct2Grp) ct2Grp.setAttribute("opacity", s.n_towers_on > 1 ? "0.98" : "0.66");
  setSvgText("ct2-title", s.n_towers_on > 1 ? `CT-2..3 (${s.n_towers_on} ON)` : "CT-2 (STANDBY)");
  setSvgText("ct2-sub", s.n_towers_on > 1 ? "MULTI-CELL ACTIVE STAGING" : "N+1 REDUNDANT CELL");

  // Subtle Live ISA-101 Pipe Flow & CT-1 Fan Speed Motion (paused cleanly on ABSTAIN or zero flow)
  const flowStopped = st === "ABSTAIN" || Number(s.tower_flow_gpm || 0) < 10;
  pidSvgRoot.classList.toggle("flow-paused", flowStopped);
  const flowDur = Math.max(0.55, Math.min(2.6, 480 / Math.max(120, Number(s.tower_flow_gpm || 120))));
  pidSvgRoot.style.setProperty("--flow-dur", `${flowDur.toFixed(2)}s`);

  const fanStopped = st === "ABSTAIN" || !s.ct1_on || Number(s.fan_pct || 0) < 5;
  pidSvgRoot.classList.toggle("fan-paused", fanStopped);
  const fanDur = Math.max(0.28, Math.min(1.6, 38 / Math.max(20, Number(s.fan_pct || 20))));
  pidSvgRoot.style.setProperty("--fan-dur", `${fanDur.toFixed(2)}s`);

  const isDark = currentTheme() === "dark";
  const states = {
    NO_ALERT: {
      stroke: "#475569", fill: "#64748B", fillOp: "0.06", hatchOp: "0",
      pillFill: isDark ? "#1E293B" : "#F1F5F9", pillStroke: "#64748B", titleFill: isDark ? "#CBD5E1" : "#334155",
      title: "MONITORED: CT-1 FILL", label: `SCORE ${p.ai_score !== null ? p.ai_score.toFixed(3) : "--"} · NO ALERT`,
      stBg: isDark ? "#064E3B" : "#ECFDF5", stStroke: "#059669", stTextFill: isDark ? "#A7F3D0" : "#065F46",
      stText: "NO ALERT | READ-ONLY", appStroke: "#0284C7",
    },
    RULE_WARNING: {
      stroke: "#D97706", fill: "#F59E0B", fillOp: "0.22", hatchOp: "0",
      pillFill: "#FEF3C7", pillStroke: "#D97706", titleFill: "#92400E",
      title: "HIGH-FAN RULE ALERT", label: `FAN ${fmt(s.fan_pct, 1, "%")} · VERIFY I–IV`,
      stBg: isDark ? "#451A03" : "#FEF3C7", stStroke: "#D97706", stTextFill: isDark ? "#FDE68A" : "#92400E",
      stText: "RULE ALERT | READ-ONLY", appStroke: "#D97706",
    },
    FOULING_SUSPECT: {
      stroke: "#DC2626", fill: "#EF4444", fillOp: "0.26", hatchOp: "0.22",
      pillFill: "#991B1B", pillStroke: "#FCA5A5", titleFill: "#FFFFFF",
      title: "FOULING SUSPECT (CT-1)", label: `HGB ${p.ai_score !== null ? p.ai_score.toFixed(3) : "--"} · VERIFY I–VI`,
      stBg: isDark ? "#450A0A" : "#FEE2E2", stStroke: "#DC2626", stTextFill: isDark ? "#FECACA" : "#991B1B",
      stText: "FOULING SUSPECT", appStroke: "#DC2626",
    },
    ABSTAIN: {
      stroke: "#CA8A04", fill: "#FACC15", fillOp: "0.26", hatchOp: "0",
      pillFill: "#FEF08A", pillStroke: "#A16207", titleFill: "#713F12",
      title: "ABSTAIN — GATE ACTIVE", label: "CHECK SIGNAL / REGIME",
      stBg: isDark ? "#422006" : "#FEF9C3", stStroke: "#CA8A04", stTextFill: isDark ? "#FEF08A" : "#713F12",
      stText: "ABSTAIN | READ-ONLY", appStroke: "#CA8A04",
    },
  };

  const cfg = states[st] || states.NO_ALERT;
  const setAttr = (id, a, v) => { const el = pidSvgRoot.getElementById(id); if (el) el.setAttribute(a, v); };
  setAttr("ct1-fault-rect", "stroke", cfg.stroke);
  setAttr("ct1-fault-rect", "fill", cfg.fill);
  setAttr("ct1-fault-rect", "fill-opacity", cfg.fillOp);
  const fRect = pidSvgRoot.getElementById("ct1-fault-rect");
  const acked = Boolean(snap.review && snap.review.acknowledged);
  if (fRect) fRect.classList.toggle("pid-alarm-breathe", st === "FOULING_SUSPECT" && !acked);
  setAttr("ct1-fault-hatch-rect", "opacity", cfg.hatchOp);
  setAttr("ct1-fault-pill", "fill", cfg.pillFill);
  setAttr("ct1-fault-pill", "stroke", cfg.pillStroke);
  const ft = pidSvgRoot.getElementById("val-ct1-fault-title");
  if (ft) { ft.setAttribute("fill", cfg.titleFill); ft.textContent = cfg.title; }
  setSvgText("val-ct1-fault-label", cfg.label);
  setAttr("pid-status-bg", "fill", cfg.stBg);
  setAttr("pid-status-bg", "stroke", cfg.stStroke);
  setAttr("pid-status-dot", "fill", cfg.stStroke);
  const stEl = pidSvgRoot.getElementById("pid-status-text");
  if (stEl) { stEl.setAttribute("fill", cfg.stTextFill); stEl.textContent = cfg.stText; }
  setAttr("approach-box-bg", "stroke", cfg.appStroke);
}

/* ==================== TAB 4: SUPERVISOR TRIAGE WORKBENCH (I -> VI) ==================== */
function renderTriageWorkbench(snap) {
  const s = snap.signals, p = snap.prediction, rev = snap.review, abstain = snap.status === "ABSTAIN";

  // Step I: All 6 True Native HGB Inputs (Water Range ΔT, Fan VFD, Flow, Outlet*, Load*, Fan × Range)
  const c1 = document.getElementById("card-step-1");
  const sb1 = document.getElementById("sb-1");
  c1.className = `triage-card ${abstain ? "tc-fault" : "tc-ok"}`;
  sb1.className = `step-badge ${abstain ? "sb-warn" : "sb-ok"}`;
  setPill(
    "step1-status",
    p.ood_flag ? "ABSTAIN: TRAINING OOD" : (abstain ? "ABSTAIN: GATE TRIPPED" : "6/6 NATIVE INPUTS OK"),
    abstain ? "pill pill-verify" : "pill pill-ok"
  );
  const missOrFlat = snap.injection === "missing_nan" || snap.injection === "flatline_60m";
  const physRangeBad = snap.injection === "out_of_range";
  const flowBad = snap.injection === "domain_ood";
  const outVal = snap.injection === "missing_nan" ? "MISSING" : (snap.injection === "flatline_60m" ? "FLAT 60m" : escapeHtml(fmt(s.nominal_tower_outlet_c, 2, " °C*")));
  const rngVal = snap.injection === "missing_nan" ? "MISSING" : (snap.injection === "flatline_60m" ? "FLAT 60m" : escapeHtml(fmt(s.tower_range_c, 2, " °C")));
  const fanVal = physRangeBad ? "400.0 % (!)" : escapeHtml(fmt(s.fan_pct, 1, " %"));
  const flwVal = flowBad ? "750.0 GPM (!)" : escapeHtml(fmt(s.tower_flow_gpm, 0, " GPM"));
  const fxrNum = (s.tower_range_c !== null && s.tower_range_c !== undefined)
    ? ((Number(s.fan_pct || 0) / 100.0) * (Number(s.tower_range_c) * 1.8)).toFixed(2)
    : "--";
  document.getElementById("step1-metrics").innerHTML = `
    <div class="kv-box ${missOrFlat ? "kv-bad" : "kv-ok"}"><span>Range ΔT</span><strong>${rngVal}</strong></div>
    <div class="kv-box ${physRangeBad ? "kv-bad" : "kv-ok"}"><span>CT-1 Fan</span><strong>${fanVal}</strong></div>
    <div class="kv-box ${flowBad ? "kv-bad" : "kv-ok"}"><span>CT-1 Flow</span><strong>${flwVal}</strong></div>
    <div class="kv-box ${missOrFlat ? "kv-bad" : "kv-ok"}"><span>CT-1 Outlet*</span><strong>${outVal}</strong></div>
    <div class="kv-box kv-ok"><span>Cooling Load*</span><strong>${escapeHtml(fmt(s.logged_load_kw, 0, " kW*"))}</strong></div>
    <div class="kv-box ${missOrFlat || physRangeBad ? "kv-bad" : "kv-ok"}"><span>Fan × Range</span><strong>${missOrFlat ? "INVALID" : escapeHtml(String(fxrNum))}</strong></div>
  `;

  // Step II: Non-Overlapping CUB Plant Context (Staging, Return Inlet, CHW Guard, 14-Ch Power & Excess)
  setPill("step2-status", abstain ? "GATE HOLD / OFF" : `ACTIVE · ${s.n_chillers_on} CH / ${s.n_towers_on} CT`, abstain ? "pill pill-warn" : "pill pill-ok");
  const dKwStep2 = Number(s.signed_delta_kw || 0);
  const dKwStr2 = `${dKwStep2 >= 0 ? "+" : ""}${dKwStep2.toFixed(1)}*`;
  document.getElementById("step2-metrics").innerHTML = `
    <div class="kv-box ${s.ct1_on ? "kv-ok" : ""}"><span>Active Staging</span><strong>${escapeHtml(`${s.n_chillers_on} CH / ${s.n_towers_on} CT`)}</strong></div>
    <div class="kv-box"><span>CT-1 Inlet</span><strong>${escapeHtml(fmt(s.tower_inlet_c, 2, " °C"))}</strong></div>
    <div class="kv-box"><span>CHW Supply*</span><strong>${escapeHtml(fmt(s.nominal_chw_supply_c, 2, " °C*"))}</strong></div>
    <div class="kv-box"><span>14-Ch Power</span><strong>${escapeHtml(`${fmt(s.plant_kw, 1, " kW")} (${dKwStr2})`)}</strong></div>
  `;

  // Step III (Causal Root-Cause DAG + 4 Competing-Cause Cards toggle)
  const hyps = snap.hypotheses || [];
  const ruledN = hyps.filter(h => h.status === "RULED_OUT").length;
  const prim = hyps.find(h => h.status === "PRIMARY_SUSPECT");
  const cg = snap.causal_graph || null;
  let s3Txt = "NO PERSISTENT ALERT";
  let s3Cls = "pill pill-ok";
  if (abstain) {
    s3Txt = "ABSTAIN: N3 GATE BLOCK";
    s3Cls = "pill pill-verify";
  } else if (cg && cg.isolated_root_id && cg.isolated_root_id !== "NONE") {
    s3Txt = cg.isolated_root_id === "N2" ? "ROOT: N2 CW FLOW" : `ROOT: ${cg.isolated_root_id} FILL FOULING`;
    s3Cls = cg.isolated_root_id === "N2" ? "pill pill-warn" : "pill pill-fault";
  } else if (prim) {
    s3Txt = `${ruledN} RULED OUT · ${prim.id} SUSPECT`;
    s3Cls = "pill pill-fault";
  }
  setPill("step3-status", s3Txt, s3Cls);

  const rcLbl = { PRIMARY_SUSPECT: "LIKELY CAUSE", CHECK_REQUIRED: "VERIFY", RULED_OUT: "RULED OUT", MONITORING: "MONITOR" };
  document.getElementById("step3-hypotheses").innerHTML = hyps.map(h => `
    <div class="hyp-pill hp-${escapeHtml(h.status)}">
      <div class="hyp-top"><span>${escapeHtml(h.id)} · ${escapeHtml(h.name)}</span><span class="rc-tag rc-${escapeHtml(h.status)}">${escapeHtml(rcLbl[h.status] || h.status)}</span></div>
      <div class="hyp-ev">${escapeHtml(h.evidence)}</div>
    </div>
  `).join("");

  const dagHost = document.getElementById("step3-dag-host");
  const hypHost = document.getElementById("step3-hypotheses");
  if (dagHost && hypHost) {
    dagHost.classList.toggle("hidden", step3ViewMode !== "dag");
    hypHost.classList.toggle("hidden", step3ViewMode !== "cards");
    document.querySelectorAll("#dag-view-toggle .dt-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.view === step3ViewMode);
    });
    if (step3ViewMode === "dag" && typeof window.drawCausalDagSvg === "function") {
      window.drawCausalDagSvg(dagHost, cg, node => {
        openRcaDrawer({
          preset: null,
          query: `Explain causal node ${node.id} (${node.short}) and its current evidence`,
        });
      });
    }
  }

  // Step IV (Single delegated listener attached in DOMContentLoaded — zero rebind leak)
  const loggedN = fieldChecks.filter(fc => fc.state !== "pending").length;
  const issues = fieldChecks.filter(fc => fc.state === "issue");
  const camN = fieldChecks.filter(fc => fc.source && fc.source.toLowerCase().includes("cam")).length;
  document.getElementById("step4-status").textContent = camN > 0
    ? `${loggedN} / 4 Logged · ${camN} Cam · ${issues.length} Issue(s)`
    : `${loggedN} / 4 Logged · ${issues.length} Issue(s)`;
  const stateLabel = { pending: "Pending", ok: "✓ OK", issue: "⚠ Issue" };
  document.getElementById("step4-checklist").innerHTML = fieldChecks.map(fc => {
    const baseHint = fc.id === "fan" ? `CT-1 Fan ${fmt(s.fan_pct, 1, "%")} · check belt/blades/VFD` : fc.hint;
    const hint = fc.detail || baseHint;
    const srcCls = fc.source
      ? (fc.source.toLowerCase().includes("manual") ? "src-manual" : "")
      : "";
    const srcTag = fc.source ? `<span class="field-src-badge ${srcCls}">${escapeHtml(fc.source)}</span>` : "";
    return `
      <div class="field-row" title="${escapeHtml(hint)}">
        <div class="field-info"><strong><span>${escapeHtml(fc.title)}</span>${srcTag}</strong><small>${escapeHtml(hint)}</small></div>
        <button class="field-toggle ft-${escapeHtml(fc.state)}" data-field-id="${escapeHtml(fc.id)}">${stateLabel[fc.state]}</button>
      </div>
    `;
  }).join("");

  // Step V (Interlocked on ABSTAIN and gated on active AI/Rule alert —including False Alarm & Inconclusive!)
  const hasAlert = snap.status === "FOULING_SUSPECT" || snap.status === "RULE_WARNING";
  const aiScoreTxt = p.ai_score !== null && p.ai_score !== undefined ? Number(p.ai_score).toFixed(3) : "N/A";
  document.getElementById("interlock-box").classList.toggle("hidden", !abstain);
  const btnConf = document.getElementById("btn-v-confirmed");
  const btnFa = document.getElementById("btn-v-fa");
  const btnInc = document.getElementById("btn-v-inc");
  const verdictLocked = abstain || !hasAlert;
  btnConf.disabled = verdictLocked;
  if (btnFa) btnFa.disabled = verdictLocked;
  if (btnInc) btnInc.disabled = verdictLocked;
  const lockReason = abstain
    ? "Locked by Step I safety interlock (ABSTAIN)"
    : "Requires an active AI or High-Fan Rule alert (currently NO ALERT)";
  btnConf.title = verdictLocked ? lockReason : "Log Confirmed Fouling verdict to unlock Step VI draft brief";
  if (btnFa) btnFa.title = verdictLocked ? lockReason : "Log False Alarm feedback (no PM dispatched)";
  if (btnInc) btnInc.title = verdictLocked ? lockReason : "Place CT-1 under 24h observation watch";

  const vBadge = document.getElementById("step5-badge");
  if (abstain) {
    vBadge.textContent = "LOCKED (ABSTAIN)";
    vBadge.className = "pill pill-verify";
  } else if (rev.acknowledged) {
    vBadge.textContent = `LOGGED: ${rev.verdict}`;
    vBadge.className = rev.verdict === "CONFIRMED" ? "pill pill-ok" : rev.verdict === "FALSE_ALARM" ? "pill pill-fault" : "pill pill-warn";
  } else if (!hasAlert) {
    vBadge.textContent = "MONITORING · NO ALERT";
    vBadge.className = "tag-subtle";
  } else {
    vBadge.textContent = "AWAITING REVIEW";
    vBadge.className = "tag-subtle";
  }

  const issueNames = issues.map(i => i.title).join(", ");
  const topSens = (p.feature_sensitivity && p.feature_sensitivity.length)
    ? `${p.feature_sensitivity[0].label} (${p.feature_sensitivity[0].delta_score >= 0 ? "+" : ""}${p.feature_sensitivity[0].delta_score.toFixed(3)})`
    : "6 native inputs";
  document.getElementById("step5-summary").innerHTML = abstain
    ? "<strong>Blocked:</strong> Resolve Step I gate first (local advisory only)."
    : (!hasAlert
        ? `<strong>No Active Alert:</strong> HGB ${escapeHtml(aiScoreTxt)} · Fan ${escapeHtml(fmt(s.fan_pct, 1, "%"))} — switch to 0.80/0.65 UA or click <strong>Next Alert</strong>.`
        : (issues.length
            ? `<strong>Ready:</strong> HGB ${escapeHtml(aiScoreTxt)} · Driver: ${escapeHtml(topSens)} · Issue: <strong>${escapeHtml(issueNames)}</strong>.`
            : `<strong>Alert Active:</strong> HGB ${escapeHtml(aiScoreTxt)} · Fan ${escapeHtml(fmt(s.fan_pct, 1, "%"))} — verify Step IV, then log verdict.`));

  // Step VI
  const s6Card = document.getElementById("step6-card");
  const s6Badge = document.getElementById("step6-badge");
  const s6Body = document.getElementById("step6-body");
  if (abstain) {
    s6Card.className = "card wo-card wo-locked";
    s6Badge.textContent = "LOCKED (ABSTAIN)";
    s6Badge.className = "pill pill-verify";
    s6Body.innerHTML = `<div class="wo-placeholder">🔒 <strong>Locked:</strong> Clear Step I ABSTAIN gate before drafting brief.</div>`;
  } else if (rev.acknowledged && rev.verdict === "CONFIRMED") {
    s6Card.className = "card wo-card wo-confirmed";
    s6Badge.textContent = "WO DRAFT READY";
    s6Badge.className = "pill pill-ok";
    const woId = `WO-CT1-${snap.timestamp.slice(5, 10).replace("-", "")}`;
    const fieldTxt = issueNames || "Spray deck / fill media inspection verified";
    s6Body.innerHTML = `
      <div class="wo-grid">
        <div class="wo-kv"><span>Draft ID / Asset</span><strong>${escapeHtml(woId)} · CT-1</strong></div>
        <div class="wo-kv"><span>Isolation Window</span><strong>N+1 Staging (Zero Unplanned Stop)</strong></div>
        <div class="wo-kv"><span>Evidence (I–IV)</span><strong>HGB ${escapeHtml(aiScoreTxt)} (${p.ai_run_minutes}/5m) · Fan ${escapeHtml(fmt(s.fan_pct, 1, "%"))} · ${escapeHtml(fieldTxt)}</strong></div>
        <div class="wo-kv"><span>Power / Savings</span><strong>${escapeHtml(fmt(s.plant_kw, 1, " kW"))} · Savings Pending Pilot</strong></div>
      </div>
      <div class="wo-foot">
        <span class="wo-note">Read-Only Draft · Human Sign-Off Required</span>
        <div class="wo-actions">
          <button id="btn-copy-wo" class="btn-copy-wo">📋 Copy</button>
          <button id="btn-export-md" class="btn-export-wo" title="Download offline Markdown brief">⬇ .md</button>
          <button id="btn-export-json" class="btn-export-wo" title="Download offline JSON audit record">⬇ .json</button>
        </div>
      </div>
    `;
    const copyBtn = document.getElementById("btn-copy-wo");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const text = `[${woId}] CT-1 Maintenance Brief | Engineer: ${rev.engineer_name || "Supervisor"} | Evidence: Quan HGB score=${aiScoreTxt} (${p.ai_run_minutes}/5m), Fan=${fmt(s.fan_pct, 1, "%")}, Field=${fieldTxt} | Note: ${rev.note || ""} | Read-Only Advisory Draft (Zero PLC Write)`;
        navigator.clipboard?.writeText(text).catch(() => {});
        copyBtn.textContent = "✓ Copied";
      });
    }
    const dlFile = (filename, content, mime) => {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const mdBtn = document.getElementById("btn-export-md");
    if (mdBtn) {
      mdBtn.addEventListener("click", () => {
        const sensLines = (p.feature_sensitivity || []).map(f => `- ${f.label} (${f.current_value}): ${f.delta_score >= 0 ? "+" : ""}${f.delta_score.toFixed(4)} Δscore`).join("\n");
        const md = [
          `# ${woId} — Chiller FaultGuard Maintenance Action Brief (Advisory Draft)`,
          ``,
          `- **Timestamp (LBNL Replay):** ${snap.timestamp} (Case: ${snap.case_meta.label})`,
          `- **Asset:** Cooling Tower 1 (CT-1) · Coordinate N+1 Staging (Zero Unplanned Stop)`,
          `- **Frozen AI Engine:** Quan HistGradientBoostingClassifier (SHA256 \`${p.model_sha256}\`)`,
          `- **Score / Persistence:** ${aiScoreTxt} (uncalibrated; ${p.ai_run_minutes}/${p.ai_required_minutes}m) | High-Fan Rule: ${fmt(s.fan_pct, 1, "%")} (${p.rule_run_minutes}/${p.rule_required_minutes}m)`,
          `- **14-Ch Logged Plant Power:** ${fmt(s.plant_kw, 1, " kW")} (Verified excess/avoided kWh & water savings: Pending Site Pilot)`,
          `- **Step IV Field Checks:** ${fieldTxt}`,
          `- **Step V Verdict:** ${rev.verdict} by ${rev.engineer_name || "Supervisor"}`,
          `- **Supervisor Note:** ${rev.note || "N/A"}`,
          ``,
          `## Local Feature Sensitivity (1-at-a-Time vs Train Mean — Not SHAP)`,
          sensLines || "- N/A",
          ``,
          `> **Governance Disclaimer:** Local Read-Only Advisory Draft Only (\`read_only=true\`, \`controls=false\`). Zero automated PLC/BMS write-back. Requires human facilities engineering sign-off.`,
        ].join("\n");
        dlFile(`${woId}_brief.md`, md, "text/markdown;charset=utf-8");
      });
    }
    const jsonBtn = document.getElementById("btn-export-json");
    if (jsonBtn) {
      jsonBtn.addEventListener("click", () => {
        const payload = {
          brief_id: woId,
          asset: "CT-1",
          read_only: true,
          controls: false,
          review_note_is_approval: false,
          timestamp: snap.timestamp,
          case: snap.case,
          model_sha256: p.model_sha256,
          ai_score: p.ai_score,
          score_is_calibrated_probability: false,
          ai_run_minutes: p.ai_run_minutes,
          rule_run_minutes: p.rule_run_minutes,
          signals: s,
          field_checks: fieldChecks,
          review: rev,
          verified_excess_kwh: null,
          verified_avoided_kwh: null,
          water_savings: null,
        };
        dlFile(`${woId}_audit.json`, JSON.stringify(payload, null, 2), "application/json;charset=utf-8");
      });
    }
  } else if (rev.acknowledged && rev.verdict === "FALSE_ALARM") {
    s6Card.className = "card wo-card wo-false";
    s6Badge.textContent = "NO PM DISPATCHED";
    s6Badge.className = "pill pill-ok";
    s6Body.innerHTML = `<div class="wo-placeholder"><strong>False Alarm Logged</strong> (${escapeHtml(snap.timestamp.slice(11, 16))}) · Zero PM drafted.</div>`;
  } else if (rev.acknowledged && rev.verdict === "INCONCLUSIVE") {
    s6Card.className = "card wo-card wo-inc";
    s6Badge.textContent = "24H WATCH ACTIVE";
    s6Badge.className = "pill pill-warn";
    s6Body.innerHTML = `<div class="wo-placeholder"><strong>Inconclusive:</strong> Continue read-only monitoring (24h watch).</div>`;
  } else {
    s6Card.className = "card wo-card wo-locked";
    s6Badge.textContent = "LOCKED UNTIL STEP V";
    s6Badge.className = "tag-subtle";
    s6Body.innerHTML = `<div class="wo-placeholder">Locked until Step V <strong>Confirmed</strong> verdict (Read-only · zero PLC write).</div>`;
  }
}

/* ==================== MAIN RENDER ==================== */
function renderSnapshot(snap) {
  latestSnap = snap;
  const s = snap.signals, p = snap.prediction, e = snap.electricity, m = snap.metrics, rev = snap.review;
  const abstain = snap.status === "ABSTAIN";

  // Top Bar
  const clk = document.getElementById("badge-clock");
  clk.textContent = snap.timestamp.slice(11, 16);
  clk.title = `${snap.timestamp} · Row ${snap.row_index + 1}/${snap.total_rows}`;
  document.getElementById("row-counter-tag").textContent = `#${snap.row_index + 1} / ${snap.total_rows}`;
  const srcEl = document.getElementById("pid-source-tag");
  if (srcEl) {
    srcEl.textContent = `${snap.case_meta.label} · ${snap.timestamp.slice(5, 10)}`;
    srcEl.title = `${snap.case_meta.csv} · ${snap.timestamp.slice(0, 10)}`;
  }

  document.querySelectorAll("#scenario-buttons .seg-btn").forEach(b => b.classList.toggle("active", b.dataset.scenario === snap.scenario));
  document.querySelectorAll("#fault-buttons .g-btn").forEach(b => b.classList.toggle("active", b.dataset.fault === snap.injection));

  // Override Banner & stress-safe jump button visibility
  const vBanner = document.getElementById("verification-banner");
  const stressActive = snap.injection && snap.injection !== "none";
  const btnJumpAlert = document.getElementById("btn-jump-alert");
  if (btnJumpAlert) {
    btnJumpAlert.disabled = stressActive;
    btnJumpAlert.title = stressActive
      ? "Clear active synthetic stress test before jumping replay"
      : "Process intermediate rows to next persistent AI alert (5/5m)";
  }
  if (abstain) {
    vBanner.classList.remove("hidden");
    document.getElementById("verify-reason").textContent = `${(p.reasons || []).join(" ")} Step V–VI confirmation locked safely.`;
    document.getElementById("btn-jump-eligible").classList.toggle("hidden", stressActive);
    document.getElementById("btn-clear-fault-banner").classList.toggle("hidden", !stressActive);
  } else {
    vBanner.classList.add("hidden");
  }

  // ---- TAB 1 (ISA-101 Redundant Coding: Color + Shape/Icon + Explicit Text) ----
  dirtyTabs.overview = true;
  dirtyTabs.trends = true;
  dirtyTabs.quantify = true;
  dirtyTabs.derisk = true;

  const activePane = document.querySelector(".tab-pane.active");
  if (activePane && activePane.id && activePane.id.startsWith("tab-")) {
    activeTabId = activePane.id.slice(4);
  }

  const aStrip = document.getElementById("advisory-strip");
  aStrip.className = "action-bar " + (snap.status === "FOULING_SUSPECT" ? "bar-fault" : abstain ? "bar-verify" : snap.status === "RULE_WARNING" ? "bar-suspect" : "bar-normal");
  document.getElementById("advisory-equip").textContent = snap.status === "FOULING_SUSPECT" ? "CT-1 · REVIEW" : "CT-1";
  document.getElementById("advisory-title").textContent = snap.at_end
    ? "End of 24h Oct-01 fixture — reset or switch case."
    : snap.advisory_title;
  const ackB = document.getElementById("advisory-ack-badge");
  if (rev.acknowledged) { ackB.classList.remove("hidden"); ackB.textContent = `✓ ${rev.verdict}`; } else { ackB.classList.add("hidden"); }

  if (snap.field_checks && snap.field_checks.applied) {
    syncFieldChecksFromBackend(snap.field_checks);
  }
  if (latestHw && snap.hardware_summary && snap.hardware_summary.active_preset && latestHw.active_preset !== snap.hardware_summary.active_preset) {
    latestHw = null;
    dirtyTabs.hardware = true;
  }

  renderActiveTab(snap);

  if (snap.at_end) stopPlayback();
  updateAuditHook();
}

function renderActiveTab(snap) {
  if (!snap) return;
  if (activeTabId === "overview") {
    renderTabOverview(snap);
    dirtyTabs.overview = false;
  } else if (activeTabId === "trends") {
    renderTabTrends(snap);
    dirtyTabs.trends = false;
  } else if (activeTabId === "quantify") {
    renderTabQuantify(snap);
    dirtyTabs.quantify = false;
  } else if (activeTabId === "derisk") {
    renderTabDerisk(snap);
    dirtyTabs.derisk = false;
  } else if (activeTabId === "hardware") {
    if (latestHw && dirtyTabs.hardware) {
      renderHardwareTab(latestHw, { keepMode: true });
      dirtyTabs.hardware = false;
    } else if (!latestHw) {
      loadHardwareStatus({ keepMode: false });
    }
  }
}

function renderTabOverview(snap) {
  const s = snap.signals, p = snap.prediction, abstain = snap.status === "ABSTAIN";
  const stPillMap = {
    NO_ALERT: ["✓ NO ALERT", "pill pill-ok"],
    RULE_WARNING: ["▲ RULE ALERT", "pill pill-warn"],
    FOULING_SUSPECT: ["⚠ FOULING SUSPECT", "pill pill-fault"],
    ABSTAIN: ["🔒 ABSTAIN", "pill pill-verify"],
  };
  const [stTxt, stCls] = stPillMap[snap.status] || ["✓ NO ALERT", "pill pill-ok"];
  setPill("overall-status-pill", stTxt, stCls);
  setPill("phys-state-pill", abstain ? "🔒 ABSTAIN" : (p.rule_alert ? "⚠ RULE ALERT" : "✓ NO RULE ALERT"), abstain ? "pill pill-verify" : (p.rule_alert ? "pill pill-fault" : "pill pill-ok"));

  const agMap = {
    NO_ALERT: ["SEPARATE · NO ALERT", "pill pill-ok"],
    AI_ONLY_ALERT: ["AI ALERT · RULE CLEAN", "pill pill-fault"],
    RULE_ONLY_ALERT: ["RULE ALERT · AI CLEAN", "pill pill-warn"],
    BOTH_FLAGGED: ["AI & RULE BOTH FLAGGED", "pill pill-fault"],
    BLOCKED_BY_GATE: ["BLOCKED BY GATE", "pill pill-verify"],
  };
  const [agTxt, agCls] = agMap[snap.agreement] || ["SEPARATE OUTPUTS", "pill pill-ok"];
  setPill("fusion-agreement-pill", agTxt, agCls);

  document.getElementById("kpi-fan-meas").textContent = fmt(s.fan_pct, 1, " %");
  document.getElementById("rule-dwell-text").textContent = `${p.rule_run_minutes} / ${p.rule_required_minutes}m`;
  const rPct = Math.min(100, (p.rule_run_minutes / Math.max(p.rule_required_minutes, 1)) * 100);
  const rBar = document.getElementById("rule-dwell-bar");
  rBar.style.width = `${rPct}%`;
  rBar.style.background = p.rule_alert ? "#DC2626" : rPct > 0 ? "#D97706" : "#059669";

  const aiMetaEl = document.getElementById("ai-meta-tag");
  if (aiMetaEl) {
    aiMetaEl.textContent = fmt(p.inference_ms, 1, "ms");
    aiMetaEl.title = `Uncalibrated HGB score · ${fmt(p.inference_ms, 1, "ms")} local inference`;
  }
  document.getElementById("ai-pred-label").textContent = snap.status.replace("_", " ");
  document.getElementById("ai-conf-val").textContent = p.ai_score !== null ? p.ai_score.toFixed(3) : "ABSTAIN";
  const scPct = p.ai_score !== null ? Math.max(0, Math.min(100, p.ai_score * 100)) : 0;
  document.getElementById("ai-score-fill").style.width = `${scPct.toFixed(1)}%`;
  document.getElementById("ai-dwell-text").textContent = `${p.ai_run_minutes} / ${p.ai_required_minutes} min`;
  const aPct = Math.min(100, (p.ai_run_minutes / Math.max(p.ai_required_minutes, 1)) * 100);
  const aBar = document.getElementById("ai-dwell-bar");
  aBar.style.width = `${aPct}%`;
  aBar.style.background = p.ai_alert ? "#DC2626" : aPct > 0 ? "#D97706" : "#0B63B6";

  document.getElementById("kpi-plant-kw").textContent = fmt(s.plant_kw, 1, " kW");
  const dKw = Number(s.signed_delta_kw || 0);
  const dEl = document.getElementById("kpi-delta-kw");
  if (dEl) {
    dEl.textContent = `${dKw >= 0 ? "+" : ""}${dKw.toFixed(1)} kW`;
    dEl.className = "hero-num " + (dKw > 2.5 ? "num-fault" : dKw > 0.5 ? "num-warn" : "num-ok");
  }
  document.getElementById("kpi-range-c").textContent = fmt(s.tower_range_c, 2, " °C");
  const fEl = document.getElementById("kpi-flow-gpm");
  if (fEl) fEl.textContent = fmt(s.tower_flow_gpm, 0, " GPM");
  document.getElementById("kpi-load-kw").textContent = fmt(s.logged_load_kw, 0, " kW");
  const stgEl = document.getElementById("kpi-staging");
  if (stgEl) stgEl.textContent = `${s.n_chillers_on} CH / ${s.n_towers_on} CT`;

  renderTimelineScrubber(snap);
  updatePidMimic(snap);
  window.drawFanGaugeSvg(document.getElementById("chart-gauge"), s.fan_pct, p.rule_threshold_pct, snap.status);
}

function renderTabTrends(snap) {
  const p = snap.prediction, m = snap.metrics, abstain = snap.status === "ABSTAIN";
  setPill("xai-ood-badge", p.ood_flag ? "OUTSIDE TRAIN BOUNDS (OOD)" : "IN TRAINING BOUNDS", p.ood_flag ? "pill pill-verify" : "pill pill-ok");

  // Update Lead-Time status pill on Score Chart card
  const leadPill = document.getElementById("score-lead-pill");
  if (leadPill) {
    const hist = snap.history || [];
    const firstAi = hist.findIndex(r => r.ai_alert);
    const firstRule = hist.findIndex(r => r.rule_alert);
    if (firstAi >= 0 && firstRule < 0) {
      leadPill.textContent = "⚡ AI Flagged · Rule Still Silent";
      leadPill.className = "pill pill-fault";
    } else if (firstAi >= 0 && firstRule > firstAi) {
      leadPill.textContent = `⚡ AI Ahead by +${firstRule - firstAi} min`;
      leadPill.className = "pill pill-fault";
    } else if (firstAi >= 0 && firstRule >= 0) {
      leadPill.textContent = "AI & Rule Both Active";
      leadPill.className = "pill pill-warn";
    } else {
      leadPill.textContent = "Gate 0.70 · 5m vs 15m";
      leadPill.className = "tag-subtle";
    }
  }

  // Symmetric Diverging Zero-Axis Local Sensitivity Bars (0.000 = neutral 0% bar, never red!)
  const sens = p.feature_sensitivity || [];
  const shortLabelMap = {
    "CT-1 Water Range (ΔT)": "Water Range ΔT",
    "CT-1 Fan VFD Fraction": "CT-1 Fan VFD",
    "CT-1 Condenser Flow": "Condenser Flow",
    "CT-1 Nominal Outlet*": "Tower Outlet*",
    "Logged Secondary Load*": "Cooling Load*",
    "Fan × Range Interaction": "Fan × Range",
  };
  if (sens.length) {
    const maxAbs = Math.max(0.22, ...sens.map(ft => Math.abs(Number(ft.delta_score || 0))));
    const rowsHtml = sens.map(ft => {
      const d = Number(ft.delta_score || 0);
      const isZero = Math.abs(d) < 0.0005 || ft.direction === "neutral";
      const isUp = !isZero && d > 0;
      const halfPct = isZero ? 0 : Math.min(49.5, Math.max(2.5, (Math.abs(d) / maxAbs) * 49.5));
      const valCls = isZero ? "xai-zero" : (isUp ? "xai-up" : "xai-down");
      const valStr = isZero ? "0.000" : `${d > 0 ? "+" : ""}${d.toFixed(3)}`;
      const barHtml = isZero
        ? ""
        : `<div class="xai-div-bar ${isUp ? "xai-div-up" : "xai-div-down"}" style="width:${halfPct.toFixed(1)}%"></div>`;
      const dispLbl = shortLabelMap[ft.label] || ft.label;
      return `
        <div class="xai-row" title="${escapeHtml(ft.label)} (${escapeHtml(ft.current_value)}): ${valStr} Δscore vs Jan–Jun train mean">
          <div class="xai-lbl-wrap">
            <span class="xai-fname">${escapeHtml(dispLbl)}</span>
            <span class="xai-fcur">${escapeHtml(ft.current_value)}</span>
          </div>
          <div class="xai-div-track">
            <div class="xai-zero-line"></div>
            ${barHtml}
          </div>
          <span class="xai-val ${valCls}">${valStr}</span>
        </div>
      `;
    }).join("");
    document.getElementById("xai-feature-list").innerHTML = `
      <div class="xai-axis-hdr">
        <span>6 Native Inputs</span>
        <div class="xai-axis-scale"><span class="xai-axis-neg">← Normal (−)</span><span>0</span><span class="xai-axis-pos">(+) Fault →</span></div>
        <span style="text-align:right">Δscore</span>
      </div>
      ${rowsHtml}
    `;
  } else {
    document.getElementById("xai-feature-list").innerHTML = `<div class="tag-subtle" style="text-align:center;padding:18px">${p.ood_flag ? "Suspended: Feature vector outside Jan–Jun training envelope (OOD)" : (abstain ? "Suspended while ABSTAIN gate is active" : "Advance 1 step or jump to eligible row")}</div>`;
  }

  // Static Memoization for Benchmark & Per-Level Recall (ZERO redundant DOM rebuilds during 0.5s Play ticks!)
  const themeKey = currentTheme();
  if (lastBenchRenderKey !== themeKey) {
    lastBenchRenderKey = themeKey;
    window.drawBenchmarkBarsSvg(document.getElementById("chart-benchmark"), m);
  }

  const recallKey = `${themeKey}|${snap.scenario}`;
  if (lastRecallRenderKey !== recallKey) {
    lastRecallRenderKey = recallKey;
    const pc = m.AI.per_case, rPc = m.rule.per_case;
    const activeLabelMap = {
      normal: "Active: Normal (1.00 UA)",
      fouling_low: "Active: 0.95 UA (Mild)",
      fouling_medium: "Active: 0.80 UA (Med)",
      fouling_high: "Active: 0.65 UA (Severe)",
    };
    const rTag = document.getElementById("recall-active-tag");
    if (rTag) {
      rTag.textContent = activeLabelMap[snap.scenario] || "Oct–Dec Test";
      rTag.className = snap.scenario === "normal" ? "tag-subtle" : "pill pill-ok";
    }
    const makeRecallRow = (scenKey, title, tagCls, aiR, ruleR, summaryTxt, tip) => {
      const aPct = (aiR * 100).toFixed(1), rPct = (ruleR * 100).toFixed(1);
      const barCls = aiR >= ruleR ? "rc-bar-ai" : "rc-bar-warn";
      const isAct = snap.scenario === scenKey;
      return `
        <div class="rc-tile ${isAct ? "rc-tile-active" : ""}" data-rc-scen="${scenKey}" style="cursor:pointer" title="${escapeHtml(tip)} (Click to switch scenario)">
          <div class="rc-tile-top">
            <span class="rc-tile-title">${escapeHtml(title)}${isAct ? '<span class="rc-active-dot">RUNNING</span>' : ""}</span>
            <span class="rc-tag ${tagCls}">${escapeHtml(summaryTxt)}</span>
          </div>
          <div class="rc-mini-bars">
            <div class="rc-bar-row"><span>AI</span><div class="rc-bar-bg"><div class="${barCls}" style="width:${Math.min(100, aiR * 100)}%"></div></div><span>${aPct}%</span></div>
            <div class="rc-bar-row"><span>Rule</span><div class="rc-bar-bg"><div class="rc-bar-rule" style="width:${Math.min(100, ruleR * 100)}%"></div></div><span>${rPct}%</span></div>
          </div>
        </div>
      `;
    };
    document.getElementById("limits-grid").innerHTML = `
      ${makeRecallRow("fouling_low", "0.95 UA (Mild −5%)", "rc-CHECK_REQUIRED", pc.tower_fouling_095.recall, rPc.tower_fouling_095.recall, `Rule +${((rPc.tower_fouling_095.recall - pc.tower_fouling_095.recall) * 100).toFixed(1)}% higher`, "Mildest fouling: Rule (8.5%) beats AI (4.5%) — disclosed honestly.")}
      ${makeRecallRow("fouling_medium", "0.80 UA (Medium −20%)", "rc-RULED_OUT", pc.tower_fouling_080.recall, rPc.tower_fouling_080.recall, `AI +${((pc.tower_fouling_080.recall - rPc.tower_fouling_080.recall) * 100).toFixed(1)}% higher`, "Medium fouling: AI catches 15.8% vs Rule 9.6% (+6.2 percentage points).")}
      ${makeRecallRow("fouling_high", "0.65 UA (Severe −35%)", "rc-RULED_OUT", pc.tower_fouling_065.recall, rPc.tower_fouling_065.recall, `AI +${((pc.tower_fouling_065.recall - rPc.tower_fouling_065.recall) * 100).toFixed(1)}% · 42/53 win`, "Severe fouling: AI catches 46.5% vs Rule 17.8% (42 of 53 operating windows).")}
      <div class="rc-scope-foot" title="73,932 eligible active-cooling rows out of 529,920 Oct–Dec minutes (13.95% active duty); Pilot required for site transfer">Scope: 73.9k eligible rows (14.0% active duty · Oct–Dec) · Pilot Scope</div>
    `;
  }

  document.querySelectorAll("#power-view-toggle .dt-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.pview === tab2PowerMode);
  });
  window.drawScoreTrendSvg(document.getElementById("chart-score"), snap.history, p.ai_threshold);
  window.drawPowerTrendSvg(document.getElementById("chart-power"), snap.history, tab2PowerMode);
}

function renderTabQuantify(snap) {
  const s = snap.signals, e = snap.electricity;
  const fmtEn = (v, minDec = 0, maxDec = minDec) => {
    const n = Number(v || 0);
    if (!Number.isFinite(n)) return "--";
    return n.toLocaleString("en-US", { minimumFractionDigits: minDec, maximumFractionDigits: maxDec });
  };
  const isLiveBasis = tab3BasisMode === "live" && Boolean(e.live_alert_projection);
  const sim = isLiveBasis ? e.live_alert_projection : e.illustrative_scenario;
  document.querySelectorAll("#excess-kw-buttons .seg-btn").forEach(b => {
    if (b.dataset.mode === "live") b.classList.toggle("active", isLiveBasis);
    else b.classList.toggle("active", !isLiveBasis && Number(b.dataset.kw) === Number(e.illustrative_scenario.imposed_excess_kw));
  });
  document.querySelectorAll("#clean-day-buttons .seg-btn").forEach(b => b.classList.toggle("active", Number(b.dataset.day) === Number(sim.earlier_pm_day)));
  document.querySelectorAll("#cal-day-buttons .seg-btn").forEach(b => b.classList.toggle("active", Number(b.dataset.cal) === Number(sim.existing_pm_day)));
  document.querySelectorAll("#restore-buttons .seg-btn").forEach(b => b.classList.toggle("active", Math.abs(Number(b.dataset.rest) - Number(sim.restored_fraction)) < 0.01));

  if (isLiveBasis) {
    if (!sim.active || sim.imposed_excess_kw <= 0) {
      document.getElementById("cf-chart-title").textContent = `Live Auto-Projection (Standby)`;
      setPill(
        "cf-days-pill",
        sim.mode === "SUSPENDED_ABSTAIN" ? "🔒 ABSTAIN · LOCKED" : "✓ 0 kWh · Standby",
        sim.mode === "SUSPENDED_ABSTAIN" ? "pill pill-verify" : "pill pill-ok"
      );
    } else {
      document.getElementById("cf-chart-title").textContent = `Live Auto (+${sim.imposed_excess_kw.toFixed(2)} kW* @ ${sim.trigger_timestamp.slice(11, 16)}) · D${sim.earlier_pm_day} vs D${sim.existing_pm_day}`;
      setPill(
        "cf-days-pill",
        `⚡ ${sim.days_saved}d Earlier · ${fmtEn(sim.scenario_avoided_excess_kwh, 0, 1)} kWh`,
        "pill pill-fault"
      );
    }
  } else {
    document.getElementById("cf-chart-title").textContent = `Earlier PM (D${sim.earlier_pm_day}) vs. Calendar PM (D${sim.existing_pm_day})`;
    setPill(
      "cf-days-pill",
      `${sim.days_saved}d Earlier · ${fmtEn(sim.scenario_avoided_excess_kwh, 0, 1)} kWh`,
      "pill pill-ok"
    );
  }

  // Right Card Header: Total 14-Ch kW + Live Signed Excess ΔkW* (replaces static orange PENDING pill)
  const dKw = Number(s.signed_delta_kw || 0);
  const dSign = dKw > 0.05 ? "+" : (dKw < -0.05 ? "−" : "+");
  const totTxt = `Total: ${Number(s.plant_kw || 0).toFixed(1)} kW · ${dSign}${Math.abs(dKw).toFixed(1)} kW*`;
  const totCls = dKw > 2.5 ? "pill pill-fault" : (dKw > 0.5 ? "pill pill-warn" : "pill pill-ok");
  setPill("breakdown-total-pill", totTxt, totCls);

  const fmtVnd = v => {
    const n = Number(v || 0);
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M ₫`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k ₫`;
    return `${fmtEn(Math.round(n))} ₫`;
  };
  const k5 = sim.kpis_5m1e;

  // Oct–Dec Conditional Matched Table: en-US formatting + active scenario highlight + click-to-switch
  const condBody = document.querySelector("#cond-elec-table tbody");
  if (condBody && e.oct_dec_conditional && lastCondRenderKey !== snap.scenario) {
    lastCondRenderKey = snap.scenario;
    const caseInfo = {
      tower_fouling_095: { label: "0.95 UA (Mild −5%)", scen: "fouling_low" },
      tower_fouling_080: { label: "0.80 UA (Med −20%)", scen: "fouling_medium" },
      tower_fouling_065: { label: "0.65 UA (Severe −35%)", scen: "fouling_high" },
    };
    condBody.innerHTML = e.oct_dec_conditional.map(row => {
      const info = caseInfo[row.case] || { label: row.case, scen: "" };
      const isAct = info.scen && info.scen === snap.scenario;
      const posStr = fmtEn(row.positive_only_kWh_not_headline || 0, 1, 1);
      const negStr = fmtEn(Math.abs(Number(row.negative_kWh || 0)), 1, 1);
      const netStr = fmtEn(row.net_excess_kWh || 0, 1, 1);
      const exclStr = fmtEn(row.excluded_or_unmatched_rows || 0);
      return `
      <tr class="${isAct ? "cond-row-active" : ""}" data-cond-scen="${escapeHtml(info.scen)}" style="cursor:pointer" title="Click to switch to ${escapeHtml(info.label)} · ${exclStr} unmatched/off-gate rows excluded · Conditional pending Site Pilot">
        <td>${escapeHtml(info.label)}${isAct ? '<span class="cond-active-dot">RUNNING</span>' : ""}</td>
        <td>${row.matched_hours.toFixed(1)} h</td>
        <td class="cond-pos">+${netStr} kWh</td>
        <td>+${posStr} / −${negStr}</td>
      </tr>
    `;
    }).join("");
  }

  // Quantitative 3-Pillar Cards (Clean Readable Labels + Strictly en-US Numbers)
  const isStandby = isLiveBasis && (!sim.active || sim.imposed_excess_kw <= 0);
  const km = k5.money, kt = k5.time, ke = k5.esg;
  const pm = sim.pm_optimizer || {};
  const pmCostVnd = Number(pm.pm_cost_vnd || 8000000);
  const pmCostM = Math.round(pmCostVnd / 1e6);
  document.querySelectorAll("#pm-cost-buttons .pm-mini-btn").forEach(b => {
    b.classList.toggle("active", Math.abs(Number(b.dataset.pm) - pmCostVnd) < 1000);
  });

  const fmtSignedVnd = v => {
    const n = Number(v || 0);
    const sign = n > 0 ? "+" : n < 0 ? "−" : "";
    const abs = Math.abs(n);
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)}M ₫`;
    if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k ₫`;
    return `${sign}${fmtEn(Math.round(abs))} ₫`;
  };
  const pkTile = (lbl, val, sub, cls = "", tip = "") =>
    `<div class="pk-box ${cls}"${tip ? ` title="${escapeHtml(tip)}"` : ""}><span class="pk-lbl">${escapeHtml(lbl)}</span><strong class="pk-val">${escapeHtml(val)}</strong><span class="pk-sub">${escapeHtml(sub)}</span></div>`;

  const moneyEl = document.getElementById("p-money-kpis");
  if (moneyEl) {
    const verdict = pm.verdict || (isStandby ? "STANDBY_NO_ACTION" : "CLEAN_NOW_POSITIVE_ROI");
    const pbDays = pm.payback_days !== null && pm.payback_days !== undefined ? Math.round(Number(pm.payback_days)) : null;
    const pbCal = pm.payback_calendar_day !== null && pm.payback_calendar_day !== undefined ? Math.round(Number(pm.payback_calendar_day)) : null;
    const cutoffDay = pm.latest_profitable_day !== null && pm.latest_profitable_day !== undefined ? Math.round(Number(pm.latest_profitable_day)) : null;
    const eoqDays = pm.eoq_sensitivity_days !== null && pm.eoq_sensitivity_days !== undefined ? Math.round(Number(pm.eoq_sensitivity_days)) : null;

    let roiVal = "0 ₫", roiSub = "Standby (No Alert)", roiCls = "";
    if (verdict === "CLEAN_NOW_POSITIVE_ROI") {
      roiVal = fmtSignedVnd(pm.net_benefit_vnd);
      roiSub = `Payback ${pbDays !== null ? pbDays + "d" : "--"} · +${Math.round(Number(pm.roi_pct || 0))}%`;
      roiCls = "pk-hi";
    } else if (verdict === "DEFER_PM_NEGATIVE_ROI") {
      roiVal = fmtSignedVnd(pm.net_benefit_vnd);
      roiSub = `Defer PM${pbDays !== null ? ` (${pbDays}d)` : ""}`;
      roiCls = "pk-warn";
    } else if (verdict === "LOCKED_ABSTAIN") {
      roiVal = "LOCKED";
      roiSub = "ABSTAIN Gate Active";
      roiCls = "pk-warn";
    }

    const burnVal = isStandby ? "0 ₫/d" : `${fmtVnd(km.daily_burn_ex_vat_vnd)}/d`;
    const burnSub = verdict === "CLEAN_NOW_POSITIVE_ROI" && cutoffDay !== null
      ? `Clean before Day ${cutoffDay}`
      : verdict === "DEFER_PM_NEGATIVE_ROI"
        ? "Wait for Calendar PM"
        : "No excess burn active";

    const tou = pm.tou_avoided_vnd || {};
    const avoidedTip = `Ex-VAT: ${fmtVnd(km.avoided_ex_vat_vnd)} (~$${fmtEn(Math.round(Number(km.avoided_ex_vat_usd || 0)))} USD) · Incl. 8% VAT: ${fmtVnd(km.avoided_incl_vat8_vnd)} · Tariff: ${fmtEn(Math.round(km.tariff_vnd_kwh))} ₫/kWh (22kV TOU).`;
    const roiTip = pm.rationale || "EVN 22kV TOU Break-Even PM Optimizer (illustrative only; verified_avoided_kwh = null).";
    const burnTip = `EVN TOU 22kV (1,926 ₫/kWh) · Peak 31.0%: ${fmtVnd(tou.peak || 0)} · Normal 53.8%: ${fmtVnd(tou.normal || 0)} · Off-Peak 15.1%: ${fmtVnd(tou.off_peak || 0)} · Recommended Window: ${pm.recommended_window || "Sun 00–06h"}`;

    moneyEl.innerHTML = [
      pkTile(
        "Avoided Cost",
        fmtVnd(km.avoided_ex_vat_vnd),
        `+8% VAT: ${fmtVnd(km.avoided_incl_vat8_vnd)}`,
        "",
        avoidedTip
      ),
      pkTile(`Net ROI (PM ${pmCostM}M)`, roiVal, roiSub, roiCls, roiTip),
      pkTile("Daily Waste", burnVal, burnSub, "", burnTip),
    ].join("");

    const mNoteTxt = verdict === "CLEAN_NOW_POSITIVE_ROI"
      ? `CLEAN NOW (Sun 00–06h 1,166₫) · Payback D${pbCal ?? "--"} · EOQ t*≈${eoqDays ?? "--"}d · QĐ 2892/BCT 22kV (Pilot req.).`
      : verdict === "DEFER_PM_NEGATIVE_ROI"
        ? `DEFER PM: Payback (${pbDays ?? "--"}d) > D${sim.existing_pm_day} window · 22kV TOU 1,926 ₫/kWh · Verified kWh = Pilot.`
        : `Standby (${snap.status.replace("_", " ")}) · 22kV TOU ${fmtEn(Math.round(km.tariff_vnd_kwh))} ₫/kWh (110kV: ${fmtEn(Math.round(km.tariff_110kv_vnd_kwh))} ₫) · Verified kWh = Pilot.`;
    const mNote = document.getElementById("p-money-note");
    if (mNote) mNote.textContent = mNoteTxt;
    const pMoneyCard = document.getElementById("pillar-money");
    if (pMoneyCard) pMoneyCard.title = mNoteTxt;
  }

  const timeEl = document.getElementById("p-time-kpis");
  if (timeEl) {
    const isNormCase = kt.case_key === "normal";
    const leadLbl = isNormCase ? "False-Alarm Spacing" : "AI Lead vs. Rule";
    const leadVal = isNormCase
      ? `${kt.mean_normal_hrs_per_fa.toFixed(1)} h / FA`
      : `+${kt.window_speedup_min.toFixed(1)}m Lead`;
    const leadSub = isNormCase
      ? `Precision ${kt.precision_pct.toFixed(1)}%`
      : `AI ${kt.ai_median_window_min.toFixed(0)}m vs Rule ${kt.rule_median_window_min.toFixed(0)}m`;
    const leadTip = `Oct–Dec Operating Windows: AI alerted ${kt.ai_windows_alerted}/${kt.eligible_windows} windows (median ${kt.ai_median_window_min.toFixed(1)}m) vs Rule ${kt.rule_windows_alerted}/${kt.eligible_windows} windows (median ${kt.rule_median_window_min.toFixed(1)}m).`;
    timeEl.innerHTML = [
      pkTile(
        "Fouling Hours Cut",
        `${fmtEn(kt.fouling_hours_avoided)} h`,
        kt.days_earlier > 0 ? `${kt.days_earlier} days earlier PM` : "Standby (0 days)",
        kt.days_earlier > 0 ? "pk-hi" : ""
      ),
      pkTile(leadLbl, leadVal, leadSub, isNormCase ? "" : "pk-hi", leadTip),
      pkTile("False-Alarm Load", `${kt.fa_triage_hrs_per_100h.toFixed(2)} h/100h`, `${kt.precision_pct.toFixed(1)}% Precision`, ""),
    ].join("");
    const tNoteTxt = `LBNL Oct–Dec windows (${kt.ai_windows_alerted}/${kt.eligible_windows} AI vs ${kt.rule_windows_alerted}/${kt.eligible_windows} Rule) · 5m AI vs 15m Rule dwell · N+1 PM avoids unplanned stop.`;
    const tNote = document.getElementById("p-time-note");
    if (tNote) tNote.textContent = tNoteTxt;
    const pTimeCard = document.getElementById("pillar-time");
    if (pTimeCard) pTimeCard.title = tNoteTxt;
  }

  const esgEl = document.getElementById("p-image-kpis");
  if (esgEl) {
    const wp = ke.water_physics_est || {};
    const wpSusp = Boolean(wp.suspended);
    const wpVal = wpSusp ? "ABSTAIN" : `~${Number(wp.live_evap_m3_day || 0).toFixed(1)} m³/d*`;
    const wpSub = wpSusp
      ? "Gate hold · WTP Pilot"
      : (Number(wp.coc_4to3_penalty_m3_est || 0) > 0
          ? `+${fmtEn(Math.round(wp.coc_4to3_penalty_m3_est))} m³ risk (CoC 4→3)`
          : "Normal · Meter in Pilot");
    const wpTip = wpSusp
      ? "ASHRAE water balance suspended during ABSTAIN gate. Verified water savings = null (WTP meter required in Pilot)."
      : `Live ASHRAE/CTI CT-1 Evap: ${Number(wp.live_evap_m3_day || 0).toFixed(2)} m³/d (Makeup @CoC4: ${Number(wp.live_makeup_coc4_m3_day || 0).toFixed(2)} m³/d) | Direct chiller-heat thermal makeup: +${Number(wp.thermal_makeup_m3_est || 0).toFixed(1)} m³ | Blowdown risk if fouling forces CoC 4→3: +${Number(wp.coc_4to3_penalty_m3_est || 0).toFixed(1)} m³ (+${Number(wp.coc_5to3_penalty_m3_est || 0).toFixed(1)} m³ for CoC 5→3) | Verified water savings = null (WTP meter required in Pilot).`;
    const co2Tip = `Avoided Scope 2: ${fmtEn(Math.round(ke.avoided_co2_kg))} kg CO₂e using official Vietnam 2024 grid emission factor ${ke.grid_ef_kg_kwh} kg/kWh (MONRE CV 11232).`;
    esgEl.innerHTML = [
      pkTile("Avoided CO₂e", `${ke.avoided_co2_tonnes.toFixed(2)} t CO₂e`, `${fmtEn(Math.round(ke.avoided_co2_kg))} kg (VN Grid EF)`, isStandby ? "" : "pk-hi", co2Tip),
      pkTile("Daily Carbon", `${ke.daily_co2_kg.toFixed(1)} kg/d`, `≈ ${fmtEn(ke.trees_yr_eq)} trees/yr eq.`, ""),
      pkTile("Tower Evap. Est.", wpVal, wpSub, "pk-warn", wpTip),
    ].join("");
    const eNoteTxt = `VN 2024 EF ${ke.grid_ef_kg_kwh} (CV 11232) · Water = ASHRAE Flow×ΔT est. (verified = null; WTP meter req.).`;
    const eNote = document.getElementById("p-image-note");
    if (eNote) eNote.textContent = eNoteTxt;
    const pImgCard = document.getElementById("pillar-image");
    if (pImgCard) pImgCard.title = eNoteTxt;
  }

  window.drawCounterfactualSvg(document.getElementById("chart-counterfactual"), sim);
  window.drawPowerBreakdownSvg(document.getElementById("chart-breakdown"), s);
}

function renderTabDerisk(snap) {
  renderTriageWorkbench(snap);
  const shortCaseMap = {
    normal: "Normal",
    fouling_low: "0.95 UA",
    fouling_medium: "0.80 UA",
    fouling_high: "0.65 UA",
  };
  document.getElementById("event-log-list").innerHTML = (snap.audit_log || []).slice(0, 14).map(ev => {
    const hhmm = (ev.timestamp || "").slice(11, 16);
    const cTag = ev.case_tag || shortCaseMap[ev.scenario] || "";
    const safeMsg = escapeHtml(ev.message).replace(new RegExp(`\\s*@\\s*${escapeHtml(hhmm)}\\b`, "g"), "");
    return `
    <li class="feed-item">
      <span class="f-time">${escapeHtml(hhmm)}</span>
      <span class="f-case">${escapeHtml(cTag)}</span>
      <span class="f-tag ev-${escapeHtml(ev.level)}">${escapeHtml(ev.category)}</span>
      <span>${safeMsg}</span>
    </li>
  `;
  }).join("");
}

/* ==================== TAB 5: CLEAN FIELD CAMERA EXTRACTION ==================== */
function renderHardwareTab(hw, opts = {}) {
  if (!hw) return;
  if (latestHw && latestHw.vision_modes && hw.vision_modes) {
    Object.keys(hw.vision_modes).forEach(k => {
      const cur = hw.vision_modes[k];
      const prev = latestHw.vision_modes[k];
      if (cur && !cur.annotated_image_data_uri && prev && prev.annotated_image_data_uri) {
        cur.annotated_image_data_uri = prev.annotated_image_data_uri;
      }
    });
  }
  latestHw = hw;
  dirtyTabs.hardware = false;
  if (!opts.keepMode && hw.active_vision_mode) {
    activeHwVisionMode = hw.active_vision_mode;
  }
  const modes = hw.vision_modes || {};
  if (!modes[activeHwVisionMode]) {
    activeHwVisionMode = hw.active_vision_mode || Object.keys(modes)[0] || "fill_strainer";
  }
  const vm = modes[activeHwVisionMode] || {};

  document.querySelectorAll("#hw-preset-buttons .seg-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.preset === hw.active_preset);
  });
  document.querySelectorAll("#hw-vision-modes .dt-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.mode === activeHwVisionMode);
  });

  const imgEl = document.getElementById("hw-vision-img");
  if (imgEl && vm.annotated_image_data_uri) {
    const imgKey = `${hw.active_preset || ""}|${activeHwVisionMode}|${vm.verdict || ""}`;
    if (imgEl.dataset.imgKey !== imgKey) {
      imgEl.dataset.imgKey = imgKey;
      imgEl.src = vm.annotated_image_data_uri;
    }
  }

  const vVerdict = String(vm.verdict || "OK");
  const vPillMap = {
    OK: "✓ CLEAR",
    ISSUE_FOULING: "⚠ FILL FOULING",
    ISSUE_LOW_FLOW_OR_NOZZLE: "⚠ NOZZLE / LOW FLOW",
    ISSUE_WATER_CHEM: "⚠ TURBID / LOW CoC",
  };
  setPill(
    "hw-vision-verdict-pill",
    vPillMap[vVerdict] || `⚠ ${vVerdict.replace(/_/g, " ")}`,
    vVerdict === "OK" ? "pill pill-ok" : "pill pill-fault"
  );
  updateAuditHook();
}

async function loadHardwareStatus(opts = {}) {
  if (hwLoadingPromise) return hwLoadingPromise;
  hwLoadingPromise = (async () => {
    try {
      const hw = await apiJson("/api/hardware/status?img_fmt=jpeg");
      renderHardwareTab(hw, opts);
      return hw;
    } catch (err) {
      auditErrors.push(`HW status error: ${err.message}`);
      updateAuditHook();
      return null;
    } finally {
      hwLoadingPromise = null;
    }
  })();
  return hwLoadingPromise;
}

async function applyHardwareToStep4(switchToTriage = false) {
  const snap = await apiJson("/api/hardware/apply-to-step4", "POST");
  if (snap && snap.field_checks) {
    syncFieldChecksFromBackend(snap.field_checks);
  }
  renderSnapshot(snap);
  if (switchToTriage) {
    switchTab("derisk");
  }
}

/* ==================== STEP III DAG / CARDS VIEW TOGGLE ==================== */
function hideDagFloatingTip() {
  const dft = document.getElementById("dag-floating-tip");
  if (dft) dft.classList.add("hidden");
}

function setStep3View(mode) {
  hideDagFloatingTip();
  step3ViewMode = mode === "cards" ? "cards" : "dag";
  if (latestSnap) renderTriageWorkbench(latestSnap);
  updateAuditHook();
}

/* ==================== PURE LLM CHAT ASSISTANT (GEMINI 2.5 FLASH + OLLAMA + LIVE CONTEXT) ==================== */
const RCA_AGENT_CONTRACT_URL = "/api/rca-agent"; // Retained for v9/v13 API contract parity
let rcaChatMessages = [];
let rcaLlmStatus = null;

function renderChatMarkdown(mdText) {
  const formatInline = raw => {
    let s = escapeHtml(raw);
    s = s.replace(/`([^`]+)`/g, '<code class="rca-code">$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    return s;
  };

  const lines = String(mdText || "").split(/\r?\n/);
  const parts = [];
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let codeBuf = [];
  let tableBuf = [];

  const closeLists = () => {
    if (inUl) { parts.push("</ul>"); inUl = false; }
    if (inOl) { parts.push("</ol>"); inOl = false; }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf
      .map(r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()))
      .filter(cols => cols.length > 0 && !cols.every(c => /^[-:\s]+$/.test(c)));
    if (rows.length) {
      const head = rows[0].map(c => `<th>${formatInline(c)}</th>`).join("");
      const body = rows.slice(1).map(r => `<tr>${r.map(c => `<td>${formatInline(c)}</td>`).join("")}</tr>`).join("");
      parts.push(`<div class="rca-tbl-wrap"><table class="rca-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
    }
    tableBuf = [];
  };

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      closeLists();
      flushTable();
      if (inCode) {
        parts.push(`<pre class="rca-pre"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      return;
    }
    if (inCode) {
      codeBuf.push(line);
      return;
    }
    if (/^\|.+\|$/.test(trimmed)) {
      closeLists();
      tableBuf.push(trimmed);
      return;
    }
    flushTable();
    if (!trimmed) {
      closeLists();
      return;
    }
    if (/^#{1,4}\s+/.test(trimmed)) {
      closeLists();
      parts.push(`<div class="rca-h">${formatInline(trimmed.replace(/^#{1,4}\s+/, ""))}</div>`);
    } else if (/^[-•*]\s+/.test(trimmed)) {
      if (inOl) { parts.push("</ol>"); inOl = false; }
      if (!inUl) { parts.push('<ul class="rca-ul">'); inUl = true; }
      parts.push(`<li class="rca-li">${formatInline(trimmed.replace(/^[-•*]\s+/, ""))}</li>`);
    } else if (/^\d+[.)]\s+/.test(trimmed)) {
      if (inUl) { parts.push("</ul>"); inUl = false; }
      if (!inOl) { parts.push('<ol class="rca-ol">'); inOl = true; }
      parts.push(`<li class="rca-li">${formatInline(trimmed.replace(/^\d+[.)]\s+/, ""))}</li>`);
    } else {
      closeLists();
      parts.push(`<p class="rca-p">${formatInline(trimmed)}</p>`);
    }
  });
  if (inCode && codeBuf.length) {
    parts.push(`<pre class="rca-pre"><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  closeLists();
  flushTable();
  return parts.join("");
}

function updateRcaHeaderBadge(statusObj) {
  if (statusObj) rcaLlmStatus = statusObj;
  const dot = document.getElementById("rca-status-dot");
  const pill = document.getElementById("btn-rca-key-toggle");
  if (!pill) return;
  const st = rcaLlmStatus || {};
  if (st.provider === "gemini") {
    if (dot) dot.className = "rca-dot dot-live";
    const mShort = String(st.model || "gemini-3.8-flash").replace("models/", "");
    pill.textContent = `✦ ${mShort}`;
    pill.className = "rca-llm-pill pill-ready";
  } else if (st.provider === "ollama") {
    if (dot) dot.className = "rca-dot dot-live";
    pill.textContent = `● ${st.label || "Ollama Local"}`;
    pill.className = "rca-llm-pill pill-ready";
  } else {
    if (dot) dot.className = "rca-dot dot-local";
    pill.textContent = "🔑 Set Gemini Key";
    pill.className = "rca-llm-pill pill-need-key";
  }
}

async function refreshRcaLlmStatus() {
  try {
    const st = await apiJson("/api/rca-chat/status");
    updateRcaHeaderBadge(st);
  } catch (_) {
    // Keep silent if status check fails transiently
  }
}

function renderRcaChatThread() {
  const logEl = document.getElementById("rca-chat-log");
  if (!logEl) return;
  if (!rcaChatMessages.length) {
    const snapTime = latestSnap && latestSnap.timestamp ? latestSnap.timestamp.slice(11, 16) : "--:--";
    const snapCase = latestSnap && latestSnap.case_meta ? latestSnap.case_meta.label : "Normal";
    logEl.innerHTML = `
      <div class="rca-msg rca-msg-bot">
        <div class="rca-bubble">
          <p class="rca-p">Hello! I'm <strong>FaultGuard AI</strong> — synced live with CT-1 telemetry (<code>${escapeHtml(snapTime)} · ${escapeHtml(snapCase)}</code>).</p>
          <p class="rca-p">Ask anything in English or Vietnamese — e.g., why AI flagged ahead of the 98% Rule, how temperatures changed vs. 15 min ago, or What-If payback at a custom PM cost.</p>
        </div>
      </div>
    `;
    return;
  }

  logEl.innerHTML = rcaChatMessages.map(m => {
    if (m.role === "user") {
      return `
        <div class="rca-msg rca-msg-user">
          <div class="rca-bubble">${escapeHtml(m.content)}</div>
        </div>
      `;
    }
    if (m.typing) {
      return `
        <div class="rca-msg rca-msg-bot">
          <div class="rca-bubble rca-typing" aria-label="AI is thinking"><span></span><span></span><span></span></div>
        </div>
      `;
    }
    const warnHtml = m.warning
      ? `<div class="rca-msg-warn">⚠ ${escapeHtml(m.warning)}</div>`
      : "";
    return `
      <div class="rca-msg rca-msg-bot">
        <div class="rca-bubble">
          ${warnHtml}
          ${renderChatMarkdown(m.content)}
        </div>
      </div>
    `;
  }).join("");
  logEl.scrollTop = logEl.scrollHeight;
}

async function sendRcaChatMessage(rawText) {
  const query = String(rawText || "").trim();
  if (!query || rcaBusy) return;

  const historyPayload = rcaChatMessages
    .filter(m => !m.typing && m.content)
    .slice(-12)
    .map(m => ({ role: m.role, content: m.content }));

  rcaChatMessages.push({ role: "user", content: query });
  rcaChatMessages.push({ role: "assistant", content: "", typing: true });
  renderRcaChatThread();

  const sendBtn = document.getElementById("btn-rca-send");
  const inp = document.getElementById("rca-input");
  rcaBusy = true;
  if (sendBtn) sendBtn.disabled = true;

  try {
    const basisMode = tab3BasisMode === "live" ? "live" : "illustrative";
    const resp = await apiJson("/api/rca-chat", "POST", {
      query,
      history: historyPayload,
      basis_mode: basisMode,
      lang: "auto",
    });
    latestRcaResp = resp;
    rcaChatMessages = rcaChatMessages.filter(m => !m.typing);
    rcaChatMessages.push({
      role: "assistant",
      content: resp.answer_markdown || "",
      warning: resp.warning || null,
    });
    updateRcaHeaderBadge({
      provider: resp.provider,
      model: resp.model,
      label: resp.provider === "ollama" ? `Ollama (${resp.model})` : `Gemini (${resp.model || "3.5-flash"})`,
    });
  } catch (err) {
    rcaChatMessages = rcaChatMessages.filter(m => !m.typing);
    rcaChatMessages.push({
      role: "assistant",
      content: `Chat connection error: \`${err.message}\``,
    });
  } finally {
    rcaBusy = false;
    if (sendBtn) sendBtn.disabled = false;
    renderRcaChatThread();
    if (inp) inp.focus();
    updateAuditHook();
  }
}

function queryRcaAgent(req = {}) {
  const q = typeof req.query === "string" ? req.query.trim() : "";
  if (q) sendRcaChatMessage(q);
}

function openRcaDrawer(req = null) {
  const drawer = document.getElementById("rca-drawer");
  const btn = document.getElementById("btn-rca");
  const inp = document.getElementById("rca-input");
  if (!drawer) return;
  rcaOpen = true;
  drawer.classList.remove("hidden");
  if (btn) btn.classList.add("active");
  renderRcaChatThread();
  refreshRcaLlmStatus();
  if (req && typeof req.query === "string" && req.query.trim()) {
    sendRcaChatMessage(req.query.trim());
  } else if (inp) {
    setTimeout(() => inp.focus(), 40);
  }
  updateAuditHook();
}

function closeRcaDrawer() {
  const drawer = document.getElementById("rca-drawer");
  const btn = document.getElementById("btn-rca");
  if (!drawer) return;
  rcaOpen = false;
  drawer.classList.add("hidden");
  if (btn) btn.classList.remove("active");
  updateAuditHook();
}

function toggleRcaDrawer() {
  if (rcaOpen) closeRcaDrawer();
  else openRcaDrawer();
}

/* ==================== 24H PARITY-SAFE TIMELINE SCRUBBER ==================== */
function renderTimelineScrubber(snap) {
  const host = document.getElementById("tl-bins");
  const cursorEl = document.getElementById("tl-cursor");
  if (!host || !snap.timeline_24h) return;
  if (lastTimelineScenario !== snap.scenario) {
    lastTimelineScenario = snap.scenario;
    const stateLabels = {
      off: "Off-Hours / Gate",
      eligible: "Eligible (No Alert)",
      rule_only: "High-Fan Rule Only",
      ai_only: "AI-Only Early Window (Rule Clean)",
      both: "Both AI & Rule Flagged",
    };
    host.innerHTML = snap.timeline_24h.map(b =>
      `<div class="tl-bin tl-${escapeHtml(b.state)}" data-seek-row="${b.mid_row}" title="${escapeHtml(b.time)} · ${escapeHtml(stateLabels[b.state] || b.state)} (click to seek)"></div>`
    ).join("");
  }
  if (cursorEl && snap.total_rows > 1) {
    const pct = Math.max(0, Math.min(100, (snap.row_index / (snap.total_rows - 1)) * 100));
    cursorEl.style.left = `${pct.toFixed(2)}%`;
  }
}

/* ==================== 6-BEAT GUIDED STAGE STORY CHOREOGRAPHY ==================== */
function setActiveBeatBtn(beatId) {
  activeStoryBeat = beatId;
  document.querySelectorAll("#story-beats .story-btn").forEach(b => b.classList.toggle("active", b.dataset.beat === String(beatId)));
}

function runStoryBeat(beatId) {
  stopPlayback();
  setActiveBeatBtn(beatId);
  const b = String(beatId);
  if (b === "1") {
    fieldChecks.forEach(fc => { fc.state = "pending"; });
    enqueue(async () => {
      renderSnapshot(await apiJson("/api/seek", "POST", { scenario: "normal", row_index: 735 }));
      switchTab("overview");
    });
  } else if (b === "2") {
    // Exact real Oct-01 moment (#640, 10:40): Quan HGB 0.911 FOULING_SUSPECT while Fan 93.9% Rule stays 0/15m!
    fieldChecks.forEach(fc => { fc.state = "pending"; });
    enqueue(async () => {
      renderSnapshot(await apiJson("/api/seek", "POST", { scenario: "fouling_high", row_index: 640 }));
      switchTab("overview");
    });
  } else if (b === "3") {
    enqueue(async () => {
      renderSnapshot(await apiJson("/api/seek", "POST", { scenario: "fouling_high", row_index: 735 }));
      switchTab("trends");
    });
  } else if (b === "4") {
    tab3BasisMode = "live";
    enqueue(async () => {
      await apiJson("/api/seek", "POST", { scenario: "fouling_high", row_index: 735 });
      renderSnapshot(await apiJson("/api/illustrative", "POST", { imposed_excess_kw: 3.0, earlier_pm_day: 28, existing_pm_day: 120, restored_fraction: 1.0 }));
      switchTab("quantify");
    });
  } else if (b === "5") {
    enqueue(async () => {
      await apiJson("/api/seek", "POST", { scenario: "fouling_high", row_index: 735 });
      renderSnapshot(await apiJson("/api/inject-fault", "POST", { fault_type: "domain_ood" }));
      switchTab("derisk");
    });
  } else if (b === "6") {
    fieldChecks[0].state = "ok";
    fieldChecks[1].state = "ok";
    fieldChecks[2].state = "issue";
    fieldChecks[3].state = "ok";
    enqueue(async () => {
      renderSnapshot(await apiJson("/api/seek", "POST", { scenario: "fouling_high", row_index: 735 }));
      switchTab("derisk");
    });
  }
}

function toggleStoryBar(forceOpen = null) {
  const bar = document.getElementById("story-bar");
  const btn = document.getElementById("btn-story");
  if (!bar) return;
  const open = forceOpen !== null ? forceOpen : bar.classList.contains("hidden");
  bar.classList.toggle("hidden", !open);
  if (btn) btn.classList.toggle("active", open);
  updateAuditHook();
}

/* ==================== INTERACTIONS ==================== */
function switchTab(tabId) {
  hideDagFloatingTip();
  activeTabId = tabId;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tabId));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === `tab-${tabId}`));
  if (tabId === "hardware") {
    if (latestHw) {
      if (dirtyTabs.hardware) renderHardwareTab(latestHw, { keepMode: true });
    } else {
      loadHardwareStatus({ keepMode: false });
    }
  } else if (latestSnap && dirtyTabs[tabId]) {
    renderActiveTab(latestSnap);
  }
  updateAuditHook();
}

function stopPlayback() {
  isPlaying = false;
  if (playTimer) clearTimeout(playTimer);
  playTimer = null;
  const btn = document.getElementById("btn-play");
  btn.textContent = "▶ Play";
  btn.classList.remove("playing");
}

function scheduleNextPlayTick() {
  if (!isPlaying) return;
  playTimer = setTimeout(() => {
    if (!isPlaying || isStepping) return;
    isStepping = true;
    const t0 = performance.now();
    enqueue(async () => {
      try {
        renderSnapshot(await apiJson("/api/step", "POST", { steps: 2 }));
      } finally {
        isStepping = false;
        if (isPlaying) {
          const elapsed = performance.now() - t0;
          const delay = Math.max(120, Math.round(520 - elapsed));
          playTimer = setTimeout(scheduleNextPlayTick, delay);
        }
      }
    });
  }, 0);
}

function startPlayback() {
  stopPlayback();
  isPlaying = true;
  const btn = document.getElementById("btn-play");
  btn.textContent = "⏸ Pause";
  btn.classList.add("playing");
  scheduleNextPlayTick();
}

function submitVerdict(verdict) {
  const issues = fieldChecks.filter(fc => fc.state === "issue").map(fc => fc.title);
  const steps = ["I", "II", "III", "IV", "V"];
  if (verdict === "CONFIRMED") steps.push("VI");
  const engInp = document.getElementById("input-engineer");
  const noteInp = document.getElementById("input-note");
  const engineerName = (engInp && engInp.value.trim()) || "Facilities Supervisor (Shift A)";
  const customNote = noteInp ? noteInp.value.trim() : "";
  const defaultNote = verdict === "CONFIRMED"
    ? (issues.length ? `Confirmed via Steps I–IV (${issues.join(", ")}) → Step VI draft brief ready.` : "Confirmed via Steps I–IV → Step VI draft brief ready.")
    : verdict === "FALSE_ALARM"
      ? "Recorded as False Alarm after Steps I–IV review (archived for pilot feedback)."
      : "Marked Inconclusive — 24h observation watch initiated.";
  const note = customNote || defaultNote;
  enqueue(async () => renderSnapshot(await apiJson("/api/acknowledge", "POST", {
    verdict,
    engineer_name: engineerName,
    completed_steps: steps,
    note,
  })));
}

window.addEventListener("DOMContentLoaded", async () => {
  const pidPromise = loadInteractivePid();

  document.querySelectorAll(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  document.getElementById("btn-open-triage").addEventListener("click", () => switchTab("derisk"));

  document.querySelectorAll("#scenario-buttons .seg-btn").forEach(b => {
    b.addEventListener("click", () => {
      stopPlayback();
      resetFieldChecks();
      document.querySelectorAll("#scenario-buttons .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      enqueue(async () => renderSnapshot(await apiJson("/api/scenario", "POST", { scenario: b.dataset.scenario, seek_eligible: true })));
    });
  });

  // Single delegated listener for Step IV interactive field checks (never leaks listeners on re-render)
  const checklistEl = document.getElementById("step4-checklist");
  if (checklistEl) {
    checklistEl.addEventListener("click", evt => {
      const btn = evt.target.closest("[data-field-id]");
      if (!btn) return;
      const item = fieldChecks.find(x => x.id === btn.dataset.fieldId);
      if (!item) return;
      item.state = item.state === "pending" ? "ok" : item.state === "ok" ? "issue" : "pending";
      item.source = item.state === "pending" ? "" : "Manual";
      if (latestSnap) renderTriageWorkbench(latestSnap);
    });
  }

  // Step IV: Sync Field Camera Scenario to Step IV (Advisory Only — Human Step V required)
  const btnStep4Ai = document.getElementById("btn-step4-ai");
  if (btnStep4Ai) {
    btnStep4Ai.addEventListener("click", () => {
      enqueue(async () => applyHardwareToStep4(false));
    });
  }

  // Tab 5: Clean Field Camera Scenario Presets & Channel Switcher
  document.querySelectorAll("#hw-preset-buttons .seg-btn").forEach(b => {
    b.addEventListener("click", () => {
      const preset = b.dataset.preset;
      document.querySelectorAll("#hw-preset-buttons .seg-btn").forEach(x => x.classList.toggle("active", x === b));
      enqueue(async () => {
        const hw = await apiJson("/api/hardware/simulate?img_fmt=jpeg", "POST", { preset });
        renderHardwareTab(hw, { keepMode: false });
      });
    });
  });

  document.querySelectorAll("#hw-vision-modes .dt-btn").forEach(b => {
    b.addEventListener("click", () => {
      activeHwVisionMode = b.dataset.mode;
      if (latestHw) renderHardwareTab(latestHw, { keepMode: true });
    });
  });

  document.querySelectorAll("#excess-kw-buttons .seg-btn").forEach(b => {
    b.addEventListener("click", () => {
      if (b.dataset.mode === "live") {
        tab3BasisMode = "live";
        if (latestSnap) renderSnapshot(latestSnap);
      } else {
        tab3BasisMode = "manual";
        enqueue(async () => renderSnapshot(await apiJson("/api/illustrative", "POST", { imposed_excess_kw: Number(b.dataset.kw) })));
      }
    });
  });

  document.querySelectorAll("#clean-day-buttons .seg-btn").forEach(b => {
    b.addEventListener("click", () => {
      enqueue(async () => renderSnapshot(await apiJson("/api/illustrative", "POST", { earlier_pm_day: Number(b.dataset.day) })));
    });
  });

  document.querySelectorAll("#cal-day-buttons .seg-btn").forEach(b => {
    b.addEventListener("click", () => {
      enqueue(async () => renderSnapshot(await apiJson("/api/illustrative", "POST", { existing_pm_day: Number(b.dataset.cal) })));
    });
  });

  document.querySelectorAll("#restore-buttons .seg-btn").forEach(b => {
    b.addEventListener("click", () => {
      enqueue(async () => renderSnapshot(await apiJson("/api/illustrative", "POST", { restored_fraction: Number(b.dataset.rest) })));
    });
  });

  const resetIllusBtn = document.getElementById("btn-reset-illus");
  if (resetIllusBtn) {
    resetIllusBtn.addEventListener("click", () => {
      tab3BasisMode = "manual";
      enqueue(async () => renderSnapshot(await apiJson("/api/illustrative", "POST", { reset_defaults: true })));
    });
  }

  // Tab 3 MONEY Card: Compact PM Cost Preset Toggle (4M / 8M / 15M VND) + Click-to-Switch Conditional Table
  document.querySelectorAll("#pm-cost-buttons .pm-mini-btn").forEach(b => {
    b.addEventListener("click", () => {
      const pmCost = Number(b.dataset.pm);
      enqueue(async () => renderSnapshot(await apiJson("/api/pm-optimizer", "POST", { pm_cost_vnd: pmCost })));
    });
  });
  const condTblEl = document.getElementById("cond-elec-table");
  if (condTblEl) {
    condTblEl.addEventListener("click", evt => {
      const tr = evt.target.closest("[data-cond-scen]");
      if (!tr) return;
      const scen = tr.getAttribute("data-cond-scen");
      if (!scen || (latestSnap && latestSnap.scenario === scen)) return;
      stopPlayback();
      resetFieldChecks();
      enqueue(async () => renderSnapshot(await apiJson("/api/scenario", "POST", { scenario: scen, seek_eligible: true })));
    });
  }

  // Tab 2: Power Chart View Toggle (Excess ΔkW* <-> Total kW) & Click-to-Switch Recall Rows
  document.querySelectorAll("#power-view-toggle .dt-btn").forEach(b => {
    b.addEventListener("click", () => {
      tab2PowerMode = b.dataset.pview === "total" ? "total" : "delta";
      document.querySelectorAll("#power-view-toggle .dt-btn").forEach(x => x.classList.toggle("active", x.dataset.pview === tab2PowerMode));
      if (latestSnap) window.drawPowerTrendSvg(document.getElementById("chart-power"), latestSnap.history, tab2PowerMode);
    });
  });
  const limitsGridEl = document.getElementById("limits-grid");
  if (limitsGridEl) {
    limitsGridEl.addEventListener("click", evt => {
      const tile = evt.target.closest("[data-rc-scen]");
      if (!tile) return;
      const scen = tile.getAttribute("data-rc-scen");
      if (!scen || (latestSnap && latestSnap.scenario === scen)) return;
      stopPlayback();
      resetFieldChecks();
      enqueue(async () => renderSnapshot(await apiJson("/api/scenario", "POST", { scenario: scen, seek_eligible: true })));
    });
  }

  // Tab 4 Step III: Causal DAG vs 4 Cards Segmented Toggle
  document.querySelectorAll("#dag-view-toggle .dt-btn").forEach(b => {
    b.addEventListener("click", () => setStep3View(b.dataset.view));
  });

  // Clean LLM Chat Drawer Wiring
  const btnRca = document.getElementById("btn-rca");
  if (btnRca) btnRca.addEventListener("click", toggleRcaDrawer);
  const btnCloseRca = document.getElementById("btn-close-rca");
  if (btnCloseRca) btnCloseRca.addEventListener("click", closeRcaDrawer);
  const btnClearRca = document.getElementById("btn-clear-rca");
  if (btnClearRca) {
    btnClearRca.addEventListener("click", () => {
      rcaChatMessages = [];
      renderRcaChatThread();
      const inp = document.getElementById("rca-input");
      if (inp) inp.focus();
    });
  }

  const btnKeyToggle = document.getElementById("btn-rca-key-toggle");
  const keyBar = document.getElementById("rca-key-bar");
  const keyInp = document.getElementById("rca-key-input");
  if (btnKeyToggle && keyBar) {
    btnKeyToggle.addEventListener("click", () => {
      keyBar.classList.toggle("hidden");
      if (!keyBar.classList.contains("hidden") && keyInp) keyInp.focus();
    });
  }
  if (keyBar) {
    keyBar.addEventListener("submit", async evt => {
      evt.preventDefault();
      const val = keyInp ? keyInp.value.trim() : "";
      try {
        const st = await apiJson("/api/rca-chat/key", "POST", { api_key: val });
        updateRcaHeaderBadge(st);
        if (keyInp) keyInp.value = "";
        keyBar.classList.add("hidden");
      } catch (_) {}
    });
  }

  const rcaForm = document.getElementById("rca-form");
  if (rcaForm) {
    rcaForm.addEventListener("submit", evt => {
      evt.preventDefault();
      const inp = document.getElementById("rca-input");
      const q = inp ? inp.value.trim() : "";
      if (!q || rcaBusy) return;
      if (inp) inp.value = "";
      sendRcaChatMessage(q);
    });
  }

  document.querySelectorAll("#fault-buttons .g-btn").forEach(b => {
    b.addEventListener("click", () => {
      stopPlayback();
      enqueue(async () => renderSnapshot(await apiJson("/api/inject-fault", "POST", { fault_type: b.dataset.fault })));
    });
  });

  document.getElementById("btn-clear-fault-banner").addEventListener("click", () => {
    enqueue(async () => renderSnapshot(await apiJson("/api/inject-fault", "POST", { fault_type: "none" })));
  });
  document.getElementById("btn-jump-eligible").addEventListener("click", () => {
    stopPlayback();
    enqueue(async () => renderSnapshot(await apiJson("/api/jump", "POST", { kind: "eligible" })));
  });

  document.getElementById("btn-play").addEventListener("click", () => (isPlaying ? stopPlayback() : startPlayback()));
  document.getElementById("btn-jump-alert").addEventListener("click", () => {
    stopPlayback();
    enqueue(async () => renderSnapshot(await apiJson("/api/jump", "POST", { kind: "alert" })));
  });
  document.getElementById("btn-step15").addEventListener("click", () => {
    enqueue(async () => renderSnapshot(await apiJson("/api/step", "POST", { steps: 15 })));
  });
  document.getElementById("btn-reset").addEventListener("click", () => {
    stopPlayback();
    fieldChecks.forEach(fc => { fc.state = "pending"; });
    enqueue(async () => renderSnapshot(await apiJson("/api/reset", "POST")));
  });

  document.querySelectorAll("[data-verdict]").forEach(b => b.addEventListener("click", () => submitVerdict(b.dataset.verdict)));

  document.getElementById("btn-theme").addEventListener("click", () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    applyThemeToPid();
    dirtyTabs.overview = dirtyTabs.trends = dirtyTabs.quantify = dirtyTabs.derisk = dirtyTabs.hardware = true;
    if (latestSnap) renderSnapshot(latestSnap);
    if (activeTabId === "hardware" && latestHw) renderHardwareTab(latestHw, { keepMode: true });
  });

  // 24h Parity-Safe Timeline Scrubber click-to-seek (delegated)
  const tlBins = document.getElementById("tl-bins");
  if (tlBins) {
    tlBins.addEventListener("click", evt => {
      const bin = evt.target.closest("[data-seek-row]");
      if (!bin) return;
      stopPlayback();
      const targetRow = Number(bin.getAttribute("data-seek-row"));
      enqueue(async () => {
        if (latestSnap && latestSnap.injection !== "none") {
          await apiJson("/api/inject-fault", "POST", { fault_type: "none" });
        }
        renderSnapshot(await apiJson("/api/seek", "POST", { row_index: targetRow }));
      });
    });
  }

  // Story Bar toggle & 6 Guided Stage Beats
  const btnStory = document.getElementById("btn-story");
  if (btnStory) btnStory.addEventListener("click", () => toggleStoryBar());
  document.querySelectorAll("#story-beats .story-btn").forEach(b => {
    b.addEventListener("click", () => runStoryBeat(b.dataset.beat));
  });

  // Presenter Keyboard Shortcuts (ignored while typing inside form inputs)
  window.addEventListener("keydown", evt => {
    const tag = (evt.target && evt.target.tagName) ? evt.target.tagName.toUpperCase() : "";
    if (evt.key === "Escape") {
      closeRcaDrawer();
      return;
    }
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return;
    if (evt.key === "1") switchTab("overview");
    else if (evt.key === "2") switchTab("trends");
    else if (evt.key === "3") switchTab("quantify");
    else if (evt.key === "4") switchTab("derisk");
    else if (evt.key === "5") switchTab("hardware");
    else if (evt.key === " ") { evt.preventDefault(); isPlaying ? stopPlayback() : startPlayback(); }
    else if (evt.key === "s" || evt.key === "S") toggleStoryBar();
    else if (evt.key === "t" || evt.key === "T") document.getElementById("btn-theme")?.click();
    else if (evt.key === "a" || evt.key === "A") toggleRcaDrawer();
    else if (evt.key === "n" || evt.key === "N") {
      const jb = document.getElementById("btn-jump-alert");
      if (jb && !jb.disabled) jb.click();
    }
    else if (evt.key === "r" || evt.key === "R") document.getElementById("btn-reset")?.click();
  });

  const qp = new URLSearchParams(window.location.search);
  const qTheme = qp.get("theme");
  if (qTheme === "dark" || qTheme === "light") {
    document.documentElement.setAttribute("data-theme", qTheme);
    applyThemeToPid();
  }
  if (qp.get("story") === "1") toggleStoryBar(true);
  if (qp.get("basis") === "manual") tab3BasisMode = "manual";
  else if (qp.get("basis") === "live") tab3BasisMode = "live";
  const qStep3 = qp.get("step3");
  if (qStep3 === "cards" || qStep3 === "dag") step3ViewMode = qStep3;
  if (qp.get("field") === "issue") {
    fieldChecks[0].state = "ok";
    fieldChecks[1].state = "ok";
    fieldChecks[2].state = "issue";
    fieldChecks[3].state = "ok";
  }

  const qTab = qp.get("tab");
  if (qTab && ["overview", "trends", "quantify", "derisk", "hardware"].includes(qTab)) switchTab(qTab);

  // Fast parallel boot: fetch /api/state + P&ID SVG immediately; lazy-load Tab 5 hardware in background
  await enqueue(async () => {
    const qHwPreset = qp.get("hw_preset");
    const qHwMode = qp.get("hw_mode");
    const needHwImmediate = Boolean(qHwPreset || qHwMode || qTab === "hardware" || qp.get("apply_step4") === "1");

    const statePromise = qp.get("apply_step4") === "1"
      ? null
      : apiJson("/api/state").then(snap => {
          renderSnapshot(snap);
          return snap;
        });

    if (needHwImmediate) {
      if (qHwPreset) {
        const hw = await apiJson("/api/hardware/simulate?img_fmt=jpeg", "POST", {
          preset: qHwPreset,
          vision_mode: qHwMode || undefined,
        });
        if (qHwMode) activeHwVisionMode = qHwMode;
        renderHardwareTab(hw, { keepMode: Boolean(qHwMode) });
      } else {
        await loadHardwareStatus({ keepMode: false });
        if (qHwMode && ["fill_strainer", "spray_flow", "basin_water"].includes(qHwMode)) {
          activeHwVisionMode = qHwMode;
          if (latestHw) renderHardwareTab(latestHw, { keepMode: true });
        }
      }
      if (qp.get("apply_step4") === "1") {
        await applyHardwareToStep4(false);
      } else if (statePromise) {
        await statePromise;
      }
    } else {
      await Promise.all([pidPromise, statePromise]);
      // Pre-warm Tab 5 hardware asynchronously in background after Tab 1 is already interactive
      setTimeout(() => {
        if (!latestHw) loadHardwareStatus({ keepMode: false });
      }, 250);
    }
  });
  if (qp.get("rca") === "1") {
    const qPreset = qp.get("rca_preset");
    const qQuery = qp.get("rca_query");
    const qLang = qp.get("rca_lang") || "auto";
    openRcaDrawer(
      qQuery
        ? { preset: null, query: qQuery, lang: qLang }
        : { preset: qPreset || "why_alert", query: "", lang: qLang }
    );
  }
});
