// Cycle Videos — per cycle, the cycle time next to the length of its saved clip (route /cycle-videos).
//
// Reads GET /api/demo/cycle-videos?date=&shift= (live line, see server.py cycle_videos_view) and plays
// clips from /api/lines/99/cycle-video. "Expected" video length = cycle time + pre-roll + post-roll
// (Camera page, Clip settings); a clip within ±0.2 s of that counts as a match.
import { useEffect, useMemo, useRef, useState } from "react";
import PageTopbar from "../components/PageTopbar";
import { clipUrl } from "../components/LivePanels";

const API = "/api/demo/cycle-videos";
const TOL_S = 0.2;

const C = {
  card: "#fff", border: "#e2e8f0", text: "#0f172a", sub: "#64748b", mut: "#94a3b8", deep: "#f8fafc",
  blue: "#1e40af", ok: "#16a34a", ng: "#dc2626", warn: "#d97706",
};
const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,.05)", minWidth: 0 };
const th = { padding: "8px 10px", textAlign: "left", fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase",
             color: C.mut, borderBottom: `1px solid ${C.border}`, whiteSpace: "nowrap", position: "sticky", top: 0, background: C.card };
const td = { padding: "8px 10px", fontSize: 12, color: C.text, borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" };
const mono = { fontFamily: "monospace" };

const fmt = (v) => (v == null ? "—" : `${Number(v).toFixed(2)} s`);
const clock = (iso) => (iso ? String(iso).slice(11, 19) : "—");
const statusOf = (r) => (!r.clip ? "noclip" : r.video_s == null ? "measuring" : Math.abs(r.diff_s) <= TOL_S ? "match" : "off");

function Badge({ r }) {
  const st = statusOf(r);
  const m = {
    match:     { t: "✓ Match", c: C.ok, bg: "rgba(22,163,74,.1)" },
    off:       { t: `✗ ${r.diff_s > 0 ? "+" : ""}${r.diff_s?.toFixed(2)} s`, c: C.ng, bg: "rgba(220,38,38,.08)" },
    noclip:    { t: "No clip", c: C.mut, bg: "#f1f5f9" },
    measuring: { t: "Measuring…", c: C.warn, bg: "rgba(217,119,6,.08)" },
  }[st];
  return <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 800, color: m.c, background: m.bg }}>{m.t}</span>;
}

function Bar({ label, value, max, color }) {
  const pct = value != null && max > 0 ? Math.min(100, (100 * value) / max) : 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 70px", alignItems: "center", gap: 10, fontSize: 12 }}>
      <span style={{ color: C.sub, fontWeight: 700 }}>{label}</span>
      <div style={{ height: 12, background: "#f1f5f9", borderRadius: 99, overflow: "hidden", border: `1px solid ${C.border}` }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 99, transition: "width .3s" }} />
      </div>
      <span style={{ ...mono, fontWeight: 800, color: C.text, textAlign: "right" }}>{fmt(value)}</span>
    </div>
  );
}

export default function CycleVideos() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [pick, setPick] = useState("");          // "" = current shift, else "date|shift"
  const [filter, setFilter] = useState("all");
  const [sel, setSel] = useState(null);           // selected cycle_seq
  const [pos, setPos] = useState(0);              // playing position (s)
  const [browserDur, setBrowserDur] = useState(null);
  const [rollMsg, setRollMsg] = useState(null);
  const videoRef = useRef(null);

  // Clip = exactly the cycle: pre-roll and post-roll 0 (only the clip settings change, the stream keeps running).
  const zeroRolls = async () => {
    setRollMsg("Saving…");
    try {
      const r = await fetch("/api/demo/camera", { method: "PUT", headers: { "Content-Type": "application/json" },
                                                  body: JSON.stringify({ pre_roll_s: 0, post_roll_s: 0 }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRollMsg("Done: new clips = exactly the cycle time.");
      setData(d => (d ? { ...d, pre_roll_s: 0, post_roll_s: 0 } : d));
    } catch (e) {
      setRollMsg(`Could not save: ${e.message}`);
    }
  };

  useEffect(() => { document.title = "Cycle Videos"; }, []);

  useEffect(() => {
    let alive = true, timer = null;
    const load = async () => {
      try {
        const [d, s] = pick ? pick.split("|") : [];
        const qs = d ? `?date=${encodeURIComponent(d)}&shift=${encodeURIComponent(s)}` : "";
        const r = await fetch(API + qs, { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (alive) { setData(j); setError(null); }
      } catch (e) {
        if (alive) setError(e.message === "Failed to fetch" ? "Demo server not reachable" : e.message);
      } finally {
        if (alive) timer = setTimeout(load, 5000);
      }
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [pick]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const stats = useMemo(() => {
    const s = { total: rows.length, clips: 0, match: 0, off: 0, noclip: 0, diffs: [] };
    for (const r of rows) {
      const st = statusOf(r);
      if (r.clip) s.clips += 1;
      if (st === "match") s.match += 1;
      if (st === "off") s.off += 1;
      if (st === "noclip") s.noclip += 1;
      if (r.diff_s != null) s.diffs.push(Math.abs(r.diff_s));
    }
    s.avg = s.diffs.length ? s.diffs.reduce((a, b) => a + b, 0) / s.diffs.length : null;
    return s;
  }, [rows]);
  const shown = rows.filter(r => filter === "all" || statusOf(r) === filter);
  const cur = rows.find(r => r.cycle_seq === sel) || null;

  const choose = (r) => { setSel(r.cycle_seq); setPos(0); setBrowserDur(null); };

  const tile = (label, value, color, key) => (
    <button type="button" onClick={() => key && setFilter(f => (f === key ? "all" : key))}
      style={{ flex: "1 1 120px", textAlign: "left", padding: "10px 14px", borderRadius: 10, cursor: key ? "pointer" : "default",
               background: filter === key ? "#eff6ff" : C.card, border: `1.5px solid ${filter === key ? C.blue : C.border}` }}>
      <div style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || C.text }}>{value}</div>
    </button>
  );

  const maxBar = cur ? Math.max(cur.expected_s || 0, cur.video_s || 0, browserDur || 0, 0.1) : 1;

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", fontFamily: "'Barlow','Segoe UI',sans-serif", color: C.text, paddingBottom: 60 }}>
      <style>{`
        .cv-body { padding: 24px 32px 0; max-width: 1320px; margin: 0 auto; box-sizing: border-box; }
        .cv-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 16px; align-items: start; }
        @media (max-width: 1000px) { .cv-grid { grid-template-columns: minmax(0, 1fr); } }
        @media (max-width: 600px) { .cv-body { padding: 16px 12px 0; } }
        .cv-row:hover { background: #f8fafc; }
      `}</style>
      <PageTopbar leading="Cycle" accent="Videos" />
      <div className="cv-body">
        {/* Heading + shift picker */}
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Cycle time vs video length</div>
            <div style={{ fontSize: 11, color: C.sub, marginTop: 2, lineHeight: 1.5 }}>
              Expected video = cycle time
              {data && (data.pre_roll_s || data.post_roll_s)
                ? <> + {data.pre_roll_s} s pre-roll + {data.post_roll_s} s post-roll (Camera page → Clip settings)</>
                : <> (pre/post roll 0 s)</>}
              . Match = within ±{TOL_S} s. Click a row to play its clip.
            </div>
            {data && (data.pre_roll_s > 0 || data.post_roll_s > 0) && (
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <button type="button" onClick={zeroRolls}
                  style={{ padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 800,
                           color: "#fff", background: "linear-gradient(135deg,#1e40af,#2563eb)" }}>
                  Make clips = cycle time (pre/post roll → 0 s)
                </button>
                <span style={{ fontSize: 11, color: C.sub }}>Only new clips change; clips already saved keep their length.</span>
              </div>
            )}
            {rollMsg && <div style={{ marginTop: 6, fontSize: 11, fontWeight: 700, color: rollMsg.startsWith("Could") ? C.ng : C.ok }}>{rollMsg}</div>}
          </div>
          <label style={{ marginLeft: "auto", fontSize: 11, color: C.sub, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
            SHIFT
            <select value={pick} onChange={e => { setPick(e.target.value); setSel(null); }}
              style={{ padding: "7px 10px", borderRadius: 8, border: `1.5px solid ${C.border}`, background: C.deep, fontSize: 12, color: C.text }}>
              <option value="">Current shift{data && !pick ? ` (${data.record_date} ${data.shift_name})` : ""}</option>
              {(data?.shifts || []).map(s => (
                <option key={`${s.record_date}|${s.shift_name}`} value={`${s.record_date}|${s.shift_name}`}>
                  {s.record_date} · shift {s.shift_name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <div style={{ ...card, color: C.ng, marginBottom: 14 }}>{error}</div>}

        {/* Summary tiles (click = filter) */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          {tile("Cycles", stats.total, null, "all")}
          {tile("Clips saved", stats.clips)}
          {tile("Match", stats.match, C.ok, "match")}
          {tile("Not matching", stats.off, stats.off ? C.ng : C.text, "off")}
          {tile("No clip", stats.noclip, stats.noclip ? C.warn : C.text, "noclip")}
          {tile("Avg difference", stats.avg == null ? "—" : `${stats.avg.toFixed(2)} s`)}
        </div>

        <div className="cv-grid">
          {/* Table */}
          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
            <div style={{ maxHeight: "calc(100vh - 280px)", minHeight: 300, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>{["#", "Time", "Result", "Cycle time", "Expected video", "Video length", "Difference", ""].map(h => <th key={h} style={th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {shown.map(r => (
                    <tr key={r.cycle_seq} className="cv-row" onClick={() => r.clip && choose(r)}
                        style={{ cursor: r.clip ? "pointer" : "default", background: r.cycle_seq === sel ? "#eff6ff" : undefined }}>
                      <td style={{ ...td, ...mono, fontWeight: 700 }}>{r.cycle_seq}</td>
                      <td style={{ ...td, ...mono }}>{clock(r.ts)}</td>
                      <td style={td}>
                        <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                                       color: r.is_ng ? C.ng : C.ok, background: r.is_ng ? "rgba(220,38,38,.08)" : "rgba(22,163,74,.08)" }}>
                          {r.is_ng ? "NG" : "OK"}
                        </span>
                      </td>
                      <td style={{ ...td, ...mono, fontWeight: 700 }}>{fmt(r.ct)}</td>
                      <td style={{ ...td, ...mono, color: C.sub }}>{fmt(r.expected_s)}</td>
                      <td style={{ ...td, ...mono, fontWeight: 700 }}>{r.clip ? fmt(r.video_s) : "—"}</td>
                      <td style={td}><Badge r={r} /></td>
                      <td style={{ ...td, textAlign: "right" }}>
                        {r.clip && (
                          <span style={{ padding: "2px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: C.deep, fontSize: 11, fontWeight: 700 }}>▶</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {shown.length === 0 && (
                    <tr><td colSpan={8} style={{ ...td, color: C.sub, padding: 20 }}>
                      {data ? (rows.length ? "No cycles for this filter." : "No cycles in this shift yet.") : "Loading…"}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Player */}
          <div style={{ ...card, position: "sticky", top: 76 }}>
            {!cur ? (
              <div style={{ padding: "40px 10px", textAlign: "center", color: C.sub }}>
                <div style={{ fontSize: 34, opacity: .4 }}>🎬</div>
                <div style={{ fontSize: 13, fontWeight: 700, marginTop: 6 }}>Click a cycle to play its clip</div>
                <div style={{ fontSize: 11, marginTop: 4 }}>The player shows the cycle time and the video time side by side.</div>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 14, fontWeight: 800 }}>Cycle #{cur.cycle_seq}</span>
                  <span style={{ ...mono, fontSize: 12, color: C.sub }}>{clock(cur.ts)}</span>
                  <Badge r={cur} />
                </div>
                <video ref={videoRef} key={cur.cycle_seq} src={clipUrl(cur.cycle_seq)} controls autoPlay muted playsInline
                  onTimeUpdate={e => setPos(e.currentTarget.currentTime)}
                  onLoadedMetadata={e => setBrowserDur(e.currentTarget.duration)}
                  style={{ width: "100%", aspectRatio: "16 / 9", background: "#000", borderRadius: 10, display: "block" }} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "12px 0 10px", gap: 10, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>Video time</div>
                    <div style={{ ...mono, fontSize: 26, fontWeight: 800 }}>
                      {pos.toFixed(1)} <span style={{ fontSize: 15, color: C.sub }}>/ {(browserDur ?? cur.video_s ?? 0).toFixed(2)} s</span>
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 10, color: C.sub, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>Cycle time</div>
                    <div style={{ ...mono, fontSize: 26, fontWeight: 800, color: C.blue }}>{cur.ct.toFixed(2)} s</div>
                  </div>
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  <Bar label="Cycle time" value={cur.ct} max={maxBar} color={C.blue} />
                  {cur.expected_s !== cur.ct && <Bar label="Expected video" value={cur.expected_s} max={maxBar} color="#93c5fd" />}
                  <Bar label="Video length" value={cur.video_s ?? browserDur} max={maxBar}
                       color={statusOf(cur) === "off" ? C.ng : C.ok} />
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: C.sub, lineHeight: 1.6 }}>
                  Difference: <b style={{ color: statusOf(cur) === "off" ? C.ng : C.text }}>
                    {cur.diff_s == null ? "—" : `${cur.diff_s > 0 ? "+" : ""}${cur.diff_s.toFixed(2)} s`}</b>
                  {" "}· {cur.is_ng ? "NG" : "OK"} · part {cur.part_code || "—"}
                  {cur.long && <> · <span style={{ color: C.warn }}>cycle longer than 10 min: the clip shows its last 10 min</span></>}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
