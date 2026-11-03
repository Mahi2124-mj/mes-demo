// Kaizen — month-wise Kaizen numbers (route /kaizen). Saved on the server (PUT /api/demo/kaizen ->
// data/kaizen.json); MANAGEMENT-2 (9:16) shows them as the "Kaizen · monthly" bar graph within a minute.
import { useEffect, useState } from "react";
import PageTopbar from "../components/PageTopbar";

const API = "/api/demo/kaizen";
const MONTHS = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];   // financial year

const C = { card: "#fff", border: "#e2e8f0", text: "#0f172a", sub: "#64748b", mut: "#94a3b8", ok: "#16a34a", ng: "#dc2626",
            blue: "#1e40af" };
const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: 18, boxShadow: "0 1px 3px rgba(0,0,0,.05)" };
const input = { padding: "8px 10px", border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 14, width: "100%", boxSizing: "border-box" };
const label = { fontSize: 10, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: C.mut, marginBottom: 4, display: "block" };

export default function Kaizen() {
  const [title, setTitle] = useState("");
  const [unit, setUnit] = useState("");
  const [values, setValues] = useState({});          // month -> string (blank = month not shown)
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(API).then(r => r.json()).then(d => {
      setTitle(d.title || "");
      setUnit(d.unit || "");
      setValues(Object.fromEntries((d.months || []).map(m => [m.month, String(m.value)])));
    }).catch(() => setMsg({ ok: false, t: "Server not reachable" }));
  }, []);

  const save = async () => {
    const months = MONTHS.filter(m => String(values[m] ?? "").trim() !== "")
                         .map(m => ({ month: m, value: Number(values[m]) }));
    if (months.some(m => !Number.isFinite(m.value) || m.value < 0)) {
      setMsg({ ok: false, t: "Every value must be a number of 0 or more." });
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(API, { method: "PUT", headers: { "Content-Type": "application/json" },
                                   body: JSON.stringify({ title, unit, months }) });
      setMsg(r.ok ? { ok: true, t: "Saved: the dashboard shows it within a minute." }
                  : { ok: false, t: (await r.json().catch(() => ({}))).detail || `HTTP ${r.status}` });
    } catch {
      setMsg({ ok: false, t: "Server not reachable" });
    }
    setBusy(false);
  };

  const shown = MONTHS.filter(m => String(values[m] ?? "").trim() !== "");
  const max = Math.max(1, ...shown.map(m => Number(values[m]) || 0));

  return (
    <div>
      <PageTopbar leading="Kaizen" accent="Monthly" />
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px 20px", display: "grid", gap: 16 }}>
        <div style={card}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div><span style={label}>Graph title</span>
              <input style={input} value={title} onChange={e => setTitle(e.target.value)} placeholder="Kaizen · monthly" /></div>
            <div><span style={label}>Note (top right of the graph)</span>
              <input style={input} value={unit} onChange={e => setUnit(e.target.value)} placeholder="Apr-Nov 2026" /></div>
          </div>
          <span style={label}>Kaizen per month (leave blank to hide a month)</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10 }}>
            {MONTHS.map(m => (
              <div key={m}>
                <div style={{ fontSize: 12, fontWeight: 800, color: C.sub, marginBottom: 3 }}>{m}</div>
                <input style={input} type="number" min="0" value={values[m] ?? ""}
                       onChange={e => setValues(v => ({ ...v, [m]: e.target.value }))} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16 }}>
            <button onClick={save} disabled={busy}
                    style={{ padding: "9px 22px", borderRadius: 8, border: "none", background: C.blue, color: "#fff",
                             fontWeight: 800, fontSize: 14, cursor: busy ? "default" : "pointer", opacity: busy ? .6 : 1 }}>
              {busy ? "Saving…" : "SAVE"}
            </button>
            {msg && <span style={{ fontSize: 13, fontWeight: 700, color: msg.ok ? C.ok : C.ng }}>{msg.t}</span>}
          </div>
        </div>

        <div style={card}>
          <span style={label}>Preview</span>
          <div style={{ height: 220, display: "flex", alignItems: "flex-end", gap: 10, borderBottom: `1px solid ${C.border}`, paddingTop: 22 }}>
            {shown.map(m => (
              <div key={m} style={{ flex: 1, position: "relative", height: `${(Number(values[m]) || 0) / max * 100}%`,
                   borderRadius: "5px 5px 0 0",
                   background: "linear-gradient(180deg,#34d399,#059669)" }}>
                <span style={{ position: "absolute", bottom: "100%", left: 0, right: 0, textAlign: "center", fontWeight: 900,
                       fontSize: 14, color: C.text }}>{values[m]}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 10, paddingTop: 4 }}>
            {shown.map(m => <span key={m} style={{ flex: 1, textAlign: "center", fontSize: 12, fontWeight: 800, color: C.sub }}>{m}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}
