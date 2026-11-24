"""Real LLM-Powered Grounded RCA & Engineering Chat Engine for Chiller FaultGuard v13.

Supports:
1. Google Gemini API (`gemini-2.5-flash` -> `gemini-2.0-flash` automatic fallback) via `GEMINI_API_KEY` / `GOOGLE_API_KEY`
   or `.env` file (works both locally and on Vercel serverless).
2. Local Ollama (`http://127.0.0.1:11434/api/chat`) auto-detection when running air-gapped on a local machine.
3. Dynamic Offline Reasoning Fallback powered by live historical trend lookbacks ([T8:Trend]) and
   arbitrary What-If EVN TOU payback math ([T9:WhatIf]) when neither API key nor Ollama is active yet.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .rca_agent import (
    detect_control_write_request,
    detect_language,
    run_airgapped_rca_agent,
)
from .runtime import CASES

DT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE_CANDIDATES = (
    DT_ROOT / ".env",
    DT_ROOT.parent / ".env",
)

GEMINI_MODELS = (
    "gemini-3.5-flash",
    "gemini-3.8-flash",
    "gemini-flash-latest",
    "gemini-3.0-flash",
)
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"

# Runtime in-memory API key & active model cache
_RUNTIME_GEMINI_KEY: str = ""
_ACTIVE_GEMINI_MODEL: str = ""


def _read_dotenv_vars() -> Dict[str, str]:
    out: Dict[str, str] = {}
    for p in ENV_FILE_CANDIDATES:
        if not p.is_file():
            continue
        try:
            for raw in p.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and v and k not in out:
                    out[k] = v
        except Exception:
            continue
    return out


def get_configured_gemini_key() -> str:
    if _RUNTIME_GEMINI_KEY.strip():
        return _RUNTIME_GEMINI_KEY.strip()
    for env_name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"):
        val = os.environ.get(env_name, "").strip()
        if val:
            return val
    dotenv = _read_dotenv_vars()
    return (dotenv.get("GEMINI_API_KEY") or dotenv.get("GOOGLE_API_KEY") or "").strip()


def save_gemini_key(api_key: str) -> Dict[str, Any]:
    """Store Gemini API key in memory and persist to digital_twin/.env if filesystem is writable."""
    global _RUNTIME_GEMINI_KEY
    clean = (api_key or "").strip()
    _RUNTIME_GEMINI_KEY = clean
    if clean:
        os.environ["GEMINI_API_KEY"] = clean
    else:
        os.environ.pop("GEMINI_API_KEY", None)

    persisted_file: Optional[str] = None
    env_path = DT_ROOT / ".env"
    try:
        lines: List[str] = []
        if env_path.is_file():
            for raw in env_path.read_text(encoding="utf-8").splitlines():
                if not raw.strip().startswith("GEMINI_API_KEY="):
                    lines.append(raw)
        if clean:
            lines.append(f"GEMINI_API_KEY={clean}")
        env_path.write_text("\n".join(lines).strip() + ("\n" if lines else ""), encoding="utf-8")
        persisted_file = str(env_path)
    except Exception:
        # Read-only serverless filesystem (e.g. Vercel): in-memory + Vercel Env Vars still work
        persisted_file = None

    status = get_llm_status(probe_ollama=False)
    status["persisted_to_dotenv"] = persisted_file is not None
    return status


def _probe_ollama_model() -> Tuple[bool, Optional[str], str]:
    host = (os.environ.get("OLLAMA_HOST") or _read_dotenv_vars().get("OLLAMA_HOST") or DEFAULT_OLLAMA_HOST).rstrip("/")
    if not host.startswith("http"):
        host = f"http://{host}"
    forced_model = (os.environ.get("OLLAMA_MODEL") or _read_dotenv_vars().get("OLLAMA_MODEL") or "").strip()
    try:
        req = urllib.request.Request(f"{host}/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=0.65) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        models = [str(m.get("name", "")) for m in (data.get("models") or []) if m.get("name")]
        if forced_model:
            return True, forced_model, host
        if not models:
            return False, None, host
        preferred = ("qwen2.5", "qwen3", "llama3", "gemma", "mistral", "deepseek")
        for pref in preferred:
            for m in models:
                if pref in m.lower():
                    return True, m, host
        return True, models[0], host
    except Exception:
        return False, None, host


def get_llm_status(probe_ollama: bool = True) -> Dict[str, Any]:
    gkey = get_configured_gemini_key()
    if gkey:
        masked = f"{gkey[:4]}…{gkey[-4:]}" if len(gkey) > 10 else "configured"
        m_id = _ACTIVE_GEMINI_MODEL or GEMINI_MODELS[0]
        return {
            "provider": "gemini",
            "model": m_id,
            "label": f"Gemini ({m_id.replace('gemini-', '')})",
            "ready": True,
            "key_configured": True,
            "key_masked": masked,
        }
    if probe_ollama:
        ok_ol, ol_model, ol_host = _probe_ollama_model()
        if ok_ol and ol_model:
            return {
                "provider": "ollama",
                "model": ol_model,
                "label": f"Ollama ({ol_model})",
                "host": ol_host,
                "ready": True,
                "key_configured": False,
            }
    return {
        "provider": "local_dynamic",
        "model": "dynamic-grounded-v13",
        "label": "Local Grounded (Set Gemini Key for Full LLM)",
        "ready": False,
        "key_configured": False,
    }


# ---------------------------------------------------------------------------
# Dynamic Grounding Tools: [T8:Trend] Lookbacks & [T9:WhatIf] Custom Payback
# ---------------------------------------------------------------------------

def _f_to_c(temp_f: float) -> float:
    return (temp_f - 32.0) * (5.0 / 9.0)


def compute_trend_lookbacks(rt: Any, snap: Dict[str, Any]) -> Dict[str, Any]:
    """[T8:Trend] Compute exact 5m / 15m / 30m / 60m lookback deltas and first alert timestamps."""
    scen = str(snap.get("scenario", getattr(rt, "scenario", "normal")))
    idx = int(snap.get("row_index", getattr(rt, "cursor", 0)))
    rows = rt.fixture.get(CASES.get(scen, "normal"), [])
    if not rows or not (0 <= idx < len(rows)):
        return {}

    cur = rows[idx]
    cur_out_c = _f_to_c(float(cur["CT_SW_TEMP_1"]))
    cur_in_c = _f_to_c(float(cur["CT_RW_TEMP_1"]))
    cur_rng_c = cur_in_c - cur_out_c
    cur_fan = float(cur["CT_FAN_SPD_1"]) * 100.0
    cur_flow = float(cur["CT_FLOW_1"])
    cur_kw = float(cur["plant_kW"])
    cur_dkw = float(cur["plant_kW"]) - float(cur["normal_plant_kW"])
    cur_sc = snap.get("prediction", {}).get("ai_score")

    lookbacks: Dict[str, Any] = {}
    for mins in (5, 15, 30, 60):
        p_idx = idx - mins
        if p_idx < 0:
            continue
        pr = rows[p_idx]
        p_out_c = _f_to_c(float(pr["CT_SW_TEMP_1"]))
        p_in_c = _f_to_c(float(pr["CT_RW_TEMP_1"]))
        p_rng_c = p_in_c - p_out_c
        p_fan = float(pr["CT_FAN_SPD_1"]) * 100.0
        p_flow = float(pr["CT_FLOW_1"])
        p_kw = float(pr["plant_kW"])
        p_dkw = float(pr["plant_kW"]) - float(pr["normal_plant_kW"])
        p_sc = pr.get("ai_score")
        lookbacks[f"{mins}m_ago"] = {
            "timestamp": str(pr["time"])[11:16],
            "tower_outlet_c": round(p_out_c, 2),
            "delta_outlet_c": round(cur_out_c - p_out_c, 2),
            "tower_inlet_c": round(p_in_c, 2),
            "delta_inlet_c": round(cur_in_c - p_in_c, 2),
            "tower_range_c": round(p_rng_c, 2),
            "delta_range_c": round(cur_rng_c - p_rng_c, 2),
            "fan_pct": round(p_fan, 1),
            "delta_fan_pct": round(cur_fan - p_fan, 1),
            "flow_gpm": round(p_flow, 1),
            "delta_flow_gpm": round(cur_flow - p_flow, 1),
            "plant_kw": round(p_kw, 1),
            "delta_plant_kw": round(cur_kw - p_kw, 1),
            "excess_dkw": round(p_dkw, 2),
            "delta_excess_dkw": round(cur_dkw - p_dkw, 2),
            "ai_score_then": round(float(p_sc), 3) if p_sc is not None else None,
            "delta_ai_score": round(float(cur_sc) - float(p_sc), 3) if (cur_sc is not None and p_sc is not None) else None,
        }

    # Find first AI alert and first Rule alert up to current row (and across full 24h day)
    first_ai_ts = next((str(r["time"])[11:16] for r in rows[: idx + 1] if r.get("ai_alert")), None)
    first_rule_ts = next((str(r["time"])[11:16] for r in rows[: idx + 1] if r.get("rule_alert")), None)
    day_first_ai_idx = next((i for i, r in enumerate(rows) if r.get("ai_alert")), None)
    day_first_rule_idx = next((i for i, r in enumerate(rows) if r.get("rule_alert")), None)
    lead_min_today = (
        (day_first_rule_idx - day_first_ai_idx)
        if (day_first_ai_idx is not None and day_first_rule_idx is not None)
        else None
    )

    return {
        "current_time": str(cur["time"])[11:16],
        "lookbacks": lookbacks,
        "first_ai_alert_so_far": first_ai_ts,
        "first_rule_alert_so_far": first_rule_ts,
        "full_day_first_ai_alert": str(rows[day_first_ai_idx]["time"])[11:16] if day_first_ai_idx is not None else None,
        "full_day_first_rule_alert": str(rows[day_first_rule_idx]["time"])[11:16] if day_first_rule_idx is not None else None,
        "ai_lead_over_rule_minutes_on_oct01": lead_min_today,
    }


def _extract_custom_pm_cost_vnd(query: str) -> Optional[float]:
    if not query:
        return None
    low = query.lower()
    # Match "5 triệu", "5.5 trieu", "5tr", "5m", "5,000,000"
    m_tr = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:triệu|trieu|tr\b|m\b|million)", low)
    if m_tr:
        val = float(m_tr.group(1).replace(",", "."))
        if 0.2 <= val <= 500:
            return round(val * 1_000_000.0, 0)
    m_raw = re.search(r"(\d{1,3}(?:[.,]\d{3}){2})\s*(?:₫|đ|vnd|đồng|dong)?", low)
    if m_raw:
        digits = re.sub(r"[^\d]", "", m_raw.group(1))
        if digits:
            val = float(digits)
            if 200_000 <= val <= 500_000_000:
                return val
    return None


def compute_whatif_economics(snap: Dict[str, Any], basis_mode: str, query: str) -> Dict[str, Any]:
    """[T9:WhatIf] Exact EVN 22kV TOU payback table + custom PM cost calculation from user query."""
    elec = snap.get("electricity", {}) or {}
    live_sim = elec.get("live_alert_projection", {}) or {}
    ill_sim = elec.get("illustrative_scenario", {}) or {}
    # If live basis has 0 excess (e.g. Normal standby), also compute against 3 kW baseline so What-If questions always get a concrete answer!
    active_sim = live_sim if (basis_mode == "live" and float(live_sim.get("imposed_excess_kw", 0.0)) > 0) else ill_sim
    eff_kw = float(active_sim.get("imposed_excess_kw", 3.0))
    hrs = float(active_sim.get("hours_per_day", 24.0))
    early_d = int(active_sim.get("earlier_pm_day", 28))
    exist_d = int(active_sim.get("existing_pm_day", 120))
    days_saved = max(0, exist_d - early_d)
    rest = float(active_sim.get("restored_fraction", 1.0))
    tariff = 1925.93

    daily_burn_vnd = eff_kw * hrs * rest * tariff
    avoided_kwh = eff_kw * hrs * days_saved * rest
    avoided_gross_vnd = avoided_kwh * tariff

    def calc_for_pm(pm_vnd: float) -> Dict[str, Any]:
        pb_days = round(pm_vnd / daily_burn_vnd, 1) if daily_burn_vnd > 0 else None
        pb_cal = round(early_d + pb_days, 1) if pb_days is not None else None
        net_vnd = round(avoided_gross_vnd - pm_vnd, 0)
        roi_pct = round((net_vnd / pm_vnd) * 100.0, 1) if pm_vnd > 0 else 0.0
        profitable = pb_cal is not None and pb_cal <= exist_d and net_vnd > 0
        return {
            "pm_cost_vnd": int(pm_vnd),
            "pm_cost_million_vnd": round(pm_vnd / 1e6, 2),
            "payback_days": pb_days,
            "payback_calendar_day": pb_cal,
            "net_benefit_vnd": int(net_vnd),
            "roi_pct": roi_pct,
            "verdict": "CLEAN_NOW_POSITIVE_ROI" if profitable else "DEFER_PM_NEGATIVE_ROI",
        }

    custom_pm = _extract_custom_pm_cost_vnd(query)
    grid_costs = [3_000_000, 4_000_000, 5_000_000, 6_000_000, 8_000_000, 10_000_000, 12_000_000, 15_000_000]
    if custom_pm and int(custom_pm) not in grid_costs:
        grid_costs.append(int(custom_pm))
        grid_costs.sort()

    return {
        "basis_used": "live_active_alert" if (active_sim is live_sim and float(live_sim.get("imposed_excess_kw", 0.0)) > 0) else "3kw_baseline_template",
        "eff_excess_kw": round(eff_kw, 2),
        "earlier_pm_day": early_d,
        "calendar_pm_day": exist_d,
        "days_saved": days_saved,
        "restored_pct": round(rest * 100.0, 0),
        "tariff_22kv_tou_vnd_kwh": tariff,
        "daily_burn_ex_vat_vnd": round(daily_burn_vnd, 0),
        "avoided_kwh": round(avoided_kwh, 1),
        "avoided_gross_ex_vat_vnd": round(avoided_gross_vnd, 0),
        "queried_custom_pm": calc_for_pm(custom_pm) if custom_pm else None,
        "pm_cost_sensitivity_table": [calc_for_pm(c) for c in grid_costs],
    }


def build_grounded_llm_context(rt: Any, snap: Dict[str, Any], query: str, basis_mode: str) -> Dict[str, Any]:
    """Assemble compact, complete live engineering context JSON for the LLM."""
    base_rca = run_airgapped_rca_agent(snap, query=query or "status", basis_mode=basis_mode, lang="auto")
    t_payloads = {t["id"]: t["payload"] for t in base_rca.get("tool_traces", [])}
    sig = snap.get("signals", {}) or {}
    return {
        "plant_identity": "Chiller FaultGuard v13.0 — Air-Gapped Cooling Tower (CT-1) Digital Twin (LBNL Held-Out Oct-01 Replay)",
        "governance": {
            "iec_62443_read_only": True,
            "controls_enabled": False,
            "plc_bms_write_allowed": False,
            "scientific_3_bucket_rule": "verified_excess_kwh=null, verified_avoided_kwh=null, verified_water_savings=null until 90-day Site Pilot",
        },
        "live_snapshot": {
            "timestamp": snap.get("timestamp"),
            "scenario_key": snap.get("scenario"),
            "scenario_label": (snap.get("case_meta") or {}).get("label"),
            "row_index_1based": int(snap.get("row_index", 0)) + 1,
            "overall_status": snap.get("status"),
            "ai_vs_rule_agreement": snap.get("agreement"),
            "signals": sig,
        },
        "T1_safety_gates": t_payloads.get("T1"),
        "T2_quan_frozen_hgb": t_payloads.get("T2"),
        "T3_causal_dag": t_payloads.get("T3"),
        "T4_evn_tou_current": t_payloads.get("T4"),
        "T5_esg_carbon_water": t_payloads.get("T5"),
        "T8_historical_trends": compute_trend_lookbacks(rt, snap),
        "T9_whatif_payback_calculator": compute_whatif_economics(snap, basis_mode=basis_mode, query=query),
        "step4_field_checks": snap.get("field_checks"),
        "step5_supervisor_review": snap.get("review"),
    }


SYSTEM_INSTRUCTION = """You are **FaultGuard AI**, a sharp, friendly Senior Chiller Plant & Cooling Tower Reliability Engineer embedded inside **Chiller FaultGuard v13.0**.

### Core Behavior
1. **Answer ANY question naturally and directly:**
   - Whether the user says hello, asks a casual/general question, asks why AI flagged before the High-Fan Rule, asks how temperatures/power changed vs 15 minutes ago, asks a What-If payback question (e.g. "if PM cost drops to 5M VND"), or asks general thermodynamics/HVAC/semiconductor utility questions — answer directly, intelligently, and helpfully! Never dump a generic canned report that ignores their actual question.
2. **Strict Grounding on Live Plant Data:**
   - Whenever referencing the current state of CT-1 / Chiller Plant, use **ONLY** the exact numbers in `[LIVE_PLANT_CONTEXT]`. Never invent sensor readings.
   - Format numbers cleanly in `en-US` style (comma thousands, dot decimals: e.g. `2,208 h`, `6,182.4 kWh`, `1,926 ₫/kWh`, `17.62 °C*`).
   - Why Quan HGB beats High-Fan Rule (`>98%` for `15m`): The rule waits blindly until CT-1 Fan VFD exceeds `98.0%` for 15 consecutive minutes. Quan's multivariate `HistGradientBoostingClassifier` (`threshold > 0.70` for `5m`) evaluates 6 native inputs simultaneously (`Water Range ΔT`, `CT-1 Fan`, `CT-1 Flow`, `CT-1 Outlet*`, `Cooling Load*`, `Fan × Range`), catching degraded heat rejection while the fan is still ramping (e.g. `85%–97%`) with `97.8%` precision!
3. **Safety & Scientific Honesty:**
   - If the user asks you to turn off/on equipment, change setpoints, open/close valves, or write to PLC/BMS, politely refuse actuation because Chiller FaultGuard operates under **IEC 62443-3-3 Read-Only Advisory Mode (`controls=false`)**, and guide them through human Supervisor Step V–VI CMMS workflow instead.
   - Treat EVN TOU kWh/VND/CO₂/water savings as illustrative/estimated projections (verified site savings require a 90-day shadow-mode Site Pilot).
4. **Crystal-Clear Visual Formatting (Crucial):**
   - Match the user's language automatically (respond in natural Vietnamese if asked in Vietnamese; English if asked in English).
   - Start with a **direct 1–2 sentence answer** to their exact question.
   - Use clean **bullet points** (`- `) with **bold key metrics** so an engineer can scan in 3 seconds. Keep responses concise and well-spaced (avoid long dense paragraphs).
"""


# ---------------------------------------------------------------------------
# LLM Providers: Gemini REST API & Local Ollama REST API
# ---------------------------------------------------------------------------

def _discover_gemini_models(api_key: str) -> List[str]:
    """Query Google ListModels API to auto-discover live generateContent Flash/Pro models on this key."""
    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}"
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=6.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        flash_list: List[str] = []
        other_list: List[str] = []
        for m in data.get("models") or []:
            methods = m.get("supportedGenerationMethods") or []
            if "generateContent" not in methods:
                continue
            raw_name = str(m.get("name", "")).replace("models/", "").strip()
            low = raw_name.lower()
            if not raw_name or "embedding" in low or "imagen" in low or "veo" in low or "tts" in low or "audio" in low:
                continue
            if "flash" in low and "lite" not in low:
                flash_list.append(raw_name)
            elif "gemini" in low:
                other_list.append(raw_name)
        flash_list.sort(reverse=True)
        other_list.sort(reverse=True)
        return flash_list + other_list
    except Exception:
        return []


def _call_gemini_api(
    api_key: str,
    query: str,
    history: List[Dict[str, str]],
    context_obj: Dict[str, Any],
) -> Tuple[str, str]:
    global _ACTIVE_GEMINI_MODEL
    context_json = json.dumps(context_obj, ensure_ascii=False, separators=(",", ":"))
    contents: List[Dict[str, Any]] = []
    for msg in (history or [])[-8:]:
        role_in = str(msg.get("role", "user")).lower()
        txt = str(msg.get("content", "")).strip()
        if not txt:
            continue
        g_role = "model" if role_in in ("assistant", "model") else "user"
        contents.append({"role": g_role, "parts": [{"text": txt[:2500]}]})

    user_turn_text = (
        f"[LIVE_PLANT_CONTEXT]\n{context_json}\n[/LIVE_PLANT_CONTEXT]\n\n"
        f"User question: {query}"
    )
    contents.append({"role": "user", "parts": [{"text": user_turn_text}]})

    payload_bytes = json.dumps(
        {
            "systemInstruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
            "contents": contents,
            "generationConfig": {
                "temperature": 0.25,
                "maxOutputTokens": 4096,
            },
        },
        ensure_ascii=False,
    ).encode("utf-8")

    # Prioritize cached working model -> GEMINI_MODELS -> live ListModels discovery on 404
    env_override = (os.environ.get("GEMINI_MODEL") or _read_dotenv_vars().get("GEMINI_MODEL") or "").strip()
    candidates_order: List[str] = []
    for m in ([env_override, _ACTIVE_GEMINI_MODEL] + list(GEMINI_MODELS)):
        if m and m not in candidates_order:
            candidates_order.append(m)

    def _try_model(model_name: str) -> Tuple[Optional[str], Optional[int], str]:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"
        req = urllib.request.Request(
            url,
            data=payload_bytes,
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=22.0) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            cands = body.get("candidates") or []
            if cands:
                parts = (cands[0].get("content") or {}).get("parts") or []
                vis = [str(p.get("text", "")) for p in parts if "text" in p and not p.get("thought")]
                text = "".join(vis).strip() or "".join(str(p.get("text", "")) for p in parts if "text" in p).strip()
                if text:
                    return text, 200, ""
            return None, 200, f"Empty Gemini response from {model_name}"
        except urllib.error.HTTPError as exc:
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="ignore")[:260]
            except Exception:
                pass
            if exc.code in (400, 401, 403) and ("API_KEY" in err_body.upper() or "KEY_INVALID" in err_body.upper() or exc.code in (401, 403)):
                raise RuntimeError(f"Invalid or rejected Gemini API Key (HTTP {exc.code}).") from exc
            return None, exc.code, f"HTTP {exc.code} on {model_name}: {err_body}"
        except Exception as exc:
            return None, None, str(exc)

    last_err = ""
    saw_404 = False
    for m_name in candidates_order:
        txt, code, err = _try_model(m_name)
        if txt:
            _ACTIVE_GEMINI_MODEL = m_name
            return txt, m_name
        if code == 404:
            saw_404 = True
        last_err = err

    if saw_404:
        for m_name in _discover_gemini_models(api_key):
            if m_name in candidates_order:
                continue
            txt, _, err = _try_model(m_name)
            if txt:
                _ACTIVE_GEMINI_MODEL = m_name
                return txt, m_name
            last_err = err

    raise RuntimeError(last_err or "Gemini API call failed")


def _call_ollama_api(
    host: str,
    model_name: str,
    query: str,
    history: List[Dict[str, str]],
    context_obj: Dict[str, Any],
) -> Tuple[str, str]:
    context_json = json.dumps(context_obj, ensure_ascii=False, separators=(",", ":"))
    messages: List[Dict[str, str]] = [{"role": "system", "content": SYSTEM_INSTRUCTION}]
    for msg in (history or [])[-6:]:
        r = "assistant" if str(msg.get("role", "")).lower() in ("assistant", "model") else "user"
        txt = str(msg.get("content", "")).strip()
        if txt:
            messages.append({"role": r, "content": txt[:2000]})
    messages.append(
        {
            "role": "user",
            "content": f"[LIVE_PLANT_CONTEXT]\n{context_json}\n[/LIVE_PLANT_CONTEXT]\n\nUser question: {query}",
        }
    )
    payload_bytes = json.dumps(
        {
            "model": model_name,
            "messages": messages,
            "stream": False,
            "options": {"temperature": 0.25},
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/api/chat",
        data=payload_bytes,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30.0) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    text = str((body.get("message") or {}).get("content", "")).strip()
    if not text:
        raise RuntimeError("Empty response from local Ollama")
    return text, model_name


# ---------------------------------------------------------------------------
# Smart Dynamic Fallback (when no Gemini API key & no local Ollama yet)
# ---------------------------------------------------------------------------

def _dynamic_local_answer(
    rt: Any,
    snap: Dict[str, Any],
    query: str,
    basis_mode: str,
    lang: str,
    context_obj: Dict[str, Any],
) -> str:
    vi = lang == "vi"
    low = (query or "").strip().lower()
    live = context_obj["live_snapshot"]
    sig = live["signals"] or {}
    t2 = context_obj.get("T2_quan_frozen_hgb") or {}
    t3 = context_obj.get("T3_causal_dag") or {}
    t8 = context_obj.get("T8_historical_trends") or {}
    t9 = context_obj.get("T9_whatif_payback_calculator") or {}

    # 0. Control write refusal
    if detect_control_write_request(query, None):
        if vi:
            return (
                "🔒 **Từ chối thao tác điều khiển trực tiếp:** Hệ thống tuân thủ chuẩn **IEC 62443-3-3 Read-Only (`controls=false`)**, không ghi lệnh xuống PLC/BMS.\n\n"
                f"- **Trạng thái hiện tại ({live['timestamp'][11:16]} · {live['scenario_label']}):** `{live['overall_status']}`, Fan `{sig.get('fan_pct', 0):.1f}%`, Flow `{sig.get('tower_flow_gpm', 0):.1f} GPM`.\n"
                "- **Hướng xử lý đúng chuẩn:** Mở **Tab 4 (Alert Triage)** xác nhận Bước I–V và xuất bản thảo phiếu công tác CMMS (Bước VI) để kỹ sư vận hành thực hiện cô lập N+1 an toàn."
            )
        return (
            "🔒 **Direct actuation refused:** Chiller FaultGuard enforces **IEC 62443-3-3 Read-Only Mode (`controls=false`)** with zero PLC/BMS write path.\n\n"
            f"- **Current state ({live['timestamp'][11:16]} · {live['scenario_label']}):** `{live['overall_status']}`, Fan `{sig.get('fan_pct', 0):.1f}%`, Flow `{sig.get('tower_flow_gpm', 0):.1f} GPM`.\n"
            "- **Safe procedure:** Verify Steps I–V in **Tab 4** and generate a read-only CMMS work-order brief (Step VI) for human N+1 isolation."
        )

    # 1. Greetings / Help / Capabilities
    if any(g in low for g in ("xin chào", "xin chao", "chào", "hello", "hi ", "hey", "bạn là ai", "ban la ai", "làm được gì")) and len(low) < 45:
        if vi:
            return (
                f"Xin chào! Mình là trợ lý kỹ thuật **FaultGuard AI**, đang theo dõi trực tiếp trạm giải nhiệt lúc **{live['timestamp'][11:16]}** (kịch bản **{live['scenario_label']}**, trạng thái **`{live['overall_status']}`**).\n\n"
                "Bạn có thể hỏi mình bất kỳ câu hỏi nào, ví dụ:\n"
                "- *\"Tại sao quạt chưa tới 98% mà AI đã báo lỗi sớm hơn Rule?\"*\n"
                "- *\"So với 15 phút trước nhiệt độ nước ra và công suất thay đổi thế nào?\"*\n"
                "- *\"Nếu chi phí vệ sinh giảm xuống 5 triệu thì bao lâu hoàn vốn?\"*\n\n"
                "*(Mẹo: Bấm nút **🔑 Gemini Key** trên thanh tiêu đề chat để bật mô hình LLM **Gemini 2.5 Flash** trả lời tự do mọi chủ đề!)*"
            )
        return (
            f"Hello! I'm **FaultGuard AI**, monitoring CT-1 live at **{live['timestamp'][11:16]}** (**{live['scenario_label']}**, status **`{live['overall_status']}`**).\n\n"
            "Ask me anything about the live plant, historical trends, or What-If ROI — for example:\n"
            "- *\"Why did AI trigger before the 98% High-Fan Rule?\"*\n"
            "- *\"How did tower outlet temperature change vs 15 minutes ago?\"*\n"
            "- *\"If PM cleaning cost is 5M VND, how many days to break even?\"*\n\n"
            "*(Tip: Click **🔑 Gemini Key** in the header to unlock full **Gemini 2.5 Flash** LLM reasoning!)*"
        )

    # 2. Custom What-If PM Cost / Payback Question
    if t9.get("queried_custom_pm") or any(k in low for k in ("bao lâu hoàn vốn", "bao lau hoan von", "hoàn vốn", "payback", "triệu", "trieu", "what if", "nếu chi phí", "neu chi phi", "roi")):
        qpm = t9.get("queried_custom_pm") or next(
            (x for x in t9.get("pm_cost_sensitivity_table", []) if x["pm_cost_vnd"] == 8_000_000),
            None,
        )
        if qpm:
            pm_m = qpm["pm_cost_million_vnd"]
            pb_d = qpm["payback_days"]
            pb_cal = qpm["payback_calendar_day"]
            net_v = qpm["net_benefit_vnd"]
            roi_p = qpm["roi_pct"]
            basis_note = (
                f"điện năng dư trực tiếp `{t9['eff_excess_kw']:.2f} kW*`"
                if t9["basis_used"] == "live_active_alert"
                else f"mốc tham chiếu `3.00 kW` (do hiện tại trạm đang Standby)"
            )
            if vi:
                return (
                    f"Với chi phí vệ sinh **`{pm_m:g} triệu ₫` (`{qpm['pm_cost_vnd']:,} ₫`)**, thời gian hoàn vốn là **`{pb_d} ngày`** (hòa vốn vào **Ngày `D{pb_cal}`**, trước lịch định kỳ `D{t9['calendar_pm_day']}`).\n\n"
                    f"- **Cơ sở tính ({basis_note} · EVN 22kV TOU `1,926 ₫/kWh`):** Tiêu phí dư mỗi ngày = **`{int(t9['daily_burn_ex_vat_vnd']):,} ₫/ngày`**.\n"
                    f"- **Tổng điện tránh lãng phí (`D{t9['earlier_pm_day']} → D{t9['calendar_pm_day']}`, `{t9['days_saved']} ngày`):** `{t9['avoided_kwh']:,.1f} kWh` (`{int(t9['avoided_gross_ex_vat_vnd']):,} ₫` chưa VAT).\n"
                    f"- **Lợi ích ròng sau trừ chi phí PM:** **`{net_v:+,} ₫`** (**ROI `{roi_p:+.1f}%`** → Khuyến nghị: **`{qpm['verdict']}`**)."
                )
            return (
                f"At a PM cleaning cost of **`{pm_m:g}M VND` (`{qpm['pm_cost_vnd']:,} ₫`)**, break-even payback takes **`{pb_d} days`** (reaching payback on **Day `D{pb_cal}`** vs Calendar `D{t9['calendar_pm_day']}`).\n\n"
                f"- **Daily Excess Burn (`{t9['eff_excess_kw']:.2f} kW` @ `1,926 ₫/kWh`):** **`{int(t9['daily_burn_ex_vat_vnd']):,} ₫/day`**.\n"
                f"- **Gross Avoided Cost (`{t9['days_saved']} days`):** `{t9['avoided_kwh']:,.1f} kWh` (`{int(t9['avoided_gross_ex_vat_vnd']):,} ₫` ex-VAT).\n"
                f"- **Net Benefit:** **`{net_v:+,} ₫`** (**`{roi_p:+.1f}%` ROI** → **`{qpm['verdict']}`**)."
            )

    # 3. Historical Trend / Comparison ("15 phút trước", "30 phút", "thay đổi thế nào", "so với")
    if any(k in low for k in ("phút trước", "phut truoc", "ago", "thay đổi", "thay doi", "xu hướng", "xu huong", "so với", "so voi", "trend", "tăng hay giảm")):
        lbs = t8.get("lookbacks") or {}
        win_key = (
            "5m_ago"
            if re.search(r"\b5\s*(?:phút|phut|p|m|min)\b", low)
            else ("30m_ago" if re.search(r"\b30\b", low) else ("60m_ago" if re.search(r"\b60\b|1\s*(?:giờ|gio|tiếng|tieng|h\b|hr)", low) else "15m_ago"))
        )
        lb = lbs.get(win_key) or next(iter(lbs.values()), None)
        if lb:
            mins_lbl = win_key.replace("m_ago", "")
            if vi:
                return (
                    f"So với **`{mins_lbl} phút trước` (lúc `{lb['timestamp']}` → hiện tại `{t8['current_time']}`)**, các thông số chính thay đổi như sau:\n\n"
                    f"- **Nhiệt độ nước ra tháp (`CT-1 Outlet*`):** `{lb['tower_outlet_c']:.2f} °C*` → **`{sig.get('nominal_tower_outlet_c', 0):.2f} °C*`** (**`{lb['delta_outlet_c']:+.2f} °C`**).\n"
                    f"- **Độ chênh nhiệt qua tháp (`Range ΔT`):** `{lb['tower_range_c']:.2f} °C` → **`{sig.get('tower_range_c', 0):.2f} °C`** (**`{lb['delta_range_c']:+.2f} °C`**).\n"
                    f"- **Tốc độ quạt VFD (`CT-1 Fan`):** `{lb['fan_pct']:.1f}%` → **`{sig.get('fan_pct', 0):.1f}%`** (**`{lb['delta_fan_pct']:+.1f}%`**).\n"
                    f"- **Công suất toàn trạm 14 kênh (`ΔkW*`):** `{lb['plant_kw']:.1f} kW` → **`{sig.get('plant_kw', 0):.1f} kW`** (**`{lb['delta_plant_kw']:+.1f} kW`**, lệch so với Normal hiện tại: **`{sig.get('signed_delta_kw', 0):+.2f} kW*`**).\n"
                    + (f"- **Điểm Quan HGB:** `{lb['ai_score_then']:.3f}` → **`{t2.get('ai_score', 0):.3f}`** (**`{lb['delta_ai_score']:+.3f}`**)." if lb.get("delta_ai_score") is not None else "")
                )
            return (
                f"Compared with **`{mins_lbl} minutes ago` (`{lb['timestamp']}` → `{t8['current_time']}`)**:\n\n"
                f"- **CT-1 Outlet Temp*:** `{lb['tower_outlet_c']:.2f} °C*` → **`{sig.get('nominal_tower_outlet_c', 0):.2f} °C*`** (**`{lb['delta_outlet_c']:+.2f} °C`**).\n"
                f"- **Thermal Range ΔT:** `{lb['tower_range_c']:.2f} °C` → **`{sig.get('tower_range_c', 0):.2f} °C`** (**`{lb['delta_range_c']:+.2f} °C`**).\n"
                f"- **CT-1 Fan VFD:** `{lb['fan_pct']:.1f}%` → **`{sig.get('fan_pct', 0):.1f}%`** (**`{lb['delta_fan_pct']:+.1f}%`**).\n"
                f"- **14-Ch Plant Power:** `{lb['plant_kw']:.1f} kW` → **`{sig.get('plant_kw', 0):.1f} kW`** (**`{lb['delta_plant_kw']:+.1f} kW`**, current excess **`{sig.get('signed_delta_kw', 0):+.2f} kW*`**)."
            )

    # 4. Why AI vs Rule / Early Detection / Concise live diagnostic
    sc = t2.get("ai_score")
    sc_txt = f"{sc:.3f}" if sc is not None else "ABSTAIN"
    fan_v = float(sig.get("fan_pct", 0.0))
    top_f = t2.get("top_features") or []
    drv_txt = ", ".join(f"**{f['label']}** (`{f['current_value']}`, `{f['delta_score']:+.3f}`)" for f in top_f[:3]) or "6 biến gốc"
    lead_m = t8.get("ai_lead_over_rule_minutes_on_oct01")
    lead_line_vi = (
        f"\n- **Thời gian báo sớm (Lead Time hôm nay):** AI phát hiện lúc `{t8['full_day_first_ai_alert']}`, sớm hơn High-Fan Rule (`{t8['full_day_first_rule_alert']}`) **`+{lead_m} phút`**."
        if lead_m and lead_m > 0
        else ""
    )
    if vi:
        return (
            f"Tại **`{live['timestamp'][11:16]}` ({live['scenario_label']})**, hệ thống đang ở trạng thái **`{live['overall_status']}`** (`{live['ai_vs_rule_agreement']}`).\n\n"
            f"- **So sánh AI vs. Rule:** Điểm **Quan HGB = `{sc_txt}`** (ngưỡng `> 0.70` trong `{t2.get('ai_run_minutes', 0)}/5 phút`), trong khi quạt **CT-1 Fan = `{fan_v:.1f}%`** (Rule truyền thống phải chờ quạt `> 98.0%` suốt `15 phút`, hiện mới `{t2.get('rule_run_minutes', 0)}/15 phút`). Nhờ xét đồng thời tương quan 6 biến nhiệt–thủy lực thay vì chờ quạt bão hòa 98%, AI bắt được dấu hiệu suy giảm giải nhiệt sớm hơn hẳn.\n"
            f"- **Các biến đẩy điểm mạnh nhất lúc này:** {drv_txt}.\n"
            f"- **Cô lập nguyên nhân (DAG):** Gốc **`{t3.get('isolated_root_id', 'NONE')}` (`{t3.get('isolated_root_label', '')}`)** · Lưu lượng bơm `{sig.get('tower_flow_gpm', 0):.1f} GPM` · Điện năng lệch **`{sig.get('signed_delta_kw', 0):+.2f} kW*`**."
            f"{lead_line_vi}"
        )
    return (
        f"At **`{live['timestamp'][11:16]}` ({live['scenario_label']})**, plant status is **`{live['overall_status']}`** (`{live['ai_vs_rule_agreement']}`).\n\n"
        f"- **AI vs. High-Fan Rule:** **Quan HGB = `{sc_txt}`** (`{t2.get('ai_run_minutes', 0)}/5m` above `0.70`), whereas **CT-1 Fan = `{fan_v:.1f}%`** (`{t2.get('rule_run_minutes', 0)}/15m` above `98.0%`). Multivariate HGB catches degraded heat rejection across 6 native inputs before VFD fan speed saturates above 98%.\n"
        f"- **Top Local Sensitivity Drivers:** {drv_txt}.\n"
        f"- **Causal Root Isolation:** **`{t3.get('isolated_root_id', 'NONE')}` (`{t3.get('isolated_root_label', '')}`)** · Flow `{sig.get('tower_flow_gpm', 0):.1f} GPM` · Signed Excess **`{sig.get('signed_delta_kw', 0):+.2f} kW*`**."
    )


def run_rca_chat(
    rt: Any,
    query: str,
    history: Optional[List[Dict[str, str]]] = None,
    basis_mode: str = "live",
    lang: str = "auto",
    api_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute a natural multi-turn grounded LLM chat turn against live Digital Twin context."""
    t0 = time.perf_counter()
    clean_query = (query or "").strip()
    if not clean_query:
        raise ValueError("Query must not be empty")

    if api_key and api_key.strip():
        save_gemini_key(api_key.strip())

    with rt.lock:
        snap = rt.state()
        context_obj = build_grounded_llm_context(rt, snap, clean_query, basis_mode=basis_mode)

    detected_lang = detect_language(clean_query, lang=lang if lang in ("en", "vi") else "auto")
    hist_list = list(history or [])

    gkey = get_configured_gemini_key()
    provider_used = "local_dynamic"
    model_used = "dynamic-grounded-v13"
    llm_warning: Optional[str] = None
    answer_md = ""

    if gkey:
        try:
            answer_md, model_used = _call_gemini_api(gkey, clean_query, hist_list, context_obj)
            provider_used = "gemini"
        except Exception as exc:
            llm_warning = str(exc)

    if not answer_md:
        ok_ol, ol_model, ol_host = _probe_ollama_model()
        if ok_ol and ol_model:
            try:
                answer_md, model_used = _call_ollama_api(ol_host, ol_model, clean_query, hist_list, context_obj)
                provider_used = "ollama"
                llm_warning = None
            except Exception as exc:
                llm_warning = str(exc)

    if not answer_md:
        answer_md = _dynamic_local_answer(rt, snap, clean_query, basis_mode, detected_lang, context_obj)
        provider_used = "local_dynamic"
        model_used = "dynamic-grounded-v13"

    latency_ms = round((time.perf_counter() - t0) * 1000.0, 1)
    return {
        "ok": True,
        "provider": provider_used,
        "model": model_used,
        "key_configured": bool(gkey),
        "warning": llm_warning,
        "lang": detected_lang,
        "timestamp": snap.get("timestamp"),
        "scenario": snap.get("scenario"),
        "status": snap.get("status"),
        "answer_markdown": answer_md,
        "latency_ms": latency_ms,
        "read_only": True,
        "controls": False,
    }
