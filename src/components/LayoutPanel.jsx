// ⚙ LAYOUT on MANAGEMENT-2: the CT graph's seconds range and the size of every box, per layout
// (portrait / landscape). Saved on the server (data/dashboard_layout.json) so every screen shows the same.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const LAYOUT_DEFAULTS = {
  ct: { min: 0, max: null, hist_max: null },            // seconds; null = automatic
  portrait: { kpi_h: 205, ct_h: 1.1, ct_split: 60, hourly_h: null, timeline_h: 1, docs_h: null, loss_w: 200, side_w: 185 },
  landscape: { side_w: 285, loss_w: 215, timeline_h: null, hourly_h: null },
  display: { poka_no_checks: false },                   // poka-yoke box without checks: OK (tap: No Checks)
};

// unit: "px" | "share" (fr of the free height) | "%"; auto: data-box id measured when an automatic size is first changed
const FIELDS = {
  portrait: [
    { k: "kpi_h", label: "KPI band height", unit: "px", step: 10, min: 120, max: 500 },
    { k: "ct_h", label: "CT graph + CT distribution height", unit: "share", step: 0.1, min: 0.2, max: 5 },
    { k: "ct_split", label: "CT graph width (CT distribution: the rest)", unit: "%", step: 5, min: 20, max: 80 },
    { k: "hourly_h", label: "Hourly table height", unit: "px", step: 10, min: 80, max: 700, auto: "hourly" },
    { k: "timeline_h", label: "Shift timeline height", unit: "share", step: 0.1, min: 0.1, max: 5 },
    { k: "docs_h", label: "Documents height", unit: "px", step: 20, min: 120, max: 1400, auto: "docs" },
    { k: "loss_w", label: "Loss distribution width", unit: "px", step: 10, min: 140, max: 500 },
    { k: "side_w", label: "Poka-yoke / Sensor width", unit: "px", step: 10, min: 120, max: 500 },
  ],
  landscape: [
    { k: "loss_w", label: "Loss distribution width", unit: "px", step: 10, min: 150, max: 600 },
    { k: "side_w", label: "Poka-yoke / Sensor width", unit: "px", step: 10, min: 150, max: 700 },
    { k: "timeline_h", label: "Shift timeline height", unit: "px", step: 10, min: 60, max: 500, auto: "timeline" },
    { k: "hourly_h", label: "Hourly table height", unit: "px", step: 10, min: 80, max: 600, auto: "hourly" },
  ],
};
const CT_FIELDS = [
  { k: "min", label: "CT graph from", unit: "s", step: 5, min: 0, max: 600 },
  { k: "max", label: "CT graph to", unit: "s", step: 10, min: 10, max: 900, autoable: true, axis: "ct-axis" },
  { k: "hist_max", label: "CT distribution to", unit: "s", step: 10, min: 10, max: 900, autoable: true, axis: "hist-axis" },
];

const CACHE = "mgmt2_layout";
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Stored layout onto the defaults: only known keys, only numbers (null keeps "automatic").
function merge(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [group, defs] of Object.entries(LAYOUT_DEFAULTS)) {
    out[group] = { ...defs };
    const g = src[group] && typeof src[group] === "object" ? src[group] : {};
    for (const k of Object.keys(defs)) {
      if (k in g && (typeof defs[k] === "boolean" ? typeof g[k] === "boolean" : g[k] === null || num(g[k]) !== null)) out[group][k] = g[k];
    }
  }
  return out;
}

function readCache() {
  try { return merge(JSON.parse(localStorage.getItem(CACHE) || "null")); } catch { return merge(null); }
}
function writeCache(v) {
  try { localStorage.setItem(CACHE, JSON.stringify(v)); } catch { /* private mode: server copy only */ }
}

export function useDashboardLayout() {
  const [lay, setLay] = useState(readCache);
  const [saved, setSaved] = useState(null);
  const pending = useRef(false);              // local change not on the server yet: don't overwrite it
  const timer = useRef(null);
  useEffect(() => {
    let alive = true;
    const load = () => fetch("/api/demo/dashboard-layout")
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (alive && j && !pending.current) { const m = merge(j); setLay(m); writeCache(m); } })
      .catch(() => {});
    load();
    const id = setInterval(load, 30000);      // another screen changed it: pick it up
    return () => { alive = false; clearInterval(id); };
  }, []);
  const update = (fn) => setLay(prev => {
    const next = merge(fn(prev));
    pending.current = true;
    writeCache(next);
    setSaved("Saving…");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      fetch("/api/demo/dashboard-layout", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) })
        .then(r => setSaved(r.ok ? "Saved for every screen" : `Not saved (HTTP ${r.status})`))
        .catch(() => setSaved("Not saved (server not reachable)"))
        .finally(() => { pending.current = false; });
    }, 500);
    return next;
  });
  return { lay, update, saved };
}

const fmt = (f, v) => (v == null ? "Auto" : f.unit === "share" ? `×${v.toFixed(1)}` : `${v} ${f.unit}`);
const clamp = (v, f) => Math.min(f.max, Math.max(f.min, v));
const round = (v, step) => Math.round(v / step) * step;

export function LayoutPanel({ layoutKey, lay, update, saved, onClose, dark = false }) {
  const c = dark
    ? { bg: "#0b1220", card: "#111a2b", border: "#24324a", text: "#e8edf5", sub: "#94a3b8", btn: "#1b2740" }
    : { bg: "#ffffff", card: "#f8fafc", border: "#e2e8f0", text: "#0f172a", sub: "#64748b", btn: "#eef2f7" };
  const fields = FIELDS[layoutKey];
  const L = lay[layoutKey];

  const step = (group, f, dir) => update(prev => {
    let cur = prev[group][f.k], measured = false;
    if (cur == null) {                          // automatic until now: start from what is on screen
      measured = true;
      const el = f.axis ? document.querySelector(`[data-${f.axis}]`)
               : f.auto ? document.querySelector(`[data-box="${f.auto}"]`) : null;
      cur = !el ? NaN : f.axis ? Number(el.getAttribute(`data-${f.axis}`)) : round(el.offsetHeight, f.step);
      if (!Number.isFinite(cur)) cur = dir > 0 ? f.min : f.max;
    }
    const v = clamp((measured && !f.axis ? round(cur, f.step) : cur) + dir * f.step, f);   // measured px: on the step grid
    return { ...prev, [group]: { ...prev[group], [f.k]: f.unit === "share" ? Math.round(v * 10) / 10 : v } };
  });
  const setVal = (group, k, v) => update(prev => ({ ...prev, [group]: { ...prev[group], [k]: v } }));

  const btn = { width: 30, height: 28, borderRadius: 7, border: `1px solid ${c.border}`, background: c.btn, color: c.text,
                fontSize: 16, fontWeight: 900, cursor: "pointer", lineHeight: 1 };
  const link = { border: "none", background: "none", color: "#2563eb", fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 };
  const row = (label, value, onMinus, onPlus, extra) => (
    <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: `1px solid ${c.border}` }}>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: c.text, fontWeight: 600 }}>{label}</span>
      <button type="button" style={btn} onClick={onMinus} aria-label={`${label} smaller`}>−</button>
      <span style={{ width: 64, textAlign: "center", fontFamily: "monospace", fontSize: 12, fontWeight: 800, color: c.text }}>{value}</span>
      <button type="button" style={btn} onClick={onPlus} aria-label={`${label} bigger`}>+</button>
      <span style={{ width: 34 }}>{extra}</span>
    </div>
  );
  const head = { fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: c.sub, margin: "12px 0 2px" };

  return createPortal((
    <div role="dialog" aria-label="Dashboard layout"
      style={{ position: "fixed", top: 64, right: 12, zIndex: 9998, width: 400, maxWidth: "calc(100vw - 24px)",
               maxHeight: "calc(100vh - 80px)", overflowY: "auto", background: c.bg, color: c.text,
               border: `1px solid ${c.border}`, borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,.45)",
               padding: "12px 16px 14px", fontFamily: "'Barlow','Segoe UI',sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 800 }}>⚙ Layout</span>
        <span style={{ fontSize: 11, color: c.sub }}>{layoutKey === "portrait" ? "Portrait (9:16)" : "Landscape (16:9)"}</span>
        <button type="button" onClick={onClose} title="Close" style={{ ...btn, marginLeft: "auto", fontSize: 13 }}>✕</button>
      </div>

      <div style={head}>CT graph seconds (both layouts)</div>
      {CT_FIELDS.map(f => row(f.label, fmt(f, lay.ct[f.k]),
        () => step("ct", f, -1), () => step("ct", f, +1),
        f.autoable && lay.ct[f.k] != null ? <button type="button" style={link} onClick={() => setVal("ct", f.k, null)}>Auto</button> : null))}

      <div style={head}>Box sizes</div>
      {fields.map(f => row(f.label, fmt(f, L[f.k]),
        () => step(layoutKey, f, -1), () => step(layoutKey, f, +1),
        f.auto && L[f.k] != null ? <button type="button" style={link} onClick={() => setVal(layoutKey, f.k, null)}>Auto</button> : null))}
      <div style={{ fontSize: 11, color: c.sub, marginTop: 6, lineHeight: 1.5 }}>
        {layoutKey === "portrait"
          ? "“×” sizes share the free height. The CT graph and the timeline grow or shrink against each other."
          : "The CT graph takes the height and width that is left."}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={() => update(prev => ({ ...prev, [layoutKey]: { ...LAYOUT_DEFAULTS[layoutKey] } }))}
          style={{ ...btn, width: "auto", padding: "0 12px", fontSize: 12 }}>Reset box sizes</button>
        <button type="button" onClick={() => update(prev => ({ ...prev, ct: { ...LAYOUT_DEFAULTS.ct } }))}
          style={{ ...btn, width: "auto", padding: "0 12px", fontSize: 12 }}>Reset CT seconds</button>
        <span style={{ marginLeft: "auto", fontSize: 11, color: saved && saved.startsWith("Not") ? "#dc2626" : c.sub }}>{saved || ""}</span>
      </div>
    </div>
  ), document.body);
}
