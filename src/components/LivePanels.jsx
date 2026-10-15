// LivePanels.jsx — live camera preview + PLC collector data for the demo machine.
//
// Used by the Camera page, the Machine Config page ("④ Collector Data") and the
// MANAGEMENT-2 dashboard (top-bar buttons → popup).  Both read the demo server:
//   GET /api/demo/collector          PLC connection, raw signals, registers, inputs,
//                                    this shift's counts, last cycles, camera status
//   GET /api/demo/camera/live.mjpg   live picture (multipart JPEG, ~5 fps)
//   GET /api/lines/99/cycle-video    a recorded cycle clip (99 = the live line)
//   POST /api/demo/run-demo          {cycles} start / {stop:true} stop the demo PLC run
import { useEffect, useRef, useState } from "react";

const COLLECTOR_URL = "/api/demo/collector";
const LIVE_URL = "/api/demo/camera/live.mjpg";
export const LIVE_LINE_ID = 99;
export const clipUrl = (seq) => `/api/lines/${LIVE_LINE_ID}/cycle-video?cycle_seq=${seq}`;

const STATUS_CLR = {
  RUNNING: "#16a34a", IDLE: "#94a3b8", BREAKDOWN: "#dc2626", QUALITY_ISSUE: "#f97316",
  MODEL_SETUP: "#3b82f6", MATERIAL_WAIT: "#eab308", OTHER_LOSS: "#a855f7", CHANGE_OVER: "#06b6d4",
  BREAK: "#38bdf8", "PLC OFFLINE": "#64748b",
};

function palette(dark) {
  return dark
    ? { card: "#0a0f1a", deep: "#070c14", border: "#1e293b", text: "#e8edf5", sub: "#94a3b8", mut: "#64748b",
        okBg: "rgba(34,197,94,.12)", ngBg: "rgba(239,68,68,.12)", rowAlt: "rgba(255,255,255,.02)" }
    : { card: "#ffffff", deep: "#f8fafc", border: "#e2e8f0", text: "#0f172a", sub: "#64748b", mut: "#94a3b8",
        okBg: "rgba(22,163,74,.08)", ngBg: "rgba(220,38,38,.08)", rowAlt: "#fbfdff" };
}

// Poll /api/demo/collector while mounted.
export function useCollector(intervalMs = 1000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true, timer = null;
    const tick = async () => {
      try {
        const r = await fetch(COLLECTOR_URL, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) { setData(j); setError(null); }
      } catch (e) {
        if (alive) setError(e.message === "Failed to fetch" ? "Demo server not reachable" : e.message);
      } finally {
        if (alive) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [intervalMs]);
  return { data, error };
}

function Chip({ label, color, bg, title }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 99,
      fontSize: 11, fontWeight: 700, color, background: bg || `${color}1a`, border: `1px solid ${color}40`, whiteSpace: "nowrap" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {label}
    </span>
  );
}

function Lamp({ on, color = "#16a34a", size = 12 }) {
  return (
    <span aria-label={on ? "ON" : "OFF"} style={{ display: "inline-block", width: size, height: size, borderRadius: "50%",
      background: on ? color : "transparent", border: `2px solid ${on ? color : "#94a3b8"}`,
      boxShadow: on ? `0 0 8px ${color}99` : "none", flexShrink: 0 }} />
  );
}

const fmtTime = (iso) => (iso ? String(iso).slice(11, 19) : "—");

// "0.1 s" → (raw * 0.1).toFixed(1) + " s"; anything else → raw value.
function scaled(raw, unit) {
  if (raw == null) return "—";
  const m = /^\s*(0\.0*1)\s*(.*)$/.exec(String(unit || ""));
  if (!m) return String(raw);
  const f = parseFloat(m[1]);
  const dec = m[1].split(".")[1].length;
  return `${(raw * f).toFixed(dec)}${m[2] ? ` ${m[2]}` : ""}`;
}

const PLC_STATE = {
  connected:      { label: "Connected",      color: "#16a34a" },
  connecting:     { label: "Connecting…",    color: "#d97706" },
  starting:       { label: "Starting…",      color: "#d97706" },
  error:          { label: "Not connected",  color: "#dc2626" },
  not_configured: { label: "PLC IP not set", color: "#d97706" },
};
const CAM_STATE = {
  streaming:      { label: "Live",                color: "#16a34a" },
  connecting:     { label: "Connecting…",         color: "#d97706" },
  starting:       { label: "Starting…",           color: "#d97706" },
  idle:           { label: "Idle",                color: "#94a3b8" },
  error:          { label: "Not connected",       color: "#dc2626" },
  not_configured: { label: "Camera IP not set",   color: "#d97706" },
  no_ffmpeg:      { label: "Snapshot mode",       color: "#d97706" },
};

// ─── Camera live preview ──────────────────────────────────────
export function CameraLive({ dark = false }) {
  const c = palette(dark);
  const { data } = useCollector(1500);
  const cam = data?.camera;
  const [nonce, setNonce] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef(null);
  // Start the never-ending MJPEG request only after the page has loaded, so it doesn't keep
  // the browser's page load (tab spinner) pending while the camera is down.
  const [pageReady, setPageReady] = useState(() => document.readyState === "complete");
  useEffect(() => {
    if (pageReady) return undefined;
    const on = () => setPageReady(true);
    window.addEventListener("load", on);
    return () => window.removeEventListener("load", on);
  }, [pageReady]);

  // Drop the stream when the preview closes so the browser frees the connection.
  useEffect(() => {
    const img = imgRef.current;
    return () => { if (img) img.src = ""; };
  }, [nonce, pageReady]);

  const st = CAM_STATE[cam?.state] || { label: cam?.state || "…", color: "#94a3b8" };
  const stale = cam && (cam.last_frame_age_s == null || cam.last_frame_age_s > 5);
  const showPicture = loaded && !stale;

  return (
    <div>
      <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", background: "#0f172a", borderRadius: 10, overflow: "hidden", border: `1px solid ${c.border}` }}>
        {pageReady && (
          <img ref={imgRef} key={nonce} src={`${LIVE_URL}?t=${nonce}`} alt="Live camera"
            onLoad={() => setLoaded(true)} onError={() => setLoaded(false)}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", display: "block",
                     opacity: showPicture ? 1 : 0.25 }} />
        )}
        {showPicture ? (
          <span style={{ position: "absolute", top: 10, left: 10, padding: "3px 9px", borderRadius: 6, background: "rgba(220,38,38,.9)",
                         color: "#fff", fontSize: 11, fontWeight: 800, letterSpacing: ".08em" }}>● LIVE</span>
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                        gap: 6, color: "#cbd5e1", textAlign: "center", padding: 16 }}>
            <div style={{ fontSize: 30, opacity: .5 }}>📷</div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {cam?.state === "not_configured" ? "Camera IP is not set" : cam ? "Waiting for the camera…" : "Loading…"}
            </div>
            {cam?.last_error && <div style={{ fontSize: 11, color: "#94a3b8", maxWidth: 520, wordBreak: "break-word" }}>{cam.last_error}</div>}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
        <Chip label={st.label} color={st.color} />
        {cam && <Chip label={cam.recording ? "Recording ON" : "Recording OFF"} color={cam.recording ? "#16a34a" : "#94a3b8"} />}
        {cam && cam.ip && <span style={{ fontSize: 11, color: c.sub, fontFamily: "monospace" }}>{cam.rtsp_url}</span>}
        <button type="button" onClick={() => { setLoaded(false); setNonce(Date.now()); }}
          style={{ marginLeft: "auto", padding: "4px 12px", borderRadius: 7, border: `1px solid ${c.border}`, background: c.deep,
                   color: c.text, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
          ↻ Reconnect
        </button>
      </div>
      {cam && !cam.ffmpeg && (
        <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 11, lineHeight: 1.6, color: "#92400e",
                      background: "rgba(217,119,6,.1)", border: "1px solid rgba(217,119,6,.3)" }}>
          <b>ffmpeg not found on the server PC.</b> The preview uses camera snapshots and cycle clips are not recorded.
          Install it (<code>winget install Gyan.FFmpeg</code>) and restart the server.
        </div>
      )}
      {cam && cam.recording && (
        <div style={{ marginTop: 8, fontSize: 11, color: c.sub }}>
          Cycle clips saved: <b style={{ color: c.text }}>{cam.clips_cut}</b>
          {cam.clips_failed > 0 && <> · failed: <b style={{ color: "#dc2626" }}>{cam.clips_failed}</b></>}
          {cam.last_clip_error && <span style={{ color: "#dc2626" }}> · {cam.last_clip_error}</span>}
        </div>
      )}
    </div>
  );
}

// ─── Collector data ───────────────────────────────────────────
export function CollectorLive({ dark = false }) {
  const c = palette(dark);
  const { data, error } = useCollector(1000);
  const [playSeq, setPlaySeq] = useState(null);
  const [demoN, setDemoN] = useState(30);
  const [demoMsg, setDemoMsg] = useState(null);

  const card = { background: c.card, border: `1px solid ${c.border}`, borderRadius: 12, padding: 16, minWidth: 0 };
  const head = { fontSize: 11, fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", color: c.sub, margin: "0 0 10px" };
  const th = { padding: "7px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase",
               color: c.mut, borderBottom: `1px solid ${c.border}`, whiteSpace: "nowrap" };
  const td = { padding: "7px 10px", fontSize: 12, color: c.text, borderBottom: `1px solid ${c.border}`, whiteSpace: "nowrap" };

  if (!data) {
    return <div style={{ ...card, color: error ? "#dc2626" : c.sub, fontSize: 13 }}>{error || "Loading collector data…"}</div>;
  }
  const plc = data.plc || {};
  const v = plc.values || {};
  const demo = data.demo || {};
  const demoBusy = ["starting", "running", "finishing"].includes(demo.state);
  const ideal = plc.ideal_cycle_time;
  const runDemo = async (stop) => {
    if (!stop && !window.confirm(`Delete ALL live data (cycles, timeline, clips) and run ${demoN} demo cycles?\n`
        + `The real PLC is not read while the demo runs (about ${Math.round(demoN * (ideal || 10) / 60 + 1)} min).`)) return;
    setDemoMsg(null);
    try {
      const r = await fetch("/api/demo/run-demo", { method: "POST", headers: { "Content-Type": "application/json" },
                                                    body: JSON.stringify(stop ? { stop: true } : { cycles: demoN }) });
      if (!r.ok) setDemoMsg((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
    } catch { setDemoMsg("Demo server not reachable"); }
  };
  const DEMO_LABEL = { starting: "Starting…", running: "Running", finishing: "Finishing (last clip)…",
                       done: "Finished", stopped: "Stopped", error: "Error" };
  const st = PLC_STATE[plc.state] || { label: plc.state, color: "#94a3b8" };
  const statusName = plc.status || "—";
  const sh = data.shift || {};

  const signal = (label, s, color) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, background: c.deep, border: `1px solid ${c.border}` }}>
      <Lamp on={!!s?.value} color={color} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: c.text }}>{label}</div>
        <div style={{ fontSize: 10, color: c.sub, fontFamily: "monospace" }}>{s?.address || "—"} = {s?.value ?? "—"}</div>
      </div>
    </div>
  );
  const word = (label, s, extra) => (
    <div style={{ padding: "8px 10px", borderRadius: 8, background: c.deep, border: `1px solid ${c.border}`, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: c.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: c.text, fontFamily: "monospace" }}>{s?.value ?? "—"}</div>
      <div style={{ fontSize: 10, color: c.sub, fontFamily: "monospace" }}>{s?.address || "not set"}{extra}</div>
    </div>
  );
  const tile = (label, value, color) => (
    <div style={{ flex: "1 1 90px", padding: "10px 12px", borderRadius: 10, background: c.deep, border: `1px solid ${c.border}` }}>
      <div style={{ fontSize: 10, color: c.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || c.text, lineHeight: 1.2 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ display: "grid", gap: 14, fontFamily: "'Barlow','Segoe UI',sans-serif" }}>
      {/* Demo run */}
      <div style={{ ...card, borderColor: demoBusy ? "#7c3aed" : c.border }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: c.text }}>Demo PLC run</span>
          {demo.state && demo.state !== "idle" && (
            <Chip label={DEMO_LABEL[demo.state] || demo.state}
                  color={demo.state === "error" ? "#dc2626" : demoBusy ? "#7c3aed" : demo.state === "done" ? "#16a34a" : "#94a3b8"} />
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {!demoBusy && (
              <label style={{ fontSize: 11, color: c.sub, display: "inline-flex", alignItems: "center", gap: 6 }}>
                Cycles
                <input type="number" min={1} max={200} value={demoN}
                  onChange={e => setDemoN(Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 1)))}
                  style={{ width: 60, padding: "4px 6px", borderRadius: 6, border: `1px solid ${c.border}`, background: c.deep, color: c.text, fontSize: 12 }} />
              </label>
            )}
            {demoBusy ? (
              <button type="button" onClick={() => runDemo(true)}
                style={{ padding: "6px 14px", borderRadius: 7, border: "1px solid rgba(220,38,38,.4)", background: c.ngBg, color: "#dc2626", cursor: "pointer", fontSize: 12, fontWeight: 800 }}>
                ■ Stop demo
              </button>
            ) : (
              <button type="button" onClick={() => runDemo(false)}
                style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: "linear-gradient(135deg,#6d28d9,#7c3aed)", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 800 }}>
                ▶ Run demo
              </button>
            )}
          </div>
        </div>
        <div style={{ fontSize: 11, color: c.sub, marginTop: 6, lineHeight: 1.6 }}>
          Deletes the live data first, then a demo PLC plays the cycles through the same SLMP path as the real
          FX5U — ideal CT <b style={{ color: c.text }}>{ideal ?? "—"} s</b>, cycle times mixed around it
          (e.g. {ideal ? `${(ideal * 0.9).toFixed(0)}, ${ideal.toFixed(0)}, ${(ideal * 1.4).toFixed(0)}` : "9, 10, 14"} s), so speed loss goes + and −.
          The CT distribution chart keeps the line's 30-day history.
        </div>
        {(demoBusy || demo.state === "done" || demo.state === "stopped") && demo.total > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ height: 6, borderRadius: 99, background: c.deep, border: `1px solid ${c.border}`, overflow: "hidden" }}>
              <div style={{ width: `${(100 * (demo.done || 0)) / demo.total}%`, height: "100%", background: "#7c3aed", transition: "width .4s" }} />
            </div>
            <div style={{ fontSize: 11, color: c.sub, marginTop: 4 }}>
              Cycle <b style={{ color: c.text }}>{demo.done || 0} / {demo.total}</b>
              {demo.last_ct != null && <> · last CT <b style={{ color: c.text }}>{demo.last_ct} s</b></>}
              {demo.camera && <> · video: {demo.camera === "synthetic" ? "demo test picture (camera not streaming)" : demo.camera === "camera" ? "real camera" : demo.camera}</>}
            </div>
          </div>
        )}
        {(demo.error || demoMsg) && <div style={{ marginTop: 8, fontSize: 12, color: "#dc2626" }}>{demo.error || demoMsg}</div>}
      </div>

      {/* Connection */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 800, color: c.text }}>{plc.machine_name || "Machine"}</span>
          <Chip label={st.label} color={st.color} />
          {plc.demo_plc && <Chip label="Demo PLC" color="#7c3aed" />}
          <span style={{ fontSize: 12, color: c.sub, fontFamily: "monospace" }}>{plc.plc_ip || "—"}:{plc.plc_port}</span>
          <span style={{ fontSize: 11, color: c.sub }}>{plc.protocol} · count mode: {plc.count_mode}</span>
          <span style={{ marginLeft: "auto", fontSize: 11, color: c.sub }}>
            {plc.state === "connected"
              ? <>last read {fmtTime(plc.last_poll)} · {plc.poll_ms} ms</>
              : <>server time {fmtTime(data.server_time)}</>}
          </span>
        </div>
        {plc.last_error && plc.state !== "connected" && (
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 12, color: "#dc2626", background: c.ngBg, border: "1px solid rgba(220,38,38,.3)" }}>
            {plc.last_error}
          </div>
        )}
        {plc.read_errors && (
          <div style={{ marginTop: 10, fontSize: 11, color: "#d97706" }}>Some addresses could not be read: {plc.read_errors.join("; ")}</div>
        )}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          {tile(`Shift ${sh.shift_name || "—"}`, sh.record_date ? sh.record_date.slice(5) : "—")}
          {tile("Status", statusName, STATUS_CLR[statusName] || c.text)}
          {tile("OK", sh.ok ?? 0, "#16a34a")}
          {tile("NG", sh.ng ?? 0, "#dc2626")}
          {tile("Total", sh.total ?? 0)}
        </div>
      </div>

      {/* Signals + registers */}
      <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
        <div style={card}>
          <h4 style={head}>Cycle signals</h4>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))" }}>
            {signal("OK signal", v.ok_signal, "#16a34a")}
            {signal("NG signal", v.ng_signal, "#dc2626")}
            {word("Status", v.status, v.status?.name ? ` · ${v.status.name}` : "")}
            {word("OK count", v.ok_count)}
            {word("NG count", v.ng_count)}
          </div>
          <h4 style={{ ...head, marginTop: 16 }}>Digital inputs</h4>
          {(plc.inputs || []).length === 0 ? (
            <div style={{ fontSize: 12, color: c.sub }}>No digital inputs configured.</div>
          ) : (
            <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
              {plc.inputs.map(x => (
                <div key={x.address} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: c.text, minWidth: 0 }}>
                  <Lamp on={!!x.value} size={10} color="#22c55e" />
                  <span style={{ fontFamily: "monospace", color: c.sub, width: 30 }}>{x.address}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.signal}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={card}>
          <h4 style={head}>Data registers</h4>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Register", "Content", "Raw", "Value"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {(plc.registers || []).map((r, i) => (
                  <tr key={r.register} style={{ background: i % 2 ? c.rowAlt : "transparent" }}>
                    <td style={{ ...td, fontFamily: "monospace", color: "#7c3aed", fontWeight: 700 }}>{r.register}</td>
                    <td style={{ ...td, whiteSpace: "normal" }}>{r.content}</td>
                    <td style={{ ...td, fontFamily: "monospace" }}>{r.value ?? "—"}</td>
                    <td style={{ ...td, fontFamily: "monospace", fontWeight: 700 }}>{scaled(r.value, r.unit)}</td>
                  </tr>
                ))}
                {(plc.registers || []).length === 0 && (
                  <tr><td colSpan={4} style={{ ...td, color: c.sub }}>No data registers configured.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Last cycles */}
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <h4 style={{ ...head, margin: 0 }}>Last cycles (this shift)</h4>
          <span style={{ fontSize: 11, color: c.sub }}>newest first · ▶ plays the cycle clip</span>
        </div>
        {playSeq != null && (
          <div style={{ marginBottom: 12 }}>
            <video key={playSeq} src={clipUrl(playSeq)} controls autoPlay muted playsInline
              style={{ width: "100%", maxHeight: 360, background: "#000", borderRadius: 8, display: "block" }} />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 11, color: c.sub }}>
              <span>Cycle #{playSeq}</span>
              <button type="button" onClick={() => setPlaySeq(null)}
                style={{ border: "none", background: "none", color: c.sub, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>✕ Close video</button>
            </div>
          </div>
        )}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["#", "Time", "CT (s)", "Result", "Part code", "Clip"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {(data.recent_cycles || []).map((r, i) => (
                <tr key={r.cycle_seq} style={{ background: i % 2 ? c.rowAlt : "transparent" }}>
                  <td style={{ ...td, fontFamily: "monospace" }}>{r.cycle_seq}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}>{fmtTime(r.ts)}</td>
                  <td style={{ ...td, fontFamily: "monospace" }}
                      title={r.capped ? "Counted at the max allowed cycle time" : r.ct_source === "plc" ? "Cycle time from the PLC register" : "Time since the previous OK/NG signal"}>
                    {r.ct?.toFixed?.(2) ?? r.ct}{r.capped ? " *" : ""}
                  </td>
                  <td style={td}>
                    <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                      color: r.is_ng ? "#dc2626" : "#16a34a", background: r.is_ng ? c.ngBg : c.okBg }}>{r.is_ng ? "NG" : "OK"}</span>
                  </td>
                  <td style={{ ...td, fontFamily: "monospace", color: c.sub }}>{r.part_code}</td>
                  <td style={td}>
                    {r.clip ? (
                      <button type="button" onClick={() => setPlaySeq(r.cycle_seq)}
                        style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${c.border}`, background: c.deep, color: c.text, cursor: "pointer", fontSize: 11, fontWeight: 700 }}>
                        ▶ Play
                      </button>
                    ) : <span style={{ fontSize: 11, color: c.mut }}>—</span>}
                  </td>
                </tr>
              ))}
              {(data.recent_cycles || []).length === 0 && (
                <tr><td colSpan={6} style={{ ...td, color: c.sub }}>No cycles yet in this shift.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: 8, fontSize: 10, color: c.mut }}>
          CT comes from the PLC's cycle time register ({plc.ct_register || "not set"}) when it has a value, else the time since the previous signal.
          * longer than the max allowed cycle time (a stop): counted at the max.
        </div>
      </div>
    </div>
  );
}

// ─── Popup used by MANAGEMENT-2 ───────────────────────────────
export function LiveModal({ open, title, onClose, dark = false, wide = false, children }) {
  const c = palette(dark);
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 9500, background: "rgba(0,0,0,.6)", backdropFilter: "blur(3px)",
               display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "32px 16px", overflowY: "auto" }}>
      <div role="dialog" aria-modal="true" aria-label={title}
        style={{ width: "100%", maxWidth: wide ? 1100 : 860, background: dark ? "#060912" : "#f1f5f9", borderRadius: 14,
                 border: `1px solid ${c.border}`, boxShadow: "0 24px 80px rgba(0,0,0,.4)", overflow: "hidden", marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px",
                      background: "linear-gradient(135deg,#1e40af,#2563eb)" }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", letterSpacing: ".02em" }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close"
            style={{ width: 30, height: 30, borderRadius: 7, background: "rgba(255,255,255,.15)", border: "1px solid rgba(255,255,255,.3)",
                     color: "#fff", cursor: "pointer", fontSize: 15 }}>✕</button>
        </div>
        <div style={{ padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}
