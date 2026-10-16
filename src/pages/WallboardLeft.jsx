/**
 * WallboardLeft.jsx
 * =================
 * 65" portrait shop-floor TV — LEFT dashboard.
 *
 * Layout (top → bottom):
 *   header bar (line code · shift · clock · 16:9 toggle · ⛶ fullscreen)
 *   N stacked CT charts — ONE per sub-machine, all share the same X axis
 *      cycle # so spikes line up visually
 *   right-side dock — hover/click any machine row → side panel slides in
 *      with per-machine hourly slot counts
 *
 * Data source:
 *   GET /api/lines/{lineId}/wallboard-cycles    (refreshes every 8s)
 *   GET /api/lines/{lineId}/wallboard-summary   (hourly slots, 30s)
 *
 * Portrait-first sizing: the page height is mapped to viewport HEIGHT
 * when landscape and viewport WIDTH when portrait via a `transform:
 * rotate(90deg)` wrapper — same pattern used in Fullscreen.jsx so the
 * 16:9/9:16 toggle plus the R keyboard shortcut switch orientation
 * without DOM reflow.
 */
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import VideoProgressBar from "../components/VideoProgressBar";
import SlideNav                                     from "../components/SlideNav";
import { createPortal }                             from "react-dom";
import { startTimer }                              from "../api/timing";
import { useParams }                                from "react-router-dom";
import axios                                        from "axios";

axios.defaults.baseURL = "";  // same-origin

// ── Load Chart.js once (air-gapped LAN safe — local /public/chart.umd.min.js)
function useChartJS(cb, deps = []) {
  useEffect(() => {
    if (window.Chart) { cb(); return; }
    const s = document.createElement("script");
    s.src = "/chart.umd.min.js";
    s.onload = () => cb();
    document.head.appendChild(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// Tolerance band around ideal CT (matches Fullscreen.jsx logic exactly).
const CT_TOL = 0.009;     // > ideal+0.009 = spike,  < ideal-0.009 = fast
// Match Fullscreen STATUS_CLR
const FS_OK    = "#22c55e";   // RUNNING green
const FS_BAD   = "#ef4444";   // BREAKDOWN red
const FS_WARN  = "#f59e0b";   // amber (exactly on threshold)

const D = (() => {
  try {
    return localStorage.getItem("wb_theme") !== "light";
  } catch {
    return true;
  }
})();
const bg       = D ? "#0a0e1a" : "#f1f5f9";
const card     = D ? "#0f1729" : "#ffffff";
const VID_PLAY_AT = 0.20;

const _warmed = new Set();
function warmClips(lineId, subId, seqs) {
  if (!lineId) return;
  const fresh = [];
  for (const s of seqs) {
    if (s == null) continue;
    const key = `${subId || 0}:${s}`;
    if (_warmed.has(key)) continue;
    _warmed.add(key);
    fresh.push(s);
  }
  if (!fresh.length) return;
  // Cap the memory of a wallboard left open all shift.
  if (_warmed.size > 4000) _warmed.clear();
  const qs = `seqs=${fresh.join(",")}` + (subId ? `&sub_id=${subId}` : "");
  fetch(`/api/lines/${lineId}/clip-prewarm?${qs}`).catch(() => {});
}
const border   = D ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.08)";
const text     = D ? "#e2e8f0" : "#0f172a";
const textMut  = D ? "#64748b" : "#94a3b8";
const textSub  = D ? "#94a3b8" : "#475569";
const okClr     = "#22c55e";   // < ideal × 0.97
const warnClr   = "#f97316";   // ideal × 0.97 .. 1.03 (at threshold)
const badClr    = "#ef4444";   // > ideal × 1.03
const idealClr  = "#fbbf24";
const warnClrTxt= "#fbbf24";

/** 3-tier color logic.  Below threshold → green, at threshold → orange,
 *  above → red.  Threshold band is ±3% around ideal_ct.  Returns the
 *  fill colour (and stroke darker shade for ring around dots).        */
function ctColor(ct, idealCt) {
  if (ct == null || idealCt == null || idealCt <= 0) return okClr;
  const ratio = ct / idealCt;
  if (ratio < 0.97) return okClr;
  if (ratio > 1.03) return badClr;
  return warnClr;
}
function ctStroke(color) {
  return color === okClr  ? "#14532d"
       : color === badClr ? "#7f1d1d"
       : "#7c2d12";        // dark orange
}

function OtBars({ title, rows, metric, color = "#f59e0b", onToday }) {
  const data = (rows || []).map(r => ({
    date: r.date, md: String(r.date || "").slice(5),
    val: metric === "pct" ? r.pct : r.over,
    over: r.over, total: r.total, pct: r.pct,
  }));
  const maxV = Math.max(1, ...data.map(d => Number(d.val) || 0));
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: ".08em", marginBottom: 4 }}>
        {title} <span style={{ color: "#64748b", fontWeight: 600 }}>· {data.length} days</span>
      </div>
      {data.length === 0 ? (
        <div style={{ fontSize: 12, color: "#64748b", fontStyle: "italic", padding: "14px 0" }}>
          No data yet for this shift.
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 130,
                      paddingTop: 14, borderBottom: "1px solid rgba(255,255,255,0.14)" }}>
          {data.map((d, i) => {
            const isToday = (i === data.length - 1) && typeof onToday === "function";
            return (
              <div key={i}
                   onClick={isToday ? onToday : undefined}
                   title={isToday
                     ? `${d.date} — click for today's over-target cycle videos`
                     : `${d.date}\nover ${d.over} / ${d.total} = ${d.pct}%`}
                   style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
                            alignItems: "center", justifyContent: "flex-end", height: "100%",
                            cursor: isToday ? "pointer" : "default" }}>
                <span style={{ fontSize: 8, color, fontFamily: "monospace", fontWeight: 700, marginBottom: 2 }}>
                  {metric === "pct" ? `${d.val}%` : d.val}
                </span>
                <div style={{ width: "78%", height: `${Math.max(2, (Number(d.val) / maxV) * 100)}%`,
                              background: color, borderRadius: "2px 2px 0 0",
                              opacity: isToday ? 1 : 0.9,
                              outline: isToday ? "2px solid rgba(255,255,255,0.55)" : "none",
                              outlineOffset: isToday ? "1px" : 0 }} />
                <span style={{ fontSize: 7, color: isToday ? "#ffffff" : "#64748b",
                               fontWeight: isToday ? 800 : 400, fontFamily: "monospace",
                               marginTop: 2, whiteSpace: "nowrap" }}>{d.md}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OtHourlyAvg({ lineId, subId, ideal, D }) {
  const [sel, setSel]   = useState({ date: "", shift: "" });   // "" = server default
  const [data, setData] = useState(null);
  const [err, setErr]   = useState(false);
  useEffect(() => {
    if (!lineId) return;
    let stop = false;
    const qs = new URLSearchParams();
    if (subId) qs.set("sub_id", String(subId));
    if (sel.date)  qs.set("date", sel.date);
    if (sel.shift) qs.set("shift", sel.shift);
    setErr(false);
    fetch(`/api/lines/${lineId}/hourly-avg-ct?${qs.toString()}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => { if (!stop) setData(d); })
      .catch(() => { if (!stop) { setData(null); setErr(true); } });
    return () => { stop = true; };
  }, [lineId, subId, sel.date, sel.shift]);

  const idealCt = Number((data && data.ideal_ct) || ideal || 0);
  const slots   = (data && data.slots) || [];
  const maxV    = Math.max(idealCt * 1.25, 1, ...slots.map(s => Number(s.avg_ct) || 0));
  const curDate  = sel.date  || (data && data.date)  || "";
  const curShift = sel.shift || (data && data.shift) || "";
  const muted = D ? "#64748b" : "#94a3b8";
  const sBtn = (s) => (
    <button key={s} onClick={() => setSel(p => ({ ...p, shift: s, date: p.date || curDate }))} style={{
      padding: "3px 12px", fontSize: 11, fontWeight: 800, borderRadius: 6, cursor: "pointer",
      border: "1px solid rgba(245,158,11,0.5)",
      background: curShift === s ? "#f59e0b" : "transparent",
      color: curShift === s ? "#1a1205" : "#f59e0b",
    }}>{s} SHIFT</button>
  );

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        <input type="date" value={curDate}
               max={new Date().toLocaleDateString("en-CA")}
               onChange={e => e.target.value && setSel(p => ({ ...p, date: e.target.value, shift: p.shift || curShift }))}
               style={{ padding: "3px 6px", fontSize: 11, borderRadius: 6,
                        border: "1px solid rgba(245,158,11,0.5)", background: "transparent",
                        color: D ? "#e2e8f0" : "#0f172a", colorScheme: D ? "dark" : "light" }} />
        {sBtn("A")}{sBtn("B")}
        {data && (
          <span style={{ fontSize: 11, color: D ? "#9fb0c9" : "#475569", marginLeft: 6 }}>
            Shift avg <b style={{ color: "#f59e0b" }}>{data.avg_ct != null ? `${data.avg_ct}s` : "—"}</b>
            {data.excluded != null
              ? <>{"  ·  "}avg of {data.counted} parts up to {data.avg_max_s || 60}s
                  {data.excluded > 0 && <>{"  ·  "}<span style={{ color: "#f59e0b" }}>{data.excluded} parts over {data.avg_max_s || 60}s not counted</span></>}</>
              : <>{"  ·  "}{data.total_cycles} parts in {Math.round((data.working_seconds || 0) / 60)} min working time</>}
            {"  ·  "}ideal {idealCt}s
          </span>
        )}
      </div>
      {err ? (
        <div style={{ fontSize: 12, color: "#ef4444", padding: "14px 0" }}>Could not load hourly average CT.</div>
      ) : !data ? (
        <div style={{ fontSize: 12, color: muted, padding: "14px 0" }}>Loading…</div>
      ) : slots.length === 0 ? (
        <div style={{ fontSize: 12, color: muted, fontStyle: "italic", padding: "14px 0" }}>
          No hourly slots configured for this shift.
        </div>
      ) : (() => {
        const PLOT = 150;                                  // px of bar travel
        const px = (v) => Math.max(2, Math.round((v / maxV) * PLOT));
        return (
          <>
            <div style={{ position: "relative", display: "flex", alignItems: "flex-end", gap: 6,
                          height: PLOT + 18, borderBottom: "1px solid rgba(255,255,255,0.14)" }}>
              {idealCt > 0 && (
                <div style={{ position: "absolute", left: 0, right: 0, bottom: px(idealCt),
                              borderTop: "1px dashed rgba(34,197,94,0.75)", pointerEvents: "none" }}>
                  <span style={{ position: "absolute", right: 0, top: -13, fontSize: 9,
                                 color: "#22c55e", fontFamily: "monospace" }}>ideal {idealCt}s</span>
                </div>
              )}
              {slots.map((s, i) => {
                const v = s.avg_ct == null ? null : Number(s.avg_ct);
                const clr = v == null ? muted : v > idealCt ? "#ef4444" : "#22c55e";
                return (
                  <div key={i}
                       title={v == null
                         ? `${s.label}\n${s.cycles ? `${s.cycles} parts, all over ${data.avg_max_s || 60}s — not averaged` : (s.working_seconds ? "no parts made" : "not started")}`
                         : (s.excluded != null
                             ? `${s.label}\nAvg ${v}s of ${s.counted} parts (up to ${data.avg_max_s || 60}s)`
                               + `\n${s.excluded} parts over ${data.avg_max_s || 60}s — not counted in avg`
                               + `\nTotal parts ${s.cycles}`
                             : `${s.label}\n${s.cycles} parts in ${Math.round((s.working_seconds || 0) / 60)} min working time → avg ${v}s`)
                           + `\nfastest cycle ${s.min_ct ?? "—"}s · slowest ${s.max_ct ?? "—"}s\ncycles over ideal: ${s.over}`}
                       style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column",
                                alignItems: "center", justifyContent: "flex-end" }}>
                    <span style={{ fontSize: 11, color: clr, fontFamily: "monospace", fontWeight: 800,
                                   marginBottom: 2, whiteSpace: "nowrap" }}>
                      {v == null ? "—" : `${v.toFixed(1)}s`}
                    </span>
                    <div style={{ width: "70%", height: v == null ? 2 : px(v), background: clr,
                                  borderRadius: "2px 2px 0 0", opacity: 0.9 }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
              {slots.map((s, i) => (
                <div key={i} style={{ flex: 1, minWidth: 0, textAlign: "center", fontFamily: "monospace",
                                      lineHeight: 1.35, overflow: "hidden" }}>
                  <div style={{ fontSize: 9, color: D ? "#cbd5e1" : "#334155", whiteSpace: "nowrap",
                                overflow: "hidden", textOverflow: "ellipsis" }}>{s.label}</div>
                  <div style={{ fontSize: 9, color: muted }}>{s.cycles} pcs</div>
                </div>
              ))}
            </div>
          </>
        );
      })()}
      {data && data.unslotted > 0 && (
        <div style={{ fontSize: 10, color: muted, marginTop: 6 }}>
          {data.unslotted} cycles fall outside the hourly slots and are not in the averages.
        </div>
      )}
    </div>
  );
}

function OtTable({ cycles, ideal, onVideo, onBack, D, lineId, isMain, machineId, shiftName }) {
  const [ctSort, setCtSort] = useState(null);   // null | "desc" | "asc"
  const cycleCtSort = () => setCtSort(s => s === "desc" ? "asc" : s === "asc" ? null : "desc");
  const ctArrow = ctSort === "desc" ? " ▼" : ctSort === "asc" ? " ▲" : " ⇅";

  const [cmtFilter, setCmtFilter] = useState("all");   // "all" | "filled" | "unfilled"

  const [cmtMap, setCmtMap] = useState({});
  const cmtJsonRef = useRef("");
  useEffect(() => {
    if (!lineId) return;
    let stop = false;
    const pad = (n) => String(n).padStart(2, "0");
    const localDay = (off = 0) => {
      const d = new Date(); d.setDate(d.getDate() - off);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    const url = `/api/lines/${lineId}/comments-history`
              + `?date_from=${localDay(1)}&date_to=${localDay(0)}`;   // yesterday+today (night-shift safe)
    const load = () => {
      fetch(url)
        .then(r => (r.ok ? r.json() : Promise.reject(r.status)))
        .then(d => {
          if (stop) return;
          const m = {};
          for (const r of (d.rows || [])) {
            const pc = r && r.part_code;
            if (!pc) continue;
            const k = `${pc}|${r.shift_name || ""}`;
            if (!(k in m)) m[k] = r.text;
            if (!(`${pc}|*` in m)) m[`${pc}|*`] = r.text;    // any shift (only if ours is unknown)
          }
          const j = JSON.stringify(m);
          if (j !== cmtJsonRef.current) { cmtJsonRef.current = j; setCmtMap(m); }
        })
        .catch(() => {});
    };
    load();
    const t = setInterval(load, 8000);
    return () => { stop = true; clearInterval(t); };
  }, [lineId]);

  // Build the SAME per-cycle key the comment/remark boxes save under, so the
  // note matches.  Main (Final) → `cycle_<seq>_<date>` (identical to what
  // Fullscreen's video modal uses).  Sub → its real part_code, else the
  // synthesised `M<machineId>-C<seq>-<date>`.  Date = cycle ts (UTC slice),
  // exactly how the save side builds it.
  const _keyFor = (c) => {
    const day = c.ts ? new Date(c.ts).toISOString().slice(0, 10)
                     : new Date().toISOString().slice(0, 10);
    if (isMain) return `cycle_${c.cycle_seq}` + (c.ts ? `_${day}` : "");
    const realPC = c.part_code;
    return (realPC && String(realPC).trim())
      ? String(realPC).trim().replace(/:$/, "")
      : `M${machineId || 0}-C${c.cycle_seq}-${day}`;
  };
  // The note for THIS cycle: same shift as the cycle (the list only holds the
  // dashboard's current shift), else a legacy note saved without a shift —
  // exactly the rule the clip's comment box uses.  Shift unknown → any shift.
  const _cmtFor = (c) => {
    const k = _keyFor(c);
    const sh = c.shift_name || (shiftName && shiftName !== "—" ? shiftName : "");
    if (!sh) return cmtMap[`${k}|*`];
    return cmtMap[`${k}|${sh}`] || cmtMap[`${k}|`];
  };
  // Comment status uses the SAME live cmtMap the COMMENT column renders.
  const _hasCmt   = (c) => !!String(_cmtFor(c) || "").trim();
  const _overRows = (cycles || []).filter(c => c.ct != null && Number(c.ct) > ideal);
  const _totalOver = _overRows.length;
  const _filledN   = _overRows.filter(_hasCmt).length;
  const _unfilledN = _totalOver - _filledN;
  // Pipeline: over-target → comment filter → CT sort (both apply together).
  const rows = _overRows
    .filter(c => cmtFilter === "filled"   ? _hasCmt(c)
               : cmtFilter === "unfilled" ? !_hasCmt(c)
               : true)
    .slice()
    .sort((a, b) => {
      if (ctSort === "asc")  return (Number(a.ct) || 0) - (Number(b.ct) || 0);
      if (ctSort === "desc") return (Number(b.ct) || 0) - (Number(a.ct) || 0);
      return (Number(b.cycle_seq) || 0) - (Number(a.cycle_seq) || 0);
    });
  // Warm only the FIRST FEW rows on open, not the visible page.  Warming 10
  // meant paying for 9 renders nobody opened — measured as most of the CPU
  // spike that pushed the box from load 32 to 71.  The eye lands on the top of
  // the list; hover (below) covers whatever they actually pick.
  const _topSeqs = rows.slice(0, 3).map(c => c.cycle_seq).join(",");
  useEffect(() => {
    if (!_topSeqs) return;
    warmClips(lineId, isMain ? 0 : machineId, _topSeqs.split(",").map(Number));
  }, [_topSeqs, lineId, isMain, machineId]);

  const th = { textAlign: "left", fontSize: 10, fontWeight: 800, letterSpacing: ".06em",
               color: "#94a3b8", padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.14)" };
  const td = { fontSize: 12, padding: "6px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)",
               color: D ? "#e2e8f0" : "#1e293b", fontFamily: "monospace" };
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={onBack} style={{
        background: "none", border: "1px solid rgba(245,158,11,0.5)", color: "#f59e0b",
        borderRadius: 6, padding: "3px 12px", fontSize: 11, fontWeight: 800,
        cursor: "pointer", marginBottom: 8,
      }}>← Back to graphs</button>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "#f59e0b" }}>
          TODAY — Over-Target Cycles{" "}
          <span style={{ color: "#64748b", fontWeight: 600 }}>
            · {rows.length}{cmtFilter !== "all" ? ` of ${_totalOver}` : ""}
          </span>
        </div>
        <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
          {[["all", `All · ${_totalOver}`],
            ["filled", `Commented · ${_filledN}`],
            ["unfilled", `No comment · ${_unfilledN}`]].map(([k, label]) => (
            <button key={k} onClick={() => setCmtFilter(k)} style={{
              padding: "3px 10px", fontSize: 10, fontWeight: 800, letterSpacing: ".04em",
              borderRadius: 6, cursor: "pointer", whiteSpace: "nowrap",
              border: "1px solid rgba(245,158,11,0.5)",
              background: cmtFilter === k ? "#f59e0b" : "transparent",
              color: cmtFilter === k ? "#1a1205" : "#f59e0b",
            }}>{label}</button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "#64748b", fontStyle: "italic", padding: "14px 0" }}>
          {_totalOver === 0 ? "No over-target cycles right now."
            : cmtFilter === "unfilled" ? "All over-target cycles have comments ✓"
            : cmtFilter === "filled"   ? "No commented over-target cycles yet."
            : "No over-target cycles right now."}
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={th}>CYCLE</th>
            <th style={{ ...th, cursor: "pointer", userSelect: "none", color: ctSort ? "#f59e0b" : "#94a3b8" }}
                onClick={cycleCtSort}
                title="Sort by CT — click: max→min / min→max / default">CT{ctArrow}</th>
            <th style={th}>TIME</th>
            <th style={th}>RESULT</th>
            <th style={th}>COMMENT</th>
            <th style={{ ...th, textAlign: "center" }}>VIDEO</th>
          </tr></thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={`${c.cycle_seq}-${i}`}>
                <td style={td}>#{c._no ?? c.cycle_seq}</td>
                <td style={{ ...td, color: "#ef4444", fontWeight: 700 }}>{Number(c.ct).toFixed(2)}s</td>
                <td style={td}>{c.ts ? new Date(c.ts).toLocaleTimeString("en-GB") : "—"}</td>
                <td style={td}>
                  {c.is_ng
                    ? <span style={{ color: "#ef4444", fontWeight: 800 }}>Alarm</span>
                    : <span style={{ color: "#22c55e", fontWeight: 800 }}>OK</span>}
                </td>
                <td style={{ ...td, fontFamily: "inherit", whiteSpace: "normal",
                             wordBreak: "break-word", maxWidth: 360, lineHeight: 1.35,
                             color: D ? "#cbd5e1" : "#334155" }}>
                  {_cmtFor(c) || <span style={{ color: "#64748b" }}>—</span>}
                </td>
                <td style={{ ...td, textAlign: "center" }}>
                  <button onClick={() => onVideo && onVideo(c)}
                    onMouseEnter={() => warmClips(lineId, isMain ? 0 : machineId,
                                                  [c.cycle_seq])}
                    style={{
                    background: "#f59e0b", border: "none", color: "#1a1205", borderRadius: 5,
                    padding: "3px 12px", fontSize: 11, fontWeight: 800, cursor: "pointer",
                  }}>▶ VIDEO</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OtModal({ data, metric, setMetric, machineName, onClose, D, otCycles, otIdeal, onVideo, lineId, isMain, lossAll, machineId, subId, lossSeconds, shiftName }) {
  const rows = (data && data.rows) || [];
  const [showTbl, setShowTbl] = useState(false);
  const tBtn = (m, label) => (
    <button onClick={() => setMetric(m)} style={{
      padding: "4px 14px", fontSize: 11, fontWeight: 800, letterSpacing: ".06em",
      border: "1px solid rgba(245,158,11,0.5)", borderRadius: 6, cursor: "pointer",
      background: metric === m ? "#f59e0b" : "transparent",
      color: metric === m ? "#1a1205" : "#f59e0b",
    }}>{label}</button>
  );
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)", zIndex: 9000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: D ? "#0d1420" : "#ffffff", border: "1px solid rgba(245,158,11,0.4)",
        borderRadius: 12, padding: "16px 20px 20px", width: "min(1100px, 94vw)",
        maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        fontFamily: "'Barlow',sans-serif",
      }}>
        <div style={{ position: "relative", display: "flex",
                      justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 15, fontWeight: 900, color: "#f59e0b" }}>
            OVER TARGET — Last 30 Days
            <span style={{ color: D ? "#9fb0c9" : "#475569", fontWeight: 700, fontSize: 12 }}>
              {"  ·  "}{machineName}
            </span>
          </span>

          {/* 2026-08-07 — TOTAL LOSS, dead-centre of this popup's header.
              Same figure and formatting the header pill used to carry; it now
              lives only here.  `lossSeconds` is a live prop off the 8-second
              wallboard poll, so this keeps ticking while the popup is open. */}
          {/* 2026-08-11 — operator spec: on FINAL INSPECTION this popup lists
              EVERY machine's own gain/loss side by side ("sabka alag alag"),
              not one combined figure — the per-machine numbers are the point,
              and a sum of machines that run in parallel would not mean much
              anyway.  Every other machine's popup keeps the single centred
              figure it already had.  Both tick live off the 8 s poll. */}
          {(() => {
            const p    = (n) => String(n).padStart(2, "0");
            const hms  = (v) => {
              const t = Math.abs(Math.round(Number(v)));
              return `${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`;
            };
            const chip = (label, v, big) => {
              const neg = Number(v) < 0;
              const clr = neg ? "#22c55e" : "#f59e0b";
              const rgb = neg ? "34,197,94" : "245,158,11";
              return (
                <div key={label} style={{
                  display: "flex", alignItems: "center", gap: big ? 10 : 10,
                  justifyContent: big ? "center" : "space-between",
                  minWidth: big ? 0 : 250,
                  background: D ? `rgba(${rgb},0.14)` : `rgba(${rgb},0.10)`,
                  border: `1px solid rgba(${rgb},0.55)`,
                  borderRadius: 999, padding: big ? "3px 16px" : "2px 10px",
                  whiteSpace: "nowrap", lineHeight: 1.15,
                }}>
                  <span style={{ fontSize: big ? 15 : 11, fontWeight: 900, color: clr,
                                 fontFamily: "'Times New Roman', Times, serif",
                                 letterSpacing: ".04em", opacity: 0.9 }}>{label}</span>
                  <span style={{ fontSize: big ? 15 : 12, fontWeight: 900, color: clr,
                                 fontFamily: "'Times New Roman', Times, serif",
                                 letterSpacing: ".04em" }}>
                    {neg ? "−" : ""}{hms(v)}
                  </span>
                </div>
              );
            };

            if (isMain && Array.isArray(lossAll) && lossAll.length) {
              const ordered = [...lossAll].sort((x, y) => Number(x.loss) - Number(y.loss));
              return (
                <div style={{
                  display: "flex", flexDirection: "column", gap: 4,
                  alignItems: "stretch", marginLeft: "auto", marginRight: 14,
                  pointerEvents: "none", flex: "0 0 auto",
                }}>
                  {ordered.map(m => chip(m.name, m.loss, false))}
                </div>
              );
            }
            if (lossSeconds == null) return null;
            return (
              <div style={{
                position: "absolute", left: "50%", top: "50%",
                transform: "translate(-50%, -50%)", pointerEvents: "none",
              }}>
                {/* 2026-08-14 — labelled "Speed", not "Total".  The number has
                    always been SUM(ct − ideal) over the running cycles — a pure
                    speed figure — but calling it "Total Loss" read as though it
                    included breakdown / setup / quality time, which it never did. */}
                {chip(Number(lossSeconds) < 0 ? "Speed Gain" : "Speed Loss", lossSeconds, true)}
              </div>
            );
          })()}

          <button onClick={onClose} style={{ background: "none", border: "none",
                   color: "#94a3b8", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        {showTbl ? (
          <OtTable cycles={otCycles} ideal={otIdeal} onVideo={onVideo} shiftName={shiftName}
                   onBack={() => setShowTbl(false)} D={D}
                   lineId={lineId} isMain={isMain} machineId={machineId} />
        ) : (
          <>
            <div style={{ fontSize: 10, color: "#64748b", margin: "2px 0 10px" }}>
              {metric === "avg"
                ? "Average cycle time per hour = the hour's planned working time (breaks excluded) ÷ parts made in it — an hour at plan reads exactly the ideal CT. Pick a date and shift. Red = slower than ideal, green = at or under ideal. Hover a bar for details."
                : <>Cycles slower than ideal{data && data.ideal_ct ? ` (${data.ideal_ct}s)` : ""} — A &amp; B shift, toggle % / cycle count. Tap today's bar for its over-target videos.</>}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
              {tBtn("pct", "% OVER")}
              {tBtn("count", "No. OF CYCLES")}
              {tBtn("avg", "AVG CT")}
            </div>
            {metric === "avg" ? (
              <OtHourlyAvg lineId={lineId} subId={isMain ? null : subId}
                           ideal={data && data.ideal_ct} D={D} />
            ) : (
              <>
                <OtBars title="A SHIFT" rows={rows.filter(r => r.shift === "A")} metric={metric} onToday={() => setShowTbl(true)} />
                <OtBars title="B SHIFT" rows={rows.filter(r => r.shift === "B")} metric={metric} onToday={() => setShowTbl(true)} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MachineRow({ machine, idealCt, onPick, onCycleVideo, isMain = false, lossAll, chartReady, lineId, okOverride, ngOverride, shiftName }) {
  const _rawCycles = machine.cycles || [];
  const _isPhantom = (c) => c.is_ng && c.ct != null && Number(c.ct) < 0.1;
  const _phantomOk = _rawCycles.filter(_isPhantom).length;
  const _isBurstPhantom = (c) =>
    c.ct != null && idealCt > 0 && Number(c.ct) < idealCt * 0.5;
  const allCycles  = _rawCycles.filter(c => !_isPhantom(c) && !_isBurstPhantom(c));
  const _seqMaxAll  = allCycles.length ? Math.max(...allCycles.map(c => Number(c.cycle_seq) || 0)) : 0;
  const _seqIsShift = _seqMaxAll > 0 && _seqMaxAll <= allCycles.length * 1.5;
  allCycles.forEach((c, i) => { c._no = _seqIsShift ? c.cycle_seq : i + 1; });
  const cycNo = (c) => (c && c._no != null ? c._no : c?.cycle_seq);
  const WIN = 25;

  // Window state: default = sticky to END (latest 50).
  const [winStart, setWinStart] = useState(() =>
    Math.max(0, allCycles.length - WIN));
  const [sticky, setSticky]     = useState(true);

  const [otModal,  setOtModal]  = useState(null);    // {rows, ideal_ct} | null
  const [otMetric, setOtMetric] = useState("pct");   // "pct" | "count" | "avg"
  const _otOpen = () => {
    const url = `/api/lines/${lineId}/over-target-history`
              + (isMain ? "" : `?sub_id=${machine.sub_id}`);
    setOtModal({ rows: [], _loading: true });
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => setOtModal(d && Array.isArray(d.rows) ? d : { rows: [] }))
      .catch(() => setOtModal({ rows: [], _err: true }));
  };

  // When new cycles arrive and we're in sticky mode, snap to end.
  useEffect(() => {
    if (sticky) setWinStart(Math.max(0, allCycles.length - WIN));
  }, [allCycles.length, sticky]);

  const canvasRef = useRef(null);
  const chartRef  = useRef(null);

  const cycles  = allCycles.slice(winStart, winStart + WIN);
  const maxWin  = Math.max(0, allCycles.length - WIN);

  const lossSec = (machine.loss_seconds != null)
    ? Number(machine.loss_seconds)
    : allCycles.reduce(
        (acc, c) => acc + (c.ct == null ? 0 : (Number(c.ct) - idealCt)), 0);

  // ── Chart.js instance (create / update / destroy) ────────────────
  useEffect(() => {
    if (!chartReady || !canvasRef.current || !window.Chart) return;
    if (cycles.length === 0) {
      // No data — tear down any existing chart so the empty-state message renders
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
      return;
    }

    const idealCT = idealCt;
    const Y_CAP = Math.max(20, (idealCT || 15) + 25);
    const _observedCTs = cycles.map(c => c.ct).filter(v => v != null && v > 0);
    const _observedMin = _observedCTs.length ? Math.min(..._observedCTs) : (idealCT || 15);
    const Y_MIN = Math.max(
      0,
      Math.min(
        (idealCT || 15) - 10,       // proportional default
        Math.floor(_observedMin) - 2 // never crop real data below view
      )
    );
    const plotData = cycles.map(c => c.ct == null ? null : Math.min(c.ct, Y_CAP));
    const ptColors = cycles.map(cy => cy.is_ng ? FS_BAD : FS_OK);
    // NG dots also bigger so they stand out + white border ring.
    const ptRadius = cycles.map(cy => cy.is_ng ? 5 : 2);
    const ptHoverR = cycles.map(cy => cy.is_ng ? 11 : 7);
    const ptBorder    = cycles.map(cy => cy.is_ng ? "#ffffff"
                                        : (cy.ct > Y_CAP ? "#ffffff" : "#060912"));
    const ptBorderW   = cycles.map(cy => cy.is_ng ? 2
                                        : (cy.ct > Y_CAP ? 2 : 0.5));

    const data = {
      labels: cycles.map(c => cycNo(c)),
      datasets: [
        {
          label: "Cycle Time",
          data: plotData,
          borderWidth: 2,
          tension: 0,
          fill: false,
          spanGaps: false,
          pointBackgroundColor: ptColors,
          pointBorderColor: ptBorder,
          pointBorderWidth: ptBorderW,
          pointRadius: ptRadius,
          pointHoverRadius: ptHoverR,
          segment: {
            // Same threshold-aware gradient logic as Fullscreen.jsx so the
            // line shades from green → amber → red across the ideal line.
            borderColor: seg => {
              const a = cycles[seg.p0DataIndex]?.ct;
              const b = cycles[seg.p1DataIndex]?.ct;
              if (a == null || b == null) return "transparent";
              const aUp = a > idealCT + CT_TOL;
              const bUp = b > idealCT + CT_TOL;
              const aDn = a < idealCT - CT_TOL;
              const bDn = b < idealCT - CT_TOL;
              if (aUp && bUp) return `${FS_BAD}cc`;
              if (aDn && bDn) return `${FS_OK}cc`;
              if (!aUp && !aDn && !bUp && !bDn) return "rgba(245,158,11,0.85)";
              const c2 = canvasRef.current?.getContext("2d");
              if (!c2 || seg.p0.x === seg.p1.x) {
                return aUp ? `${FS_BAD}cc` : `${FS_OK}cc`;
              }
              const ratio = Math.max(0.01, Math.min(0.99,
                Math.abs(a - idealCT) / Math.abs(a - b)));
              const grad = c2.createLinearGradient(seg.p0.x, 0, seg.p1.x, 0);
              if (aUp) {
                grad.addColorStop(0,                              `${FS_BAD}cc`);
                grad.addColorStop(Math.max(0,   ratio - 0.04),    `${FS_BAD}cc`);
                grad.addColorStop(ratio,                          "rgba(245,158,11,0.85)");
                grad.addColorStop(Math.min(1,   ratio + 0.04),    `${FS_OK}cc`);
                grad.addColorStop(1,                              `${FS_OK}cc`);
              } else {
                grad.addColorStop(0,                              `${FS_OK}cc`);
                grad.addColorStop(Math.max(0,   ratio - 0.04),    `${FS_OK}cc`);
                grad.addColorStop(ratio,                          "rgba(245,158,11,0.85)");
                grad.addColorStop(Math.min(1,   ratio + 0.04),    `${FS_BAD}cc`);
                grad.addColorStop(1,                              `${FS_BAD}cc`);
              }
              return grad;
            },
          },
        },
        // Ideal-CT reference line (dashed amber)
        {
          type: "line",
          label: `Ideal ${idealCT}s`,
          data: Array(cycles.length).fill(idealCT),
          borderColor: "rgba(251,191,36,0.7)",
          borderWidth: 1.5,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
      ],
    };

    const yMax = Y_CAP;
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 12, bottom: 2, left: 4, right: 8 } },
      interaction: { intersect: false, mode: "index", axis: "x" },
      onClick: (evt, els /*, chart param shadows outer */) => {
        let idx = -1;
        const hit = els && els.find ? els.find(e => e.datasetIndex === 0) : null;
        if (hit) {
          idx = hit.index;
        } else if (evt?.native && chartRef.current) {
          // Manual nearest-X fallback: project the click X-pixel back
          // to a data index via Chart.js's x-scale.
          const rect = chartRef.current.canvas.getBoundingClientRect();
          const px   = (evt.native.clientX != null)
            ? evt.native.clientX - rect.left
            : (evt.native.offsetX || 0);
          const xScale = chartRef.current.scales?.x;
          if (xScale && typeof xScale.getValueForPixel === "function") {
            const v = xScale.getValueForPixel(px);
            if (v != null) idx = Math.round(v);
          }
        }
        if (idx < 0 || idx >= cycles.length) return;
        const cy = cycles[idx];
        if (!cy || cy.ct == null) return;
        if (typeof onCycleVideo === "function") onCycleVideo(machine, cy, isMain);
        if (evt?.native?.stopPropagation) evt.native.stopPropagation();
      },
      onHover: (evt) => {
        // Cursor pointer over the whole canvas — dots and column
        // gaps are both clickable now thanks to the index-mode hit.
        if (evt?.native?.target) evt.native.target.style.cursor = "pointer";
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          filter: (tooltipItem) => tooltipItem.datasetIndex === 0,
          callbacks: {
            title: i => {
              const cy = cycles[i[0].dataIndex];
              return `Cycle #${cy ? cycNo(cy) : i[0].label}`;
            },
            label: t => {
              const cy = cycles[t.dataIndex];
              if (!cy || cy.ct == null) return "—";
              const status = cy.is_ng ? "Alarm ⚠" : "OK ✓";
              const ts = cy.ts ? new Date(cy.ts) : null;
              const ts_s = ts ? ts.toLocaleTimeString("en-IN", {
                hour: "2-digit", minute: "2-digit", second: "2-digit",
                hour12: false,
              }) : "—";
              return [
                `Status:  ${status}`,
                `CT:      ${Number(cy.ct).toFixed(2)}s`,
                `Time:    ${ts_s}`,
                `tap for video`,
              ];
            },
          },
          backgroundColor: ctx => {
            const idx = ctx.tooltip?.dataPoints?.[0]?.dataIndex;
            const cy  = idx != null ? cycles[idx] : null;
            return cy?.is_ng ? "rgba(58,13,16,.97)" : "rgba(15,23,41,.95)";
          },
          borderColor: ctx => {
            const idx = ctx.tooltip?.dataPoints?.[0]?.dataIndex;
            const cy  = idx != null ? cycles[idx] : null;
            return cy?.is_ng ? "#ef4444" : "rgba(59,130,246,.5)";
          },
          titleColor: ctx => {
            const idx = ctx.tooltip?.dataPoints?.[0]?.dataIndex;
            const cy  = idx != null ? cycles[idx] : null;
            return cy?.is_ng ? "#fecaca" : "#e2e8f0";
          },
          bodyColor: ctx => {
            const idx = ctx.tooltip?.dataPoints?.[0]?.dataIndex;
            const cy  = idx != null ? cycles[idx] : null;
            return cy?.is_ng ? "#fecaca" : "#e2e8f0";
          },
          borderWidth: 1,
          padding: 8,
          titleFont: { weight: 800, size: 12 },
          bodyFont: { size: 11, family: "monospace" },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#e2e8f0",
            font: { size: 11, weight: "bold", family: "monospace" },
            maxRotation: 0, autoSkipPadding: 14,
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
        y: {
          beginAtZero: false,
          min: Y_MIN,
          max: Math.ceil(yMax),
          ticks: {
            color: textMut, font: { size: 10, family: "monospace" },
            callback: v => `${Math.round(v)}s`,
          },
          grid: { color: "rgba(255,255,255,0.04)" },
        },
      },
    };

    if (chartRef.current) {
      chartRef.current._cyclesRef = cycles;
      chartRef.current.data       = data;
      chartRef.current.options    = options;
      chartRef.current.update("none");
    } else {
      const ngMarkerPlugin = {
        id: "perDotLabel",
        afterDatasetsDraw(chart) {
          const meta = chart.getDatasetMeta(0);
          if (!meta || !meta.data) return;
          const liveCycles = chart._cyclesRef || cycles;
          const ctx2 = chart.ctx;
          ctx2.save();
          ctx2.textAlign    = "center";
          ctx2.textBaseline = "bottom";
          const MIN_GAP = 26;
          let lastLabelX = -Infinity;
          meta.data.forEach((pt, i) => {
            const cy = liveCycles[i];
            if (!cy || cy.ct == null) return;
            const x = pt.x, y = pt.y;
            const ct = Number(cy.ct).toFixed(1) + "s";
            if (cy.is_ng) {
              // ⚠ glyph above, then NG CT in red just under it — always shown
              ctx2.font      = "bold 11px 'Segoe UI Symbol', sans-serif";
              ctx2.fillStyle = "#fbbf24";
              ctx2.fillText("⚠", x, y - 18);
              ctx2.font      = "bold 10px monospace";
              ctx2.fillStyle = FS_BAD;
              ctx2.fillText(ct, x, y - 6);
              lastLabelX = x;
            } else if (x - lastLabelX >= MIN_GAP) {
              // OK CT in green above the dot — skipped if it would collide
              ctx2.font      = "bold 9px monospace";
              ctx2.fillStyle = FS_OK;
              ctx2.fillText(ct, x, y - 6);
              lastLabelX = x;
            }
          });
          ctx2.restore();
        },
      };
      chartRef.current = new window.Chart(canvasRef.current.getContext("2d"), {
        type: "line", data, options, plugins: [ngMarkerPlugin],
      });
      chartRef.current._cyclesRef = cycles;
    }
  }, [cycles, idealCt, chartReady]);

  // Destroy chart on unmount to avoid memory leak between line reloads
  useEffect(() => () => {
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
  }, []);

  if (!allCycles.length) {
    return (
      <div style={{
        height: "100%",
        background: card,
        border: `1px solid ${border}`,
        borderRadius: 6,
        display: "flex", alignItems: "center", justifyContent: "center",
        color: textMut, fontSize: 14,
      }}>
        {machine.machine_name} — no cycles this shift yet
      </div>
    );
  }

  const last      = cycles[cycles.length - 1];
  const lastColor = ctColor(last.ct, idealCt);

  return (
    <div
      style={{
        background: card,
        border: `1px solid ${border}`,
        borderRadius: 6,
        padding: "4px 6px 2px",
        height: "100%",
        display: "flex", flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      {/* Header strip */}
      <div style={{ display: "flex", alignItems: "center",
                    justifyContent: "space-between", height: 22,
                    padding: "0 6px",
                    position: "relative" }}>
        <div style={{
          fontSize: isMain ? 14 : 13,
          fontWeight: 900,
          // Title must never run under the centred LOSS chip.
          flex: 1, minWidth: 0, overflow: "hidden",
          textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: text,
          letterSpacing: ".02em",
        }}>
          {isMain
            ? `★ ${machine.machine_name}`
            : `M-${machine.machine_seq || "?"} · ${machine.machine_name}`}
          <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 700,
                          color: textMut, letterSpacing: ".05em" }}>
            (tap dot for video)
          </span>
        </div>

        {/* 2026-08-07 — the Total Loss pill used to sit here, centred in the
            header.  Operator moved it INSIDE the OVER TARGET popup ("uske
            andar center mein aaye"), so the graph header is back to just
            name + OK/NG.  The figure itself is unchanged — see `lossSec`
            above and the pill in OtModal. */}

        <div style={{ display: "flex", gap: 10, alignItems: "center",
                      flexShrink: 0 }}>
          {/* 2026-05-24 — Show OK + NG counts separately so operator
              can see per-machine reject rate at a glance.  NG count
              shown in red, OK in green. */}
          {(() => {
            const _okCy = allCycles.filter(c => !c.is_ng);
            const _ngCy = allCycles.filter(c => c.is_ng);
            const _maxSeq   = (arr) => arr.length ? Math.max(...arr.map(x => Number(x.cycle_seq) || 0)) : 0;
            const _seqCount = (arr) => { const m = _maxSeq(arr); return (m > 0 && m <= arr.length * 1.5) ? m : arr.length; };
            const _mainOk = _seqCount(_okCy);
            const okN = !isMain ? _seqCount(_okCy)
                      : (okOverride == null ? _mainOk
                         : ((okOverride - _mainOk) > 200 ? _mainOk : okOverride));
            // Sub-machine NG (alarm) is recorded with ct=0 — the NG poller logs
            // the ng_bit event, it doesn't measure a cycle time — so the chart's
            // 0s-phantom filter (ct<0.1) wrongly dropped EVERY real sub NG and
            // the tile always showed "Alarm: 0".  Count NG from the RAW cycles so
            // real alarms show on every machine/line; the chart still hides the
            // 0s points (allCycles).  Main keeps its PLC-register ngOverride.
            const _rawNgCy = _rawCycles.filter(c => c.is_ng);
            const ngN = !isMain ? _seqCount(_rawNgCy)
                      : (ngOverride != null ? ngOverride : _seqCount(_rawNgCy));
            return (
              <span style={{ fontSize: 10, fontWeight: 700, color: textMut,
                              fontFamily: "monospace" }}>
                <span style={{ color: FS_OK }}>OK: {okN}</span>
                <span style={{ margin: "0 6px", color: textMut }}>·</span>
                <span style={{ color: FS_BAD }}>Alarm: {ngN}</span>
                <span style={{ margin: "0 6px", color: textMut }}>·</span>
                <span>ideal {idealCt}s</span>
              </span>
            );
          })()}
          <span style={{ fontSize: 16, fontWeight: 900,
                          color: lastColor,
                          fontFamily: "monospace",
                          minWidth: 60, textAlign: "right" }}>
            {last.ct.toFixed(2)}s
          </span>
        </div>
      </div>

      {/* Chart.js canvas — same look + threshold-gradient line as Fullscreen.jsx */}
      <div style={{ flex: 1, minHeight: 0, position: "relative",
                    padding: "2px 4px 0" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
        {/* 2026-06-01 — "Over target" QTY badge.  Operator: graph ke side
            me dikhao kitne CT target (ideal) se upar gaye.  Absolute overlay
            in the top-right corner so the chart width stays unchanged.
            Counts ALL cycles this shift (OK + NG) whose ct > ideal.  Amber =
            slow-warning, NOT reject-red.  Display-only: reads allCycles that
            is already loaded for the graph — no API / collector / DB touch.
            pointerEvents:none so dot-tap (video) + panel-open pass through. */}
        {(() => {
          const over  = allCycles.filter(c => c.ct != null && c.ct > idealCt).length;
          const _allMax = allCycles.length ? Math.max(...allCycles.map(c => Number(c.cycle_seq) || 0)) : 0;
          const total = (_allMax > 0 && _allMax <= allCycles.length * 1.5) ? _allMax : allCycles.length;
          const pct   = total ? Math.round((over / total) * 100) : 0;
          return (
            <div
              onClick={(e) => { e.stopPropagation(); _otOpen(); }}
              title="Tap — last 30 days over-target (A / B shift)"
              style={{
              position: "absolute", top: 4, right: 6,
              background: D ? "rgba(20,14,4,0.82)" : "rgba(255,251,235,0.92)",
              border: "1px solid rgba(245,158,11,0.5)",
              borderRadius: 5, padding: "2px 7px",
              display: "flex", flexDirection: "column", alignItems: "center",
              lineHeight: 1.05, pointerEvents: "auto", cursor: "pointer",
            }}>
              <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: ".06em",
                              color: "#f59e0b" }}>OVER TARGET</span>
              <span style={{ fontSize: 18, fontWeight: 900, fontFamily: "monospace",
                              color: "#f59e0b" }}>{over}</span>
              <span style={{ fontSize: 8, fontWeight: 700, fontFamily: "monospace",
                              color: textMut }}>▲ {pct}% of {total}</span>
            </div>
          );
        })()}

        {otModal && createPortal(
          <OtModal
            data={otModal} metric={otMetric} setMetric={setOtMetric}
            machineName={machine.machine_name || (isMain ? "Final Inspection" : "Machine")}
            onClose={() => setOtModal(null)} D={D}
            otCycles={allCycles} otIdeal={idealCt} shiftName={shiftName}
            lossSeconds={lossSec}
            lossAll={lossAll}
            lineId={lineId} isMain={isMain}
            machineId={machine.id || machine.sub_id || 0}
            subId={isMain ? null : machine.sub_id}
            onVideo={(cy) => { if (typeof onCycleVideo === "function") onCycleVideo(machine, cy, isMain); }}
          />, document.body)}
      </div>

      {/* Slider — 50-cycle window scrubber.
          Click the chart container = onPick fires; we stopPropagation on the
          slider so dragging it doesn't accidentally open the panel.       */}
      {maxWin > 0 && (
        <div onClick={e => e.stopPropagation()}
              style={{ padding: "2px 8px 0", display: "flex", alignItems: "center",
                       gap: 8, height: 16 }}>
          <span style={{ fontSize: 9, color: textMut, fontFamily: "monospace",
                          width: 32, textAlign: "right" }}>
            #{cycNo(allCycles[winStart])}
          </span>
          <input
            type="range" min={0} max={maxWin} step={1}
            value={winStart}
            onChange={(e) => {
              const v = Number(e.target.value);
              setWinStart(v);
              setSticky(v >= maxWin - 1);   // released near end = re-enable live tracking
            }}
            style={{ flex: 1, accentColor: "#60a5fa", height: 4 }}
          />
          <span style={{ fontSize: 9, color: textMut, fontFamily: "monospace",
                          width: 32 }}>
            #{cycNo(allCycles[Math.min(allCycles.length - 1, winStart + WIN - 1)])}
          </span>
          <button
            onClick={() => { setWinStart(maxWin); setSticky(true); }}
            title="Jump to latest"
            disabled={sticky && winStart === maxWin}
            style={{
              fontSize: 9, fontWeight: 700,
              padding: "1px 6px", borderRadius: 3,
              border: `1px solid ${sticky ? "rgba(34,197,94,.4)" : border}`,
              background: sticky ? "rgba(34,197,94,.12)" : "transparent",
              color: sticky ? okClr : textSub, cursor: "pointer",
            }}>
            {sticky ? "● LIVE" : "↦ LIVE"}
          </button>
        </div>
      )}
    </div>
  );
}

function HourlyPanel({ machine, slots, onClose }) {
  if (!machine) return null;
  return (
    <div style={{
      position: "absolute",
      top: 12, right: 12,
      width: 320,
      maxHeight: "calc(100% - 24px)",
      background: "rgba(15,23,41,.92)",
      backdropFilter: "blur(10px)",
      WebkitBackdropFilter: "blur(10px)",
      border: `1px solid rgba(59,130,246,.4)`,
      borderRadius: 10,
      padding: "12px 14px",
      overflow: "auto",
      boxShadow: "0 12px 32px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.04) inset",
      display: "flex", flexDirection: "column", gap: 6,
      zIndex: 50,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between",
                    alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <div style={{ fontSize: 10, color: "#3b82f6", fontWeight: 800,
                        letterSpacing: ".1em", textTransform: "uppercase",
                        marginBottom: 2 }}>
            Machine · M-{machine.machine_seq || "?"}
          </div>
          <div style={{ fontSize: 15, fontWeight: 900, color: text }}>
            {machine.machine_name}
          </div>
        </div>
        <button onClick={onClose} style={{
          background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)",
          color: textMut, cursor: "pointer", width: 26, height: 26,
          borderRadius: 6, fontSize: 14, padding: 0, lineHeight: 1,
        }}>×</button>
      </div>
      <div style={{ fontSize: 10, color: textMut, textTransform: "uppercase",
                    letterSpacing: ".1em", marginTop: 6, fontWeight: 700 }}>
        Hourly slots · today
      </div>
      {slots.length === 0 && (
        <div style={{ fontSize: 12, color: textMut, fontStyle: "italic",
                      padding: "10px 0" }}>
          No slot data available
        </div>
      )}
      {/* Slot card style mirrors the Production Dashboard's hourly table:
            PLAN  /  OK ·NG  /  ACTUAL (+variance)
          For sub-machine clicks the payload only has `count` + `plan`, so
          we fall back gracefully when ok/ng/actual aren't supplied.       */}
      {slots.map((s, i) => {
        const plan    = s.plan ?? 0;
        const actual  = s.actual ?? s.count ?? 0;
        const ok      = s.ok    ?? null;
        const ng      = s.ng    ?? null;
        const variance= actual - plan;
        const pct     = plan > 0 ? Math.min(100, (actual / plan) * 100) : 0;
        const isHit   = actual >= plan && plan > 0;
        const barClr  = isHit ? okClr : (actual > 0 ? "#fbbf24" : "#475569");
        return (
          <div key={i} style={{
            background: "rgba(255,255,255,.04)",
            border: "1px solid rgba(255,255,255,.06)",
            borderRadius: 6, padding: "7px 10px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between",
                          alignItems: "center", marginBottom: 5,
                          fontFamily: "monospace" }}>
              <span style={{ fontSize: 12, color: text, fontWeight: 800 }}>
                {s.label}
              </span>
              <span style={{ fontSize: 9, color: textMut, fontWeight: 700,
                              letterSpacing: ".06em" }}>
                {s.start && s.end ? `${s.start}-${s.end}` : ""}
              </span>
            </div>
            <div style={{
              display: "grid",
              gridTemplateColumns: ok != null ? "1fr 1fr 1fr" : "1fr 1fr",
              gap: 6, marginBottom: 5,
            }}>
              <div>
                <div style={{ fontSize: 9, color: textMut, fontWeight: 700,
                                letterSpacing: ".05em" }}>PLAN</div>
                <div style={{ fontSize: 14, fontFamily: "monospace",
                                fontWeight: 900, color: "#60a5fa" }}>
                  {plan}
                </div>
              </div>
              {ok != null && (
                <div>
                  <div style={{ fontSize: 9, color: textMut, fontWeight: 700,
                                  letterSpacing: ".05em" }}>OK · Alarm</div>
                  <div style={{ fontSize: 14, fontFamily: "monospace",
                                  fontWeight: 900 }}>
                    <span style={{ color: okClr }}>{ok}</span>
                    <span style={{ color: textMut, margin: "0 3px" }}>·</span>
                    <span style={{ color: ng > 0 ? badClr : textMut }}>{ng}</span>
                  </div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 9, color: textMut, fontWeight: 700,
                                letterSpacing: ".05em" }}>ACTUAL</div>
                <div style={{ fontSize: 14, fontFamily: "monospace",
                                fontWeight: 900, color: barClr }}>
                  {actual}
                  <span style={{
                    fontSize: 10, marginLeft: 4, fontWeight: 700,
                    color: variance > 0 ? okClr
                          : variance < 0 ? badClr : textMut,
                  }}>
                    ({variance > 0 ? "+" : ""}{variance})
                  </span>
                </div>
              </div>
            </div>
            <div style={{ height: 4, background: "rgba(255,255,255,.06)",
                          borderRadius: 2, overflow: "hidden" }}>
              <div style={{
                width: `${pct}%`, height: "100%",
                background: barClr,
                transition: "width .3s",
                boxShadow: isHit ? "0 0 5px rgba(34,197,94,.4)" : "none",
              }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────
export default function WallboardLeft() {
  // Player element, so the always-visible progress bar can read its time.
  const vidRef = useRef(null);
  const { lineId: lineRef } = useParams();
  const [resolvedId, setResolvedId] = useState(
    /^\d+$/.test(lineRef || "") ? lineRef : null);

  useEffect(() => {
    if (/^\d+$/.test(lineRef || "")) { setResolvedId(lineRef); return; }
    let stop = false;
    axios.get(`/api/lines/resolve-ref/${encodeURIComponent(lineRef || "")}`)
      .then(r => { if (!stop && r.data?.line_id) setResolvedId(String(r.data.line_id)); })
      .catch(() => { /* bad name -> stays null, tiles show "no data" */ });
    return () => { stop = true; };
  }, [lineRef]);

  const lineId = resolvedId;
  const [data, setData] = useState(null);
  const [summary, setSum] = useState(null);
  const [loopLines, setLoopLines] = useState([]);
  const [loopMenuOpen, setLoopMenuOpen] = useState(false);
  useEffect(() => {
    if (!lineId) return;
    let alive = true;
    const isLoop = (l) =>
      String(l?.db_table_name || "").toLowerCase().startsWith("loop_pipe");
    const _tok = (typeof window !== "undefined"
                    && sessionStorage.getItem("mes_token")) || "";
    axios.get("/api/lines", { headers: _tok ? { Authorization: `Bearer ${_tok}` } : {} })
      .then(r => {
        if (!alive) return;
        const all = Array.isArray(r.data) ? r.data : [];
        const cur = all.find(l => String(l.id) === String(lineId));
        if (cur && isLoop(cur)) {
          setLoopLines(all.filter(l => isLoop(l) && l.is_active !== false)
                          .sort((a, b) => a.id - b.id));
        } else {
          setLoopLines([]);
        }
      })
      .catch(() => { /* keep last known list on transient errors */ });
    return () => { alive = false; };
  }, [lineId]);
  const [bdPend, setBdPend] = useState(null);
  const [bdOpen, setBdOpen] = useState(false);
  useEffect(() => {
    if (!lineId) return;
    let alive = true;
    const load = () => {
      const _tok = (typeof window !== "undefined" && sessionStorage.getItem("mes_token")) || "";
      axios.get(`/api/prod-breakdown-slips/line-pending?line_id=${lineId}`,
                { headers: _tok ? { Authorization: `Bearer ${_tok}` } : {} })
        .then(r => { if (alive) setBdPend(r.data || null); })
        .catch(() => { /* keep the last count on a transient error */ });
    };
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, [lineId]);
  const [chartReady, setChartReady] = useState(!!window.Chart);
  useChartJS(() => setChartReady(true), []);

  const [videoCycle, setVideoCycle] = useState(null); // {machine, cycle, url, isMain}
  const [vidLoading, setVidLoading] = useState(false);
  const [vidBuffered, setVidBuffered] = useState(0);   // 0..1
  useEffect(() => {
    const b = document.body, prevM = b.style.margin, prevBg = b.style.background;
    b.style.margin = "0";
    b.style.background = "#0b0e13";
    return () => { b.style.margin = prevM; b.style.background = prevBg; };
  }, []);

  const [vidStall,    setVidStall]    = useState(false); // stalled AFTER play began
  const [vidWait, setVidWait] = useState(0);      // seconds, ticking
  const vidTimerRef = useRef(null);               // stopwatch -> telemetry
  const vidSrcRef   = useRef(null);               // promise of X-Clip-Source
  const vidWaitStart = useRef(0);                 // elapsed is measured, not accumulated
  const _probeSrc = useCallback((u, el) => {
    try {
      vidSrcRef.current = fetch(u, { headers: { Range: "bytes=0-0" } })
        .then(r => {
          const s = r.headers.get("x-clip-source") || "render";
          if (el) el.dataset.clipSource = s;
          return { source: s };
        })
        .catch(() => ({ source: "render" }));
    } catch { vidSrcRef.current = null; }
  }, []);
  const openCycleVideo = useCallback((machine, cy, isMain) => {
    if (!cy || cy.ct == null) return;
    const token = sessionStorage.getItem("mes_token") || "";
    const _ngQ = `&ng=${cy.is_ng ? 1 : 0}`;
    const _r   = `${cy.cycle_seq}${cy.is_ng ? "n" : ""}`;
    const url = isMain
      ? `/api/lines/${lineId}/cycle-video?cycle_seq=${cy.cycle_seq}`
        + _ngQ + `&token=${encodeURIComponent(token)}&r=${_r}`
      : `/api/submachines/${machine.sub_id}/cycle-video?cycle_seq=${cy.cycle_seq}`
        + _ngQ + `&token=${encodeURIComponent(token)}&r=${_r}`;
    setVidLoading(true); setVidBuffered(0); setVidStall(false); setVidWait(0);
    vidWaitStart.current = performance.now();
    vidTimerRef.current = startTimer("video",
      String(machine.machine_name || (isMain ? "Final Inspection" : `M-${machine.machine_seq}`)),
      { lineId });
    setVideoCycle({ machine, cy, url, isMain });
  }, [lineId]);
  // Close the popup AND stop its download.  A <video> removed from the page is
  // only paused, not aborted: with preload="auto" it keeps fetching (and keeps
  // one of the browser's 6 connections to this server) until it is garbage
  // collected.  On a slow link every closed clip then competed with the next
  // one: 0.7 s -> 1 s -> 4.9 s -> 18.8 s for four clicks at 2 Mbit/s.
  const closeVideo = useCallback(() => {
    const v = vidRef.current;
    if (v) {
      v.dataset.closing = "1";
      try { v.pause(); v.removeAttribute("src"); v.load(); } catch { /* already gone */ }
    }
    setVideoCycle(null);
  }, []);
  const [now, setNow]   = useState(new Date());

  const _detectOrient = () =>
    (typeof window !== "undefined" && window.innerHeight > window.innerWidth)
      ? "portrait" : "landscape";
  const [orientation, setOrientation] = useState(_detectOrient);
  const isPortrait = orientation === "portrait";
  const [viewportPortrait, setViewportPortrait] = useState(() =>
    typeof window !== "undefined" && window.innerHeight > window.innerWidth);
  const needsRotation = isPortrait !== viewportPortrait;

  const prevVpShapeRef = useRef(
    typeof window !== "undefined" && window.innerHeight > window.innerWidth);
  useEffect(() => {
    const onResize = () => {
      const vp = window.innerHeight > window.innerWidth;
      setViewportPortrait(prev => prev === vp ? prev : vp);
      if (prevVpShapeRef.current !== vp) {
        prevVpShapeRef.current = vp;
        setOrientation(vp ? "portrait" : "landscape");
      }
    };
    onResize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Auto-refresh cycles every 8s, summary every 30s
  const fetchCycles = useCallback(() => {
    // lineId is null until a NAMED url resolves — don't fire /api/lines/null/…
    if (!lineId) return;
    axios.get(`/api/lines/${lineId}/wallboard-cycles`)
         .then(r => setData(r.data))
         .catch(() => {});
  }, [lineId]);
  const fetchSummary = useCallback(() => {
    // lineId is null until a NAMED url resolves — don't fire /api/lines/null/…
    if (!lineId) return;
    axios.get(`/api/lines/${lineId}/wallboard-summary`)
         .then(r => setSum(r.data))
         .catch(() => {});
  }, [lineId]);

  useEffect(() => {
    const nm = summary?.kpi?.line_name;
    document.title = nm ? `${nm}.SUPERVISOR` : `SUPERVISOR · Line ${lineId || lineRef}`;
  }, [summary?.kpi?.line_name, lineId]);

  useEffect(() => {
    fetchCycles(); fetchSummary();
    const c = setInterval(fetchCycles, 8000);
    const s = setInterval(fetchSummary, 30000);
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => { clearInterval(c); clearInterval(s); clearInterval(t); };
  }, [fetchCycles, fetchSummary, lineId]);

  // R keyboard shortcut → toggle orientation (skip while typing)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "r" && e.key !== "R") return;
      const t = e.target;
      const tag = (t?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || t?.isContentEditable) return;
      setOrientation(o => o === "portrait" ? "landscape" : "portrait");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!vidLoading) return;
    const t = setTimeout(() => setVidLoading(false), 30000);
    const tick = setInterval(() => {
      if (vidWaitStart.current) setVidWait((performance.now() - vidWaitStart.current) / 1000);
    }, 100);
    return () => { clearTimeout(t); clearInterval(tick); };
  }, [vidLoading, videoCycle]);

  useEffect(() => {
    if (!videoCycle) return;
    const onEsc = (e) => { if (e.key === "Escape") closeVideo(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [videoCycle, closeVideo]);

  const subs       = (data?.machines || []).slice().sort((a, b) =>
    (b.machine_seq || 0) - (a.machine_seq || 0)
  );
  const mainRow    = data?.main || null;
  // Combined list: main row FIRST, then sub-machines
  const allRows    = mainRow ? [mainRow, ...subs] : subs;

  const lossBreakdown = allRows
    .filter(m => m.loss_seconds != null)
    .map(m => ({
      name: String(m.machine_name || "").trim() || `M-${m.machine_seq}`,
      loss: Number(m.loss_seconds),
      isMain: !!m.is_main,
    }));
  const shiftName  = data?.shift_name || "—";

  const toggleFS = () => {
    const el = document.documentElement;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  const overlayPosStyle = {
    position: "fixed",
    inset: 0,
  };

  return (
    <div style={{
      height:  needsRotation ? "100vw" : "100vh",
      width:   needsRotation ? "100vh" : "100%",
      background: bg, color: text,
      fontFamily: "'Barlow',sans-serif",
      overflow: "hidden",
      display: "flex", flexDirection: "column",
      position: needsRotation ? "fixed" : "static",
      top:      needsRotation ? 0       : undefined,
      left:     needsRotation ? "100vw" : undefined,
      transformOrigin: needsRotation ? "top left" : undefined,
      transform: needsRotation ? "rotate(90deg)" : undefined,
    }}>
      {/* Slide-nav menu — portaled to <body> so it escapes this wrapper's
          rotate() transform (a transformed ancestor breaks position:fixed).
          Trigger hidden; opened by the header-logo click below via the
          "tbdi:open-nav" window event. */}
      {createPortal(<SlideNav hideTrigger raise />, document.body)}
      {/* 2026-10-08 — pending breakdown slips list (header B/D SLIPS pill).
          Portal for the same reason as SlideNav: the wall may be rotated. */}
      {bdOpen && createPortal((() => {
        const slips = bdPend?.slips || [];
        const fmtAge = (m) => m == null ? "—"
          : m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
          : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
        const hhmm = (iso) => iso ? String(iso).replace("T", " ").slice(5, 16) : "—";
        const groups = [];
        for (const s of slips) {
          const k = `${s.slip_date || (s.bd_start || "").slice(0, 10)} · ${s.shift || "—"} SHIFT`;
          let g = groups.find(x => x.k === k);
          if (!g) { g = { k, items: [] }; groups.push(g); }
          g.items.push(s);
        }
        return (
          <div onClick={() => setBdOpen(false)}
               style={{ position: "fixed", inset: 0, background: "rgba(2,6,23,.6)", zIndex: 10050,
                        display: "flex", alignItems: "flex-start", justifyContent: "center",
                        padding: "6vh 12px", overflowY: "auto" }}>
            <div onClick={e => e.stopPropagation()}
                 style={{ width: "100%", maxWidth: 760, background: card, color: text,
                          border: `1px solid ${border}`, borderRadius: 12,
                          boxShadow: "0 20px 60px rgba(0,0,0,.5)", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px",
                            borderBottom: `1px solid ${border}` }}>
                <strong style={{ fontSize: 15 }}>Pending breakdown slips</strong>
                <span style={{ fontSize: 12, color: textMut }}>{summary?.kpi?.line_name || ""} · {slips.length}</span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: textMut }}>
                  After shift end + {bdPend?.grace_min ?? 30} min only the Shift Incharge can fill
                </span>
                <button onClick={() => setBdOpen(false)}
                  style={{ border: "none", background: "transparent", color: textMut, fontSize: 20,
                           cursor: "pointer", lineHeight: 1 }}>×</button>
              </div>
              {slips.length === 0 && (
                <div style={{ padding: 18, color: textMut, fontSize: 13 }}>No breakdown slip pending for this line.</div>
              )}
              {groups.map(g => (
                <div key={g.k}>
                  <div style={{ padding: "8px 16px", fontSize: 11, fontWeight: 800, letterSpacing: ".06em",
                                color: textSub, background: D ? "#0a1322" : "#f1f5f9" }}>
                    {g.k} · {g.items.length}
                  </div>
                  {g.items.map(s => (
                    <div key={`${s.src}-${s.id}`}
                         style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                                  padding: "10px 16px", borderTop: `1px solid ${border}`, fontSize: 13 }}>
                      <strong>#{s.id}</strong>
                      <span style={{ minWidth: 0, flex: "1 1 220px" }}>
                        {s.machine_name || s.machine_no || "—"}
                        <span style={{ color: textMut }}> · {s.src === "toolroom" ? "Tool Room" : "Maintenance"}</span>
                      </span>
                      <span style={{ color: textSub }}>B/D start {hhmm(s.bd_start)}</span>
                      <span style={{ color: s.pending_min >= 60 ? badClr : warnClr, fontWeight: 800 }}>
                        pending {fmtAge(s.pending_min)}
                      </span>
                      {s.locked && (
                        <span title={`Window closed ${hhmm(s.fill_deadline)}`}
                              style={{ fontSize: 11, fontWeight: 800, color: badClr,
                                       border: `1px solid ${badClr}55`, borderRadius: 99, padding: "1px 8px" }}>
                          🔒 Shift Incharge only
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${border}`, display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => window.open("/prod-breakdown-slip", "_blank")}
                  style={{ fontSize: 12, fontWeight: 800, padding: "6px 14px", borderRadius: 8, cursor: "pointer",
                           background: "#2563eb", color: "#fff", border: "1px solid #2563eb" }}>
                  Open Breakdown Slip page
                </button>
              </div>
            </div>
          </div>
        );
      })(), document.body)}
      {/* Header bar — 2026-05-18-r13 — Rebuilt to match Fullscreen.jsx
          header style (operator spec: "second screenshot wale me
          light dark ka option nhi aaya or ye line 2 kya h same head
          kr de ye last wale screenshot jaisa").  Adds: line name +
          date, RUNNING status pill, Final Inspection pill, model
          info, live indicator, LIGHT/DARK toggle.  Flex-wraps onto
          two rows when narrow (same trick we use in Fullscreen).   */}
      <div style={{
        minHeight: 50, padding: "4px 14px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", rowGap: 4, gap: 8,
        borderBottom: `1px solid ${border}`, background: card,
        flexShrink: 0,
      }}>
        {/* Left cluster — logo + line name + date + shift + status + machine pills */}
        <div style={{ display: "flex", alignItems: "center", gap: 10,
                      flexWrap: "wrap", rowGap: 4, minWidth: 0 }}>
          <img src="/logo.jpg" alt="Toyota Boshoku"
                onClick={() => window.dispatchEvent(new Event("tbdi:open-nav"))}
                title="Open menu"
                style={{ width: 40, height: 40, borderRadius: 8,
                          objectFit: "contain", cursor: "pointer",
                          background: "#fff", padding: 3, flexShrink: 0 }} />
          <div style={{ minWidth: 0, position: "relative" }}>
            {/* 2026-09-13 — Loop Pipe lines only: line-NAME becomes a dropdown to
                switch between Loop Pipe lines (keeps the Supervisor view). Every
                other line keeps the plain, non-clickable name. */}
            {loopLines.length > 0 ? (
              <div
                onClick={() => setLoopMenuOpen(o => !o)}
                title="Switch between Loop Pipe lines"
                style={{ fontSize: 15, fontWeight: 900, color: text,
                         letterSpacing: ".02em", lineHeight: 1.1,
                         whiteSpace: "nowrap", cursor: "pointer",
                         display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span>{summary?.kpi?.line_name || "—"}</span>
                <span style={{ fontSize: 12, opacity: .55 }}>▾</span>
              </div>
            ) : (
              <div style={{ fontSize: 15, fontWeight: 900, color: text,
                            letterSpacing: ".02em", lineHeight: 1.1,
                            whiteSpace: "nowrap" }}>
                {summary?.kpi?.line_name || "—"}
              </div>
            )}
            <div style={{ fontSize: 10, color: textMut, marginTop: 1,
                          whiteSpace: "nowrap" }}>
              {data?.record_date || new Date().toISOString().slice(0,10)}
            </div>
            {/* Loop Pipe line dropdown */}
            {loopLines.length > 0 && loopMenuOpen && (
              <div onClick={() => setLoopMenuOpen(false)}
                   style={{ position: "absolute", top: "100%", left: 0, marginTop: 4,
                     background: card, border: `1px solid ${border}`, borderRadius: 8,
                     minWidth: 220, maxHeight: 320, overflowY: "auto",
                     boxShadow: "0 12px 32px rgba(0,0,0,.55)",
                     zIndex: 9999, padding: 4 }}>
                {loopLines.map((l, idx) => {
                  const isCurrent = String(l.id) === String(lineId);
                  const ACC = "#38bdf8";
                  return (
                    <div key={l.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setLoopMenuOpen(false);
                        if (isCurrent) return;
                        // Preserve the Supervisor view and full-reload for fresh
                        // line state. line_code resolves via resolve-ref.
                        const ref = encodeURIComponent(
                          String(l.line_code || l.line_name || l.id).trim().replace(/\s+/g, "-"));
                        const p = window.location.pathname;
                        const dest = p.endsWith("/MANAGEMENT")        ? `/${ref}/MANAGEMENT`
                                   : p.startsWith("/wallboard/left/")  ? `/wallboard/left/${l.id}`
                                   :                                     `/${ref}/SUPERVISOR`;
                        window.location.assign(dest);
                      }}
                      style={{ padding: "8px 10px", borderRadius: 5, fontSize: 12,
                        color: isCurrent ? ACC : text,
                        background: isCurrent ? `${ACC}15` : "transparent",
                        cursor: isCurrent ? "default" : "pointer",
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                      onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = `${ACC}10`; }}
                      onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = "transparent"; }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ minWidth: 24, height: 24, display: "inline-flex",
                          alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 900,
                          fontFamily: "monospace",
                          color: isCurrent ? ACC : text,
                          background: isCurrent ? `${ACC}28` : border,
                          borderRadius: 6 }}>
                          {idx + 1}
                        </span>
                        <strong>{l.line_name}</strong>
                      </span>
                      {isCurrent && (
                        <span style={{ fontSize: 9, fontWeight: 800, color: ACC }}>
                          ● HERE
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{ width: 1, height: 22, background: border }}/>

          {/* Shift pill — green */}
          <span style={{ fontSize: 11, fontWeight: 800,
                          padding: "3px 10px", borderRadius: 99,
                          background: `${okClr}18`,
                          border: `1px solid ${okClr}33`,
                          color: okClr,
                          whiteSpace: "nowrap" }}>
            {shiftName} SHIFT
          </span>

          {/* RUNNING / status pill — colour from summary KPI if present */}
          {(() => {
            const st = (summary?.kpi?.operating_status || "RUNNING").toUpperCase();
            const SC = { RUNNING: okClr, BREAKDOWN: badClr, MAINTENANCE: badClr,
                         TOOLROOM: "#ec4899", QUALITY_ISSUE: "#f97316",
                         MATERIAL_WAIT: "#eab308", MODEL_SETUP: "#3b82f6",
                         SETUP: "#3b82f6", OTHER_LOSS: "#a855f7",
                         CHANGE_OVER: "#06b6d4", BREAK: "#7dd3fc", IDLE: "#94a3b8" };
            const sc = SC[st] || warnClr;
            return (
              <span title={summary?.kpi?.andon_calls ? `Andon: ${summary.kpi.andon_calls}` : undefined}
                    style={{ fontSize: 11, fontWeight: 800,
                              padding: "3px 12px", borderRadius: 99,
                              background: `${sc}18`,
                              border: `1px solid ${sc}33`,
                              color: sc,
                              letterSpacing: ".06em",
                              whiteSpace: "nowrap" }}>
                {st}
              </span>
            );
          })()}

          {/* 2026-10-08 — pending breakdown slips of this line; click = list */}
          {bdPend && (() => {
            const n = bdPend.count || 0;
            const late = (bdPend.slips || []).filter(s => s.locked).length;
            const c = n ? badClr : textMut;
            return (
              <button onClick={() => setBdOpen(true)}
                title={n ? `${n} breakdown slip(s) pending — click for the list` : "No breakdown slip pending"}
                style={{ fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 99,
                         cursor: "pointer", whiteSpace: "nowrap",
                         background: n ? `${badClr}18` : "transparent",
                         border: `1px solid ${n ? `${badClr}66` : border}`, color: c,
                         display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 9, opacity: .8, textTransform: "uppercase", letterSpacing: ".06em" }}>B/D Slips</span>
                <strong style={{ fontSize: 13 }}>{n}</strong>
                {late > 0 && <span style={{ fontSize: 9, fontWeight: 800 }}>🔒 {late}</span>}
              </button>
            );
          })()}

          {/* 2026-05-18-r14 — "MACHINE Final Inspection" pill removed
              per operator spec: "ye final inspection kha se aa gyi".
              The wallboard view shows ALL machines simultaneously, so
              labelling the HEADER with one specific machine name was
              misleading.  Final Inspection still tags its own chart
              row (the star ★ row at the top) — the header just shows
              line + shift + status + model now.                       */}

          {/* Model pill — muted grey w/ accent for model name */}
          {summary?.kpi?.current_model_name && (
            <span style={{ fontSize: 11, color: textSub,
                            display: "inline-flex", alignItems: "center", gap: 6,
                            padding: "3px 10px", borderRadius: 99,
                            background: D ? "#0a1322" : "#e2e8f0",
                            border: `1px solid ${border}`,
                            whiteSpace: "nowrap" }}>
              <span style={{ fontSize: 8, opacity: 0.7, color: textMut,
                              textTransform: "uppercase", letterSpacing: ".06em" }}>
                Model{summary?.kpi?.current_model_number != null
                  ? ` ${summary.kpi.current_model_number}` : ""}
              </span>
              <strong style={{ color: text }}>
                {String(summary.kpi.current_model_name).replace(/^TYPE-SERIES:\s*/i,"")}
              </strong>
            </span>
          )}

          {/* 2026-08-12 — jump to the MANAGEMENT view of this same line.  Mirror
              of the "Go to Supervisor" button on that screen, so the pair can be
              swapped from either side without editing the URL.  Sits after the
              MODEL pill so the identity of the line reads first and the action
              last.  Uses the line NAME (/Y17-SS/MANAGEMENT) to match the
              readable URL scheme. */}
          <button
            onClick={() => {
              const ref = String(summary?.kpi?.line_name || lineId || lineRef)
                            .trim().replace(/\s+/g, "-");
              window.location.assign(`/${encodeURIComponent(ref)}/MANAGEMENT`);
            }}
            title="Switch to the Management dashboard for this line"
            style={{ fontSize: 11, fontWeight: 800, padding: "3px 10px",
                     borderRadius: 99, cursor: "pointer",
                     background: "rgba(56,189,248,.10)",
                     border: "1px solid rgba(56,189,248,.45)",
                     color: "#38bdf8", whiteSpace: "nowrap",
                     display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 9, opacity: .7, textTransform: "uppercase" }}>Go to</span>
            <strong>Management</strong>
          </button>
        </div>

        {/* Right cluster — live indicator + clock + LIGHT/DARK + 9:16 + fullscreen */}
        <div style={{ display: "flex", alignItems: "center", gap: 8,
                      flexWrap: "wrap", rowGap: 4 }}>
          {/* Live indicator */}
          <div style={{ display: "flex", alignItems: "center", gap: 5,
                          padding: "3px 10px", borderRadius: 99,
                          background: `${okClr}10`,
                          border: `1px solid ${okClr}33` }}>
            <div style={{ width: 5, height: 5, borderRadius: "50%",
                            background: okClr,
                            animation: "wbPulse 2s infinite" }}/>
            <span style={{ fontSize: 11, fontWeight: 800, color: okClr }}>
              Live
            </span>
          </div>

          {/* Clock */}
          <span style={{ fontSize: 14, fontFamily: "monospace",
                          fontWeight: 700, color: text, letterSpacing: ".04em" }}>
            {/* 2026-09-14 — manual HH:MM:SS: toLocaleTimeString wrapped the time in
                invisible directional marks that showed as stray white dashes on
                the panel's WebView. */}
            {`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`}
          </span>

          {/* 2026-05-18-r13 — LIGHT/DARK toggle.  No actual theme
              refactor of the chart rows yet (they stay dark for
              operator-eye comfort on the 65" TV) — but the button is
              wired so a future swap is one localStorage flip away. */}
          <button onClick={() => {
                    const next = D ? "light" : "dark";
                    try { localStorage.setItem("wb_theme", next); } catch {}
                    // Reload to apply since theme constants are module-level.
                    window.location.reload();
                  }}
                  title={D ? "Switch to light theme" : "Switch to dark theme"}
                  style={{ padding: "4px 10px", border: `1px solid ${border}`,
                            background: card, color: textSub, borderRadius: 4,
                            cursor: "pointer", fontSize: 11, fontWeight: 700,
                            display: "inline-flex", alignItems: "center", gap: 4 }}>
            {D ? "☀ LIGHT" : "🌙 DARK"}
          </button>

          <button onClick={() => setOrientation(o => o === "portrait" ? "landscape" : "portrait")}
                  title="R = toggle orientation"
                  style={{ padding: "4px 10px", border: `1px solid ${border}`,
                           background: card, color: textSub, borderRadius: 4,
                           cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
            {isPortrait ? "9:16" : "16:9"}
          </button>
          <button onClick={toggleFS}
                  title="Fullscreen"
                  style={{ padding: "4px 10px", border: `1px solid ${border}`,
                           background: card, color: textSub, borderRadius: 4,
                           cursor: "pointer" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2.4"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9V5a2 2 0 0 1 2-2h4"/>
              <path d="M21 9V5a2 2 0 0 0-2-2h-4"/>
              <path d="M3 15v4a2 2 0 0 0 2 2h4"/>
              <path d="M21 15v4a2 2 0 0 1-2 2h-4"/>
            </svg>
          </button>
        </div>
      </div>
      {/* Live-indicator pulse keyframes (Wallboard scope). */}
      <style>{`@keyframes wbPulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }
        @keyframes wbShimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes wbFadeIn { from { opacity:0; } to { opacity:1; } }
        @keyframes wbSlide { 0% { transform: translateX(-115%); } 100% { transform: translateX(265%); } }
        @keyframes wbBreathe { 0%,100% { opacity:.45; transform:scale(.97); } 50% { opacity:1; transform:scale(1.03); } }
      `}</style>

      {/* Body: stacked CT rows.  Floating panel is positioned absolutely
          over this area so it doesn't shrink the chart width. */}
      <div style={{ flex: 1, position: "relative", padding: 8,
                    minHeight: 0, overflow: "hidden" }}>
        {/* CT rows — main line on top (taller), then sub-machines (equal share below) */}
        <div style={{ height: "100%", display: "flex", flexDirection: "column",
                      gap: 6 }}>
          {allRows.length === 0 && (
            <div style={{ flex: 1, display: "flex", alignItems: "center",
                          justifyContent: "center", color: textMut,
                          fontSize: 16 }}>
              No machines configured (or no cycles yet today)
            </div>
          )}
          {allRows.map((m) => (
            <div key={m.sub_id || "main"}
                  style={{
                    // Main line gets ~1.6x the height of each sub row so
                    // it visibly stands out as the line aggregate.
                    flex: m.is_main ? "1.6 1 0" : "1 1 0",
                    minHeight: 0,
                  }}>
              <MachineRow machine={m}
                          lossAll={lossBreakdown}
                          idealCt={m.ideal_ct || 15}
                          isMain={!!m.is_main}
                          chartReady={chartReady}
                          lineId={lineId}
                          okOverride={m.is_main ? summary?.kpi?.ok_count : undefined}
                          ngOverride={m.is_main ? summary?.kpi?.ng_count : undefined}
                          shiftName={shiftName}
                          onCycleVideo={openCycleVideo} />
            </div>
          ))}
        </div>

        {/* 2026-05-18-r5 — Hourly-panel rendering removed.  Operator spec:
            "CLICK TO HOURLY HTA DE AB VIDEO AAYEGI HR CYCLE KI".  Row-level
            clicks no longer open the per-machine slot panel; chart dots
            now own the click event and open the cycle-video popup instead.
            The HourlyPanel component is left defined above as dead code
            in case the slot view is wanted back later — easy to re-enable
            by restoring onPick / pickedMachine wiring. */}
      </div>

      {/* ── PER-CYCLE VIDEO POPUP ───────────────────────────────────
          Triggered by clicking any dot on any machine's CT chart.
          Streams from the line's /cycle-video proxy (main line) or
          /api/submachines/{id}/cycle-video (sub machines).

          2026-05-18-r7 — Portal'd to document.body to escape the
          rotated dashboard's transform-ancestor containing block.
          2026-05-19 — REVERTED r17.  Popup is now ALWAYS landscape
          (upright relative to the physical monitor).  overlayPosStyle
          is plain `position:fixed; inset:0`; combined with the Portal
          escape, the popup covers the natural viewport regardless of
          dashboard rotation state.                                 */}
      {videoCycle && createPortal((
        <div
          onClick={closeVideo}
          style={{
            ...overlayPosStyle,
            zIndex: 9999,
            background: "rgba(0,0,0,0.82)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
          }}
        >
          <div onClick={e => e.stopPropagation()}
               style={{
                 background: videoCycle.cy?.is_ng ? "#1a0a0d" : "#0a0f1a",
                 color: text,
                 border: videoCycle.cy?.is_ng
                   ? `3px solid #ef4444`
                   : `1px solid ${border}`,
                 borderRadius: 12,
                 padding: 14, maxWidth: 900, width: "90%",
                 maxHeight: "88vh",
                 display: "flex", flexDirection: "column",
                 boxShadow: videoCycle.cy?.is_ng
                   ? "0 24px 72px rgba(239,68,68,0.5)"
                   : "0 24px 72px rgba(0,0,0,0.6)",
               }}>
            {/* Header strip */}
            <div style={{ display:"flex", justifyContent:"space-between",
                          alignItems:"center", marginBottom: 10,
                          fontFamily:"'Barlow',sans-serif" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: text,
                            letterSpacing: ".02em" }}>
                <span style={{ color: videoCycle.isMain ? "#60a5fa" : "#fbbf24" }}>
                  {videoCycle.isMain ? "★ Final Inspection" : `M-${videoCycle.machine.machine_seq||"?"}`}
                </span>
                <span style={{ color: textMut, margin: "0 8px" }}>·</span>
                {videoCycle.machine.machine_name}
                <span style={{ color: textMut, margin: "0 8px" }}>·</span>
                Cycle #{videoCycle.cy._no ?? videoCycle.cy.cycle_seq}
                <span style={{ color: textMut, margin: "0 8px" }}>·</span>
                <span style={{
                  fontFamily:"monospace",
                  color: ctColor(videoCycle.cy.ct, videoCycle.machine.ideal_ct || idealCt),
                }}>
                  {Number(videoCycle.cy.ct).toFixed(2)}s
                </span>
                {videoCycle.cy.ts && (
                  <>
                    <span style={{ color: textMut, margin: "0 8px" }}>·</span>
                    <span style={{ fontSize: 11, color: textSub }}>
                      {new Date(videoCycle.cy.ts).toLocaleTimeString("en-GB")}
                    </span>
                  </>
                )}
              </div>
              <button onClick={closeVideo}
                      title="Close (Esc)"
                      style={{
                        background:"transparent", border:`1px solid ${border}`,
                        color: textSub, fontSize: 18, padding: "2px 12px",
                        borderRadius: 6, cursor:"pointer", fontWeight: 700,
                        lineHeight: 1,
                      }}>
                ×
              </button>
            </div>
            {/* Video element — `controls` for play/pause, auto-loads.
                If the server returns 404 / 401, the browser fires onError.

                2026-05-19 — Auto-retry on error.  Diagnosis from operator
                log: when the operator clicks a freshly-finished cycle dot,
                the cycle's MP4 is still being extracted by the recorder
                (10-20 s for long cycles).  The first /cycle-video proxy
                hit returns 404 because the MP4 isn't on disk yet, the
                browser fires `error`, and we'd show "No video available"
                forever even though the file would arrive a few seconds
                later.

                New behavior: on error, retry the load up to RETRY_MAX
                times at RETRY_DELAY_MS spacing (5 s × 4 = 20 s coverage,
                comfortably wider than any observed extraction).  Each
                retry uses a fresh cache-buster so the browser doesn't
                serve the cached 404 / partial response.  Only after the
                retry budget is exhausted do we show the inline error. */}
            {/* 2026-05-21 — Video loops continuously until operator
                explicitly closes the modal.  Custom big centered
                play/pause overlay button on top of native controls —
                operator on shop-floor with gloves can hit a 96 px
                target much easier than the native <30 px controls.
                Spec: "video chale to continue chale jb tk close na ho
                ... play button center me bda".
                2026-05-21-r2 — Operator added "timeline bar wapas
                laa + replay-from-beginning button".  Re-enabled
                `controls` for the native progress/scrubber bar at the
                bottom; added a custom ↺ Replay button (top-left of
                video) that resets currentTime=0 instantly without
                waiting for the natural loop boundary. */}
            <div style={{ position:"relative", width:"100%", lineHeight:0 }}>
            <video ref={vidRef} src={videoCycle.url}
                   muted
                   preload="auto"
                   autoPlay
                   controlsList="nodownload noremoteplayback"
                   data-retry="0"
                   data-started="0"
                   onLoadStart={(e) => _probeSrc(videoCycle.url, e.currentTarget)}
                   onLoadedMetadata={(e) => {
                   }}
                   onProgress={(e) => {
                     const v = e.currentTarget;
                     if (v.dataset.started === "1") return;
                     const dur = v.duration;
                     if (!dur || !isFinite(dur) || v.buffered.length === 0) return;
                     const bufEnd = v.buffered.end(v.buffered.length - 1);
                     // Only while the cover is up, and only on ≥2% moves:
                     // returning the SAME value makes React bail out of the
                     // re-render, so a downloading clip can't churn the whole
                     // wallboard (every chart) on each progress event.
                     if (vidLoading) {
                       const _nx = Math.min(1, bufEnd / dur);
                       setVidBuffered(p => (_nx > p + 0.01 || _nx >= VID_PLAY_AT ? _nx : p));
                     }
                     // No buffer gate any more — autoPlay above starts it.
                     // We still mark started so onWaiting can tell a genuine
                     // mid-clip re-buffer from the initial load.
                     if (!v.paused) v.dataset.started = "1";
                   }}
                   onCanPlay={(e) => {
                     const v = e.currentTarget;
                     if (v.dataset.started !== "1" && v.paused) v.play().catch(() => {});
                   }}
                   onCanPlayThrough={(e) => {
                     const v = e.currentTarget;
                     if (v.dataset.started === "1") return;
                     v.dataset.started = "1";
                     v.play().catch(() => {});
                   }}
                   onPlaying={(e) => {
                     e.currentTarget.dataset.started = "1";
                     setVidLoading(false); setVidStall(false);
                     if (vidTimerRef.current) {
                       // Elapsed time is taken now; only the source label waits
                       // for the probe (see api/timing.js).
                       vidTimerRef.current(vidSrcRef.current || {
                         source: e.currentTarget?.dataset?.clipSource || "render",
                       });
                       vidTimerRef.current = null;
                     }
                     vidWaitStart.current = 0;
                   }}
                   onWaiting={(e) => {
                     // Ran dry mid-clip.  The browser paints its round spinner
                     // here; flag it so our own strip covers that instead.
                     if (e.currentTarget.dataset.started === "1") setVidStall(true);
                   }}
                   onClick={(e) => {
                     // Tap on video toggles play/pause — same UX as the
                     // big centered button.
                     const v = e.currentTarget;
                     if (v.paused) v.play().catch(() => {});
                     else v.pause();
                   }}
                   style={{
                     width: "100%",
                     maxHeight: "70vh",
                     background: "#000",
                     borderRadius: 6,
                     border: `1px solid ${border}`,
                     cursor: "pointer",
                     display: "block",
                   }}
                   onError={(e) => {
                     const RETRY_DELAYS_MS = [300, 800, 1500, 3000, 6000];
                     const el = e.target;
                     const parent = el.parentNode;
                     if (!parent || el.dataset.closing === "1") return;
                     // Demo: a cycle with no clip answers 404 — show "No video" at once
                     // instead of walking the whole retry ladder (~12 s).
                     if (el.dataset.probed !== "1") {
                       el.dataset.probed = "1";
                       fetch(videoCycle.url, { headers: { Range: "bytes=0-0" } })
                         .then(r => {
                           try { if (r.body) r.body.cancel(); } catch { /* noop */ }
                           if (r.status === 404) el.dataset.retry = "99";
                           el.dispatchEvent(new Event("error"));
                         })
                         .catch(() => el.dispatchEvent(new Event("error")));
                       return;
                     }
                     const tries = parseInt(el.dataset.retry || "0", 10);
                     if (tries < RETRY_DELAYS_MS.length) {
                       el.dataset.retry = String(tries + 1);
                       // Fresh URL: replace the `r=` cache-buster so the
                       // browser doesn't reuse the cached failure response.
                       // ([^&]* also drops the "n" of an Alarm cycle's r=123n.)
                       const base = videoCycle.url.replace(/[&?]r=[^&]*/, "");
                       const sep  = base.includes("?") ? "&" : "?";
                       setTimeout(() => {
                         if (el.dataset.closing === "1" || !el.isConnected) return;
                         try {
                           el.src = base + sep + "r=" + Date.now();
                           el.load();
                           el.play().catch(() => {});
                         } catch { /* element may have been unmounted */ }
                       }, RETRY_DELAYS_MS[tries]);
                       return;
                     }
                     // Retry budget exhausted — show inline error.
                     setVidLoading(false);
                     el.style.display = "none";
                     if (parent.querySelector(".wb-video-err")) return;
                     const div = document.createElement("div");
                     div.className = "wb-video-err";
                     div.style.cssText = "padding:24px;color:#ef4444;font-size:13px;"
                       + "background:#1a0a0a;border:1px solid rgba(239,68,68,.4);"
                       + "border-radius:6px;font-family:'Barlow',sans-serif;";
                     div.textContent = "No video available for this cycle";
                     parent.appendChild(div);
                   }} />
            {/* always-visible progress + time (native strip fades out) */}
            <VideoProgressBar videoRef={vidRef} />
            {/* 2026-08-10 — Smooth "clip loading" cover.
                A cycle clip is rendered on demand server-side, so the first
                2-4 s show a black box with the browser's own round spinner —
                operator read that as a hang ("gol gol buffer acha nhi lg
                rha").  This covers it with a calm shimmer + film icon + a
                progress bar that goes determinate as soon as the media
                element reports buffered bytes.  pointerEvents:none so the
                ↺ button and tap-to-play underneath still work. */}
            {vidLoading && (
              <div style={{
                position:"absolute", inset:0, zIndex:5, borderRadius:6,
                display:"flex", flexDirection:"column",
                alignItems:"center", justifyContent:"center", gap:16,
                overflow:"hidden", pointerEvents:"none", lineHeight:1.4,
                background:"radial-gradient(ellipse at center, #161b23 0%, #05070a 100%)",
              }}>
                <div style={{ position:"absolute", inset:0, overflow:"hidden" }}>
                  <div style={{
                    position:"absolute", top:0, bottom:0, width:"55%",
                    background:"linear-gradient(90deg, transparent 0%, rgba(255,255,255,.055) 50%, transparent 100%)",
                    animation:"wbShimmer 1.7s ease-in-out infinite",
                  }}/>
                </div>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none"
                     stroke="#38bdf8" strokeWidth="1.5" strokeLinecap="round"
                     style={{ animation:"wbBreathe 1.9s ease-in-out infinite" }}>
                  <rect x="2" y="4" width="20" height="16" rx="2.5"/>
                  <path d="M7 4v16M17 4v16"/>
                  <path d="M2 9h5M2 15h5M17 9h5M17 15h5"/>
                </svg>
                <div style={{ fontFamily:"'Barlow',sans-serif", fontSize:12,
                              letterSpacing:1.6, textTransform:"uppercase",
                              fontWeight:600, color:"rgba(255,255,255,.7)" }}>
                  Loading cycle video · {vidWait.toFixed(1)}s{vidBuffered > 0 ? ` · ${Math.round(Math.min(1, vidBuffered / VID_PLAY_AT) * 100)}%` : ""}
                </div>
                <div style={{ width:"44%", maxWidth:300, height:4, borderRadius:99,
                              background:"rgba(255,255,255,.10)", overflow:"hidden" }}>
                  <div style={vidBuffered > 0
                    ? { height:"100%", width:`${Math.max(5, Math.min(1, vidBuffered / VID_PLAY_AT) * 100).toFixed(1)}%`,
                        borderRadius:99, background:"#38bdf8",
                        transition:"width .4s cubic-bezier(.4,0,.2,1)" }
                    : { height:"100%", width:"38%", borderRadius:99, background:"#38bdf8",
                        animation:"wbSlide 1.3s ease-in-out infinite" }}/>
                </div>
              </div>
            )}
            {/* 2026-08-10 — Mid-clip re-buffer.  Playback now starts at 20%
                so a slow moment can briefly run the buffer dry.  Keep the
                frame visible (translucent scrim, no icon) and just show a
                moving strip — enough to hide the browser's round spinner
                without the video "disappearing" mid-cycle.  Auto-clears on
                the next `playing` event; nothing to click. */}
            {vidStall && !vidLoading && (
              <div style={{
                position:"absolute", inset:0, zIndex:5, borderRadius:6,
                display:"flex", flexDirection:"column",
                alignItems:"center", justifyContent:"center", gap:12,
                overflow:"hidden", pointerEvents:"none",
                background:"rgba(5,7,10,.55)",
                animation:"wbFadeIn .25s ease-out both",
              }}>
                <div style={{ fontFamily:"'Barlow',sans-serif", fontSize:11,
                              letterSpacing:1.5, textTransform:"uppercase",
                              fontWeight:600, color:"rgba(255,255,255,.75)" }}>
                  Buffering
                </div>
                <div style={{ width:"32%", maxWidth:220, height:3, borderRadius:99,
                              background:"rgba(255,255,255,.12)", overflow:"hidden" }}>
                  <div style={{ height:"100%", width:"38%", borderRadius:99,
                                background:"#38bdf8",
                                animation:"wbSlide 1.1s ease-in-out infinite" }}/>
                </div>
              </div>
            )}
            {/* 2026-05-22 — Center big-play overlay removed per operator
                request.  Native controls bottom strip + ↺ replay top-left
                cover the play/pause/seek workflow. */}
            {/* 2026-05-21-r2 — Replay-from-start button.  Operator spec:
                "replay from beginning ka bhi button aana chahiye".
                Sits in the top-left corner of the video, 40 px circle.
                Always visible (unlike big-play which hides during
                playback) so operator can re-watch any cycle instantly
                without waiting for the natural loop boundary or
                dragging the native scrubber to 0. */}
            <button
              className="wb-replay"
              title="Replay from start"
              onClick={(e) => {
                e.stopPropagation();
                const v = e.currentTarget.parentNode?.querySelector("video");
                if (!v) return;
                try { v.currentTime = 0; } catch {}
                v.play().catch(() => {});
              }}
              style={{
                position:"absolute", top:12, left:12,
                width:44, height:44, borderRadius:"50%",
                border:"2px solid rgba(255,255,255,0.7)",
                background:"rgba(0,0,0,0.55)",
                color:"#fff", cursor:"pointer",
                display:"flex", alignItems:"center", justifyContent:"center",
                pointerEvents:"auto",
                backdropFilter:"blur(4px)",
                zIndex:6,
                transition:"opacity .2s, transform .15s",
                opacity:0.85,
              }}
              onMouseEnter={(e)=>{ e.currentTarget.style.opacity="1"; e.currentTarget.style.transform="scale(1.08)"; }}
              onMouseLeave={(e)=>{ e.currentTarget.style.opacity="0.85"; e.currentTarget.style.transform="scale(1)"; }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.4"
                   strokeLinecap="round" strokeLinejoin="round">
                {/* Circular replay arrow — counter-clockwise loop ending in arrowhead */}
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <polyline points="3 4 3 10 9 10" />
              </svg>
            </button>
            </div>
            {/* 2026-05-21 — Per-cycle Comments panel.
                Operator spec: "Final Inspection ka video khule to neeche
                comments tab ho jaha cycle-specific notes likhe ja sake".
                Renders ONLY for main-PLC cycles (isMain) — sub-machine
                slice viewers don't need this.  Keyed by part_code so
                opening the same cycle via part_code search later shows
                the same comment history. */}
            {videoCycle.isMain && (
              <CycleCommentsPanel
                lineId={lineId}
                machineName="Final Inspection"
                partCode={`cycle_${videoCycle.cy.cycle_seq}` + (videoCycle.cy.ts ? `_${new Date(videoCycle.cy.ts).toISOString().slice(0, 10)}` : "")}
                shift={videoCycle.cy.shift_name || shiftName}
                border={border}
                text={text}
                textSub={textSub}
                textMut={textMut}
              />
            )}
            {/* 2026-05-24 — Per-process NG remarks panel for ANY NG
                cycle (main OR sub).  Sub-machine cycles don't have a
                real part_code, so we synthesise one as
                M{machine_id}-{cycle_seq}-{YYYY-MM-DD} for keying.
                Operator spec: "ng part me video k niche remarks ka
                option de hr process pe". */}
            {/* 2026-06-05 — MAIN machine ka per-machine remark (ng-process-remarks)
                hata diya: Final / YNC-SS ke liye ab sirf upar wala CycleCommentsPanel
                (cycles/comments, part_code-keyed) jo dono views me sync hota hai.
                Yeh box ab sirf SUB machines ke liye (unka apna alag remark system). */}
            {!videoCycle.isMain && (() => {
              const realPC = videoCycle.cy.part_code;
              const machineId = videoCycle.machine.id
                              || videoCycle.machine.sub_id
                              || 0;
              const synthPC = realPC && String(realPC).trim()
                ? String(realPC).trim().replace(/:$/, "")
                : `M${machineId}-`
                  + `C${videoCycle.cy.cycle_seq}-`
                  + (videoCycle.cy.ts
                       ? new Date(videoCycle.cy.ts).toISOString().slice(0, 10)
                       : new Date().toISOString().slice(0, 10));
              return (
                <WbCycleRemarkPanel
                  lineId={lineId}
                  partCode={synthPC}
                  machineId={machineId}
                  machineName={videoCycle.machine.machine_name}
                  isNg={!!videoCycle.cy.is_ng}
                  border={border}
                  text={text}
                  textSub={textSub}
                  textMut={textMut}
                  bgDeep={bg}
                />
              );
            })()}
          </div>
        </div>
      ), document.body)}
    </div>
  );
}

// Normalise a comment to a grouping key (case/space/punct-insensitive).
function _normComment(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:!。]+$/g, "")
    .trim();
}

// Parse "cycle_<seq>_<YYYY-MM-DD>" → { seq, date } (main-cycle part_code).
function _parseCyclePc(pc) {
  const m = /^cycle_(\d+)_(\d{4}-\d{2}-\d{2})$/.exec(String(pc || "").trim());
  return m ? { seq: parseInt(m[1], 10), date: m[2] } : null;
}

// Module-level history cache (shared by both panels) — 5-min TTL so a
// supervisor flicking through many cycles fetches the corpus once.
const _suggHistCache = {};   // `${lineId}|${source}` -> { ts, rows }

async function _fetchCommentHistory(lineId, source) {
  const key = `${lineId}|${source}`;
  const now = Date.now();
  const hit = _suggHistCache[key];
  if (hit && (now - hit.ts) < 5 * 60 * 1000) return hit.rows;
  const from = new Date(now - 120 * 864e5).toISOString().slice(0, 10);
  const to   = new Date(now).toISOString().slice(0, 10);
  const wantType = source === "ng_remark" ? "NG-Remark" : "Comment";
  try {
    const r = await fetch(
      `/api/lines/${lineId}/comments-history?date_from=${from}&date_to=${to}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const rows = (Array.isArray(d.rows) ? d.rows : [])
      .filter(x => x.type === wantType && x.text && x.text.trim());
    _suggHistCache[key] = { ts: now, rows };
    return rows;
  } catch {
    return hit ? hit.rows : [];   // stale-on-error, else empty
  }
}

// median intra-date consecutive seq-gap = a reason's recurrence period.
function _medianPeriod(arr) {
  const byDate = new Map();
  for (const o of arr) {
    let g = byDate.get(o.date); if (!g) { g = []; byDate.set(o.date, g); }
    g.push(o.seq);
  }
  const gaps = [];
  for (const g of byDate.values()) {
    g.sort((a, b) => a - b);
    for (let i = 1; i < g.length; i++) { const d = g[i] - g[i - 1]; if (d > 0 && d <= 60) gaps.push(d); }
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

// Build a ranked suggestion list for the cycle described by `partCode`.
function _rankSuggestions(rows, partCode, machineId) {
  if (!rows || !rows.length) return [];
  const freq = new Map();   // key -> { count, forms: Map(orig->n) }
  const occ  = new Map();   // key -> [ {date, seq} ]  (for periodicity)
  for (const r of rows) {
    const key = _normComment(r.text);
    if (!key) continue;
    let e = freq.get(key);
    if (!e) { e = { count: 0, forms: new Map() }; freq.set(key, e); }
    const w = (machineId && r.machine_id && r.machine_id !== machineId) ? 0.4 : 1;
    e.count += w;
    const orig = r.text.trim();
    e.forms.set(orig, (e.forms.get(orig) || 0) + 1);
    const cyc = _parseCyclePc(r.part_code);
    if (cyc) { let a = occ.get(key); if (!a) { a = []; occ.set(key, a); } a.push(cyc); }
  }
  const cur = _parseCyclePc(partCode);
  // reason of the immediately-preceding commented cycle (same date) → run boost
  let prevKey = null, prevBest = -1;
  if (cur) {
    for (const [key, arr] of occ) {
      for (const o of arr) {
        if (o.date === cur.date && o.seq < cur.seq && o.seq > prevBest) { prevBest = o.seq; prevKey = key; }
      }
    }
  }
  const out = [];
  for (const [key, e] of freq) {
    let disp = key, dn = -1;
    for (const [orig, n] of e.forms) if (n > dn) { dn = n; disp = orig; }
    let score = Math.log(1 + e.count);          // frequency prior (diminishing)
    if (cur) {
      const arr = occ.get(key) || [];
      let lastSeq = -1;
      for (const o of arr) if (o.date === cur.date && o.seq < cur.seq && o.seq > lastSeq) lastSeq = o.seq;
      const P = _medianPeriod(arr);
      if (P && lastSeq >= 0) {
        const since = cur.seq - lastSeq;
        const phase = since % P;
        if (since >= P) score += 1.2;                                   // overdue
        if (phase === 0 || phase === P - 1 || (phase === 1 && P > 2)) score += 1.0;  // on-phase
      } else if (P && lastSeq < 0) {
        score += 0.3;                            // periodic reason not yet fired this shift
      }
      if (key === prevKey) score += 0.8;         // sticky run continuation
    }
    out.push({ text: disp, key, score, count: e.count });
  }
  out.sort((a, b) => b.score - a.score || b.count - a.count);
  const seen = new Set(), top = [];
  for (const o of out) { if (seen.has(o.key)) continue; seen.add(o.key); top.push(o.text); if (top.length >= 6) break; }
  return top;
}

// Hook: ranked suggestion strings for the given cycle (re-ranks per cycle).
function useCycleSuggest({ lineId, source, machineId, partCode }) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let dead = false;
    _fetchCommentHistory(lineId, source).then(r => { if (!dead) setRows(r); });
    return () => { dead = true; };
  }, [lineId, source]);
  return useMemo(() => _rankSuggestions(rows, partCode, machineId),
                 [rows, partCode, machineId]);
}

// GhostTextarea — a <textarea> with inline ghost-text autocomplete.
// The top suggestion that prefix-matches the typed text is shown greyed
// behind the caret; TAB accepts it (just like shell / IDE autofill).  A
// backdrop "mirror" div renders the ghost aligned exactly under the real
// text so it lines up at any caret position.
function GhostTextarea({
  value, onChange, onKeyDown, suggestions = [],
  innerRef, style = {}, ghostColor = "rgba(255,255,255,0.34)",
  placeholder, ...rest
}) {
  const v = value == null ? "" : String(value);
  const ghost = "";
  const _UNUSED_SUGGESTIONS = suggestions;   // still taken out of ...rest so it never reaches the <textarea>
  const ghostSuffix = ghost ? (v.trim() === "" ? ghost : ghost.slice(v.length)) : "";
  const emptyGhost  = ghostSuffix && v.trim() === "";

  const accept = () => {
    if (!ghost) return;
    onChange && onChange({ target: { value: ghost } });
    const el = innerRef && innerRef.current;
    if (el) requestAnimationFrame(() => {
      try { el.selectionStart = el.selectionEnd = ghost.length; } catch {}
    });
  };

  const mirror = {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    padding: style.padding, border: "1px solid transparent",
    borderRadius: style.borderRadius,
    fontSize: style.fontSize, fontFamily: style.fontFamily,
    lineHeight: "1.45", whiteSpace: "pre-wrap", wordBreak: "break-word",
    overflow: "hidden", boxSizing: "border-box",
    background: style.background, color: "transparent", pointerEvents: "none",
  };
  return (
    <div style={{ position: "relative", flex: style.flex != null ? style.flex : 1,
                  display: "flex", minWidth: 0 }}>
      <div aria-hidden="true" style={mirror}>
        <span style={{ visibility: "hidden" }}>{v}</span>
        <span style={{ color: ghostColor }}>{ghostSuffix}</span>
      </div>
      <textarea
        ref={innerRef}
        value={value}
        onChange={onChange}
        placeholder={emptyGhost ? "" : placeholder}
        onKeyDown={(e) => {
          if (e.key === "Tab" && !e.shiftKey && ghostSuffix) { e.preventDefault(); accept(); return; }
          onKeyDown && onKeyDown(e);
        }}
        style={{ ...style, flex: 1, width: "100%", lineHeight: "1.45",
                 background: "transparent", position: "relative", zIndex: 1 }}
        {...rest}
      />
    </div>
  );
}

function SuggestChips({ suggestions = [], current = "", onPick, border, color }) {
  const list = (suggestions || []).filter(s => s && s.trim() !== (current || "").trim()).slice(0, 3);
  if (!list.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6, alignItems: "center" }}>
      <span style={{ fontSize: 10, color, opacity: 0.7, marginRight: 2 }}>⇥ Tab / pick:</span>
      {list.map((s, i) => (
        <button key={i} type="button" onClick={() => onPick && onPick(s)}
          title="Fill this comment"
          style={{
            fontSize: 11, padding: "3px 10px", borderRadius: 999,
            border: `1px solid ${border}`, background: "rgba(255,255,255,0.05)",
            color, cursor: "pointer", maxWidth: 260, whiteSpace: "nowrap",
            overflow: "hidden", textOverflow: "ellipsis", lineHeight: 1.3,
          }}>
          {s}
        </button>
      ))}
    </div>
  );
}

function MicDictateButton({ value = "", onChange, size = 34 }) {
  const [listening, setListening] = useState(false);
  const [err, setErr] = useState("");
  const recRef   = useRef(null);
  const baseRef  = useRef("");     // draft text captured when the mic turned on
  const finalRef = useRef("");     // transcript finalised so far this session
  const wantRef  = useRef(false);  // user wants it recording (survives auto-ends)
  const SR = (typeof window !== "undefined") &&
             (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) return null; // unsupported → hide the button entirely

  // Full field value = pre-mic text + everything spoken this session (+ live interim).
  const compose = (interim) => {
    const base   = (baseRef.current || "").trim();
    const spoken = (finalRef.current + interim).replace(/\s+/g, " ").trim();
    if (!spoken) return baseRef.current || "";
    return base ? base + " " + spoken : spoken;
  };

  const stop = () => {
    wantRef.current = false;
    try { recRef.current && recRef.current.stop(); } catch {}
    setListening(false);
  };

  const start = () => {
    setErr("");
    if (typeof window !== "undefined" && window.isSecureContext === false) {
      setErr("Mic needs HTTPS — open the app at mes.tbdi.in (or via localhost)");
      return;
    }
    let rec;
    try { rec = new SR(); } catch { return; }
    recRef.current = rec;
    rec.lang = "en-IN";
    rec.interimResults = true;     // ← write text live while speaking
    rec.continuous = true;         // ← keep listening until turned off
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalRef.current += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      if (typeof onChange === "function") onChange(compose(interim));
    };
    rec.onerror = (e) => {
      const code = e && e.error;
      if (code === "not-allowed" || code === "service-not-allowed") {
        wantRef.current = false;
        setErr("Mic blocked — allow microphone permission");
      } else if (code === "no-speech" || code === "aborted" || code === "network") {
        /* transient — onend will restart if the user still wants it on */
      } else {
        setErr("Voice input unavailable");
      }
    };
    rec.onend = () => {
      // Continuous recognition still auto-ends on a pause in the WebView; if the
      // user hasn't pressed stop, restart it so dictation keeps flowing.
      if (wantRef.current) {
        try { rec.start(); return; } catch {}
        try { start(); return; } catch {}
      }
      setListening(false);
    };
    try { rec.start(); setListening(true); }
    catch { wantRef.current = false; setListening(false); }
  };

  const toggle = () => {
    if (listening || wantRef.current) { stop(); return; }
    baseRef.current  = value || "";   // snapshot what's already typed
    finalRef.current = "";
    wantRef.current  = true;
    start();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
      <button type="button" onClick={toggle}
        title={listening ? "Stop recording" : "Speak your comment"}
        aria-label="Dictate comment by voice"
        style={{
          width: size, height: size, padding: 0, fontSize: 15, lineHeight: 1,
          background: listening ? "#dc2626" : "rgba(255,255,255,0.06)",
          color: "#fff",
          border: `1px solid ${listening ? "#dc2626" : "rgba(255,255,255,0.18)"}`,
          borderRadius: 6, cursor: "pointer", flexShrink: 0,
        }}>
        {listening ? "■" : "🎤"}
      </button>
      {err && (
        <div style={{ fontSize: 8.5, color: "#f87171", maxWidth: size + 30,
                      textAlign: "center", lineHeight: 1.1, marginTop: 2 }}>{err}</div>
      )}
    </div>
  );
}

function WbCycleRemarkPanel({
  lineId, partCode, machineId, machineName, isNg,
  border, text, textSub, textMut, bgDeep,
}) {
  const [existing, setExisting] = useState(null);
  const [draft,    setDraft]    = useState("");
  const [saving,   setSaving]   = useState(false);
  const [savedAt,  setSavedAt]  = useState(0);
  const [error,    setError]    = useState("");
  const token = (typeof window !== "undefined"
                   && sessionStorage.getItem("mes_token")) || "";
  const taRef = useRef(null);

  const suggestions = useCycleSuggest({ lineId, source: "ng_remark", machineId, partCode });

  useEffect(() => {
    const t = setTimeout(() => {
      try { taRef.current?.focus({ preventScroll: true }); } catch {}
    }, 90);
    return () => clearTimeout(t);
  }, [partCode]);

  const load = useCallback(() => {
    if (!machineId) return;
    setError("");
    fetch(`/api/lines/${lineId}/ng-process-remarks/${encodeURIComponent(partCode)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(d => {
        const mine = (d.remarks || []).find(r => r.machine_id === machineId);
        setExisting(mine || null);
        setDraft(mine ? mine.remark_text : "");
      })
      .catch(e => setError(String(e)));
  }, [lineId, partCode, machineId]);

  useEffect(() => { load(); }, [load]);

  const save = () => {
    const txt = draft.trim();
    if (!txt || !machineId) return;
    setSaving(true);
    fetch(`/api/lines/${lineId}/ng-process-remarks/${encodeURIComponent(partCode)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        machine_id:   machineId,
        machine_name: machineName,
        remark_text:  txt,
      }),
    })
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(() => { setSavedAt(Date.now()); load(); })
      .catch(e => setError(String(e)))
      .finally(() => setSaving(false));
  };

  const accent      = isNg ? "#ef4444" : "#3b82f6";
  const accentBg    = isNg ? "rgba(239,68,68,0.08)" : "rgba(59,130,246,0.06)";
  const accentBd    = isNg ? "rgba(239,68,68,0.55)" : "rgba(59,130,246,0.35)";
  const recentlySaved = (Date.now() - savedAt) < 2500;

  return (
    <div style={{
      marginTop: 10, padding: 12, background: accentBg,
      border: `1.5px solid ${accentBd}`, borderRadius: 8,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginBottom: 8, fontSize: 11, fontWeight: 800,
        color: accent, letterSpacing: ".08em",
      }}>
        <span>{isNg ? "⚠ Alarm" : "📝 OK"} CYCLE REMARK · {machineName}</span>
        <span style={{ color: textMut, fontWeight: 600 }}>
          {existing && existing.updated_at
            ? "last: " + new Date(existing.updated_at).toLocaleString("en-IN")
            : "no remark yet"}
        </span>
      </div>
      {error && (
        <div style={{ color: "#f87171", fontSize: 11, marginBottom: 6 }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <GhostTextarea
          innerRef={taRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          suggestions={suggestions}
          placeholder={isNg
            ? `Why did this part raise an Alarm at ${machineName}?  (e.g., "jig wear caused misalign", "operator missed torque")`
            : `Any note about this OK cycle at ${machineName}?  (optional — usually leave blank)`}
          rows={3}
          style={{
            flex: 1, padding: 8, borderRadius: 6,
            border: `1px solid ${isNg ? "rgba(239,68,68,0.5)" : border}`,
            background: "rgba(0,0,0,0.35)",
            color: "#ffffff",
            fontSize: 13, resize: "vertical", fontFamily: "inherit",
            caretColor: "#ffffff",
          }}
        />
        <MicDictateButton value={draft} onChange={setDraft} />
        <button
          onClick={save}
          disabled={saving || !draft.trim()}
          style={{
            padding: "0 18px", borderRadius: 6,
            border: "none", cursor: "pointer",
            background: saving ? "#6b7280"
                        : recentlySaved ? "#16a34a"
                        : accent,
            color: "#fff", fontSize: 12, fontWeight: 800,
            minWidth: 80, alignSelf: "stretch",
          }}
        >
          {saving ? "..." : recentlySaved ? "✓ saved" : "SAVE"}
        </button>
      </div>
      <SuggestChips suggestions={suggestions} current={draft}
        onPick={(s) => { setDraft(s); try { taRef.current?.focus(); } catch {} }}
        border={accentBd} color={textMut} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// CycleCommentsPanel
// Per-cycle notes/comments panel.  Mounts inside the video modal,
// fetches existing comments on open, allows authenticated users to
// post new ones.  Keyed by (lineId, partCode) so the same thread
// appears whether the user navigated via chart-dot click or via the
// part_code search.  Append-only — typo correction = post a new
// comment (matches the breakdown closure-notes pattern).
// ─────────────────────────────────────────────────────────────────
function CycleCommentsPanel({ lineId, partCode, machineName, border, text, textSub, textMut, shift }) {
  const [items, setItems]     = useState([]);
  const [draft, setDraft]     = useState("");
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError]     = useState("");
  const token = (typeof window !== "undefined"
                   && sessionStorage.getItem("mes_token")) || "";
  const taRef = useRef(null);
  const [leaderOpts, setLeaderOpts] = useState([]);
  const [leaderName, setLeaderName] = useState("");

  //  Default = the leader the shift-incharge assigned to this line for the
  //  CYCLE's own date+shift; options = the line's leaders (all leaders if the
  //  line has none mapped), so it can be re-attributed per comment.
  useEffect(() => {
    if (!lineId) { setLeaderOpts([]); setLeaderName(""); return; }
    const cDate = (String(partCode || "").match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || "";
    const qs = new URLSearchParams({ line_id: String(lineId) });
    if (cDate) qs.set("date", cDate);
    if (shift) qs.set("shift", shift);
    fetch(`/api/leaders/for-line?${qs.toString()}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => {
        setLeaderOpts(Array.isArray(d.options) ? d.options : []);
        setLeaderName(d.default || "");
      })
      .catch(() => { setLeaderOpts([]); setLeaderName(""); });
  }, [lineId, partCode, shift, token]);

  const suggestions = useCycleSuggest({ lineId, source: "cycle", partCode });

  useEffect(() => {
    const t = setTimeout(() => {
      try { taRef.current?.focus({ preventScroll: true }); } catch {}
    }, 90);
    return () => clearTimeout(t);
  }, [partCode]);

  // Fetch on mount + when part_code changes (different cycle clicked)
  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError("");
    // Scope to THIS cycle's shift — cycle numbers restart every shift, so
    // A-shift #10 and B-shift #10 of the same day must not share notes.
    const _q = shift ? `?shift=${encodeURIComponent(shift)}` : "";
    fetch(`/api/lines/${lineId}/cycles/${encodeURIComponent(partCode)}/comments${_q}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => { if (!stopped) setItems(Array.isArray(d.comments) ? d.comments : []); })
      .catch(e => { if (!stopped) setError(String(e)); })
      .finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [lineId, partCode, shift, token]);

  const submit = useCallback(async () => {
    const txt = draft.trim();
    if (!txt) return;
    if (!token) {
      setError("Login required to post comments");
      return;
    }
    setPosting(true); setError("");
    try {
      const r = await fetch(
        `/api/lines/${lineId}/cycles/${encodeURIComponent(partCode)}/comments`,
        {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${token}`,
          },
          // Stamp the CYCLE's own shift + date (date parsed from the part_code
          // `cycle_<seq>_<YYYY-MM-DD>`), not the wall clock.
          body: JSON.stringify({ comment: txt, machine_name: machineName,
                                 leader_name: leaderName || null,
                                 shift: shift || null,
                                 record_date: (String(partCode || "").match(/_(\d{4}-\d{2}-\d{2})$/) || [])[1] || null }),
        }
      );
      if (!r.ok) {
        const msg = await r.text().catch(() => `HTTP ${r.status}`);
        throw new Error(msg.slice(0, 200));
      }
      const row = await r.json();
      setItems(prev => [...prev, {
        id:          row.id,
        comment:     row.comment,
        author:      row.author,
        leader_name: row.leader_name,
        created_at:  row.created_at,
      }]);
      setDraft("");
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setPosting(false);
    }
  }, [lineId, partCode, draft, token, leaderName, machineName, shift]);

  // Auto-grow textarea heightless on small content
  return (
    <div style={{
      marginTop: 12, padding: 12,
      background: "rgba(255,255,255,0.02)",
      border: `1px solid ${border}`, borderRadius: 8,
      fontFamily: "'Barlow',sans-serif",
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, letterSpacing: ".08em",
        color: textSub, textTransform: "uppercase", marginBottom: 8,
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <span>Comments</span>
        <span style={{ color: textMut, fontSize: 10, fontWeight: 600 }}>
          part {partCode}
        </span>
      </div>

      {/* Existing comments list */}
      {loading ? (
        <div style={{ color: textMut, fontSize: 12, padding: "6px 0" }}>
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div style={{ color: textMut, fontSize: 12, fontStyle: "italic",
                       padding: "6px 0" }}>
          No comments yet for this cycle.
        </div>
      ) : (
        <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
          {items.map(c => (
            <div key={c.id} style={{
              padding: "6px 0",
              borderTop: `1px dashed ${border}`,
            }}>
              <div style={{ fontSize: 11, color: textMut, marginBottom: 2 }}>
                <span style={{ color: "#60a5fa", fontWeight: 700 }}>
                  {c.author || "operator"}
                </span>
                <span style={{ margin: "0 6px" }}>·</span>
                {c.created_at ? new Date(c.created_at).toLocaleString("en-GB", {
                  day: "2-digit", month: "short",
                  hour: "2-digit", minute: "2-digit",
                }) : ""}
                {c.leader_name ? (
                  <><span style={{ margin: "0 6px" }}>·</span>
                    Leader: <b style={{ color: "#a5b4fc" }}>{c.leader_name}</b></>
                ) : null}
              </div>
              <div style={{ fontSize: 13, color: text, whiteSpace: "pre-wrap",
                             wordBreak: "break-word" }}>
                {c.comment}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Leader attribution — default = the line's shift-assigned leader
          (set pre-shift by the shift incharge); overridable per comment. */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center",
                    gap: 6, marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em",
                       color: textMut, textTransform: "uppercase" }}>Leader</span>
        <select value={leaderName} onChange={e => setLeaderName(e.target.value)}
          title="Line leader this remark is attributed to"
          style={{ padding: "4px 8px", fontSize: 12, background: "#ffffff",
                   color: "#0f172a", border: `1px solid ${border}`, borderRadius: 6,
                   maxWidth: 200 }}>
          <option value="">— select leader —</option>
          {leaderName && !leaderOpts.some(o => o.username === leaderName) && (
            <option value={leaderName}>{leaderName}</option>
          )}
          {leaderOpts.map(o => (
            <option key={o.id} value={o.username}>{o.username}</option>
          ))}
        </select>
      </div>

      {/* Compose */}
      <div style={{ display: "flex", gap: 6 }}>
        <GhostTextarea
          innerRef={taRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          suggestions={suggestions}
          placeholder="Add a comment about this cycle…"
          rows={2}
          maxLength={2000}
          ghostColor="rgba(255,255,255,0.28)"
          style={{
            flex: 1, padding: "6px 8px", fontSize: 13,
            background: "rgba(255,255,255,0.04)",
            color: text, border: `1px solid ${border}`,
            borderRadius: 6, resize: "vertical",
            fontFamily: "'Barlow',sans-serif",
          }}
          onKeyDown={e => {
            // Ctrl/Cmd+Enter to submit — common UX
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <MicDictateButton value={draft} onChange={setDraft} />
        <button
          onClick={submit}
          disabled={posting || !draft.trim()}
          style={{
            padding: "0 14px", fontSize: 12, fontWeight: 700,
            background: (posting || !draft.trim()) ? "rgba(96,165,250,.3)" : "#2563eb",
            color: "#fff", border: "none", borderRadius: 6,
            cursor: (posting || !draft.trim()) ? "not-allowed" : "pointer",
            letterSpacing: ".04em",
          }}>
          {posting ? "…" : "POST"}
        </button>
      </div>
      <SuggestChips suggestions={suggestions} current={draft}
        onPick={(s) => { setDraft(s); try { taRef.current?.focus(); } catch {} }}
        border={border} color={textMut} />
      {error && (
        <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444" }}>
          {error}
        </div>
      )}
    </div>
  );
}
