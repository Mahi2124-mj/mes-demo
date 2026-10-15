// Demo page 2: four A3 landscape documents (4M Change, Quality, Safety, blank)
// in a 2×2 grid.  Sample layouts until the plant's real sheets are supplied;
// tap a sheet to open it full size.
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const PG_W = 1587;  // A3 landscape at 96 dpi
const PG_H = 1123;

// Renders the page at its natural size, scaled to fit inside its parent box
// (both width and height), centred.
function FitPage({ children, blank = false }) {
  const boxRef = useRef(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const fit = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w && h) setScale(Math.min(w / PG_W, h / PG_H));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={boxRef} style={{ width: "100%", height: "100%", display: "flex",
                               alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={{ width: PG_W * scale, height: PG_H * scale, position: "relative", overflow: "hidden",
                    flexShrink: 0, background: blank ? "transparent" : "#fff",
                    boxShadow: blank ? "none" : "0 2px 10px rgba(0,0,0,.35)" }}>
        <div style={{ width: PG_W, height: PG_H, transform: `scale(${scale})`, transformOrigin: "top left",
                      position: "absolute", top: 0, left: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Shared sheet parts ────────────────────────────────────────────────
const ink = "#111827", mute = "#4b5563", rule = "#9ca3af";
const page = { width: PG_W, height: PG_H, boxSizing: "border-box", padding: "40px 48px",
               fontFamily: "'Segoe UI', Arial, sans-serif", color: ink, background: "#fff",
               display: "flex", flexDirection: "column", gap: 20, position: "relative" };
const th = { border: `1px solid ${ink}`, padding: "9px 10px", background: "#e5e7eb", fontSize: 19,
             fontWeight: 800, textAlign: "left" };
const td = { border: `1px solid ${ink}`, padding: "9px 10px", fontSize: 19, height: 28, verticalAlign: "top" };
const body = { flex: 1, minHeight: 0, display: "grid", gap: 20 };

function Watermark() {
  return (
    <div style={{ position: "absolute", top: "42%", left: 0, right: 0, textAlign: "center",
                  transform: "rotate(-18deg)", fontSize: 220, fontWeight: 900, letterSpacing: 30,
                  color: "rgba(17,24,39,0.06)", pointerEvents: "none", userSelect: "none" }}>
      SAMPLE
    </div>
  );
}

function Letterhead({ title, color, info }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "stretch", border: `2px solid ${ink}` }}>
        <div style={{ width: 220, display: "flex", alignItems: "center", justifyContent: "center",
                      borderRight: `2px solid ${ink}`, padding: 10 }}>
          <img src="/logo.jpg" alt="" style={{ maxWidth: "100%", maxHeight: 80 }} />
        </div>
        <div style={{ flex: 1, background: color, color: "#fff", display: "flex", alignItems: "center",
                      justifyContent: "center", fontSize: 52, fontWeight: 900, letterSpacing: 2,
                      textAlign: "center", padding: "14px 10px" }}>
          {title}
        </div>
        <div style={{ width: 240, borderLeft: `2px solid ${ink}`, fontSize: 17 }}>
          {[["Doc No.", ""], ["Rev.", ""], ["Page", "1 of 1"]].map(([k, v], i) => (
            <div key={k} style={{ display: "flex", borderTop: i ? `1px solid ${ink}` : "none", height: "33.3%" }}>
              <span style={{ width: 86, padding: "5px 8px", fontWeight: 800, borderRight: `1px solid ${ink}` }}>{k}</span>
              <span style={{ flex: 1, padding: "5px 8px" }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 3fr 1fr 0.6fr", border: `1px solid ${ink}` }}>
        {info.map(([k, v], i) => (
          <div key={k} style={{ padding: "8px 12px", borderLeft: i ? `1px solid ${ink}` : "none" }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: mute, textTransform: "uppercase" }}>{k}</div>
            <div style={{ fontSize: 21, fontWeight: 700 }}>{v || "—"}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function SignOff() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", border: `1px solid ${ink}` }}>
      {["Prepared by", "Checked by", "Approved by"].map((k, i) => (
        <div key={k} style={{ padding: "10px 12px", height: 80, borderLeft: i ? `1px solid ${ink}` : "none",
                              fontSize: 17, fontWeight: 800, color: mute }}>{k}</div>
      ))}
    </div>
  );
}

// ── 1. 4M Change ──────────────────────────────────────────────────────
function Sheet4M({ info }) {
  const boxes = [
    { k: "MAN",      st: "1 CHANGE",  c: "#d97706", d: "Relief operator at Final Inspection" },
    { k: "MACHINE",  st: "NO CHANGE", c: "#16a34a", d: "" },
    { k: "MATERIAL", st: "NO CHANGE", c: "#16a34a", d: "" },
    { k: "METHOD",   st: "NO CHANGE", c: "#16a34a", d: "" },
  ];
  return (
    <div style={page}>
      <Watermark />
      <Letterhead title="4M CHANGE POINT SHEET" color="#1d4ed8" info={info} />
      <div style={{ ...body, gridTemplateColumns: "1fr 1.7fr" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gridTemplateRows: "1fr 1fr", gap: 14 }}>
          {boxes.map(b => (
            <div key={b.k} style={{ border: `4px solid ${b.c}`, borderRadius: 10, padding: "14px 16px",
                                    display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ fontSize: 44, fontWeight: 900 }}>{b.k}</div>
              <div style={{ fontSize: 34, fontWeight: 900, color: b.c }}>{b.st}</div>
              <div style={{ fontSize: 18, color: mute, marginTop: 6 }}>{b.d}</div>
            </div>
          ))}
        </div>
        <table style={{ borderCollapse: "collapse", width: "100%", alignSelf: "start" }}>
          <thead><tr>
            {["#", "4M", "Change detail", "Reason", "Time", "First-off check", "Result", "Sign"].map(h =>
              <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            <tr>
              <td style={td}>1</td><td style={td}>Man</td><td style={td}>Relief operator</td>
              <td style={td}>Operator on leave</td><td style={td}>08:30</td><td style={td}>5 parts checked</td>
              <td style={{ ...td, color: "#16a34a", fontWeight: 800 }}>OK</td><td style={td}></td>
            </tr>
            {Array.from({ length: 9 }, (_, i) => (
              <tr key={i}>{Array.from({ length: 8 }, (_, j) =>
                <td key={j} style={td}>{j === 0 ? i + 2 : ""}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <SignOff />
    </div>
  );
}

// ── 2. Quality ────────────────────────────────────────────────────────
function SheetQuality({ info }) {
  const rows = [
    ["Slide movement", "Smooth, no jerk or noise", "Manual feel", "Every part"],
    ["Lock engagement", "Lock fully engaged on both rails", "Visual + manual", "Every part"],
    ["Part code label", "Correct model, readable", "Visual / scanner", "Every part"],
    ["Fasteners", "All bolts and nuts present", "Visual", "Every part"],
    ["Appearance", "No dent, scratch, rust or burr", "Visual", "Every part"],
    ["Grease", "Applied as per standard", "Visual", "Every part"],
  ];
  return (
    <div style={page}>
      <Watermark />
      <Letterhead title="QUALITY CHECK SHEET" color="#047857" info={info} />
      <div style={{ ...body, gridTemplateColumns: "1fr 2fr" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ border: "4px solid #047857", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: mute }}>CHECK POINTS</div>
            <div style={{ fontSize: 80, fontWeight: 900, color: "#047857", lineHeight: 1.05 }}>{rows.length}</div>
          </div>
          <div style={{ border: "4px solid #dc2626", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: mute }}>NG PART</div>
            <div style={{ fontSize: 34, fontWeight: 900, color: "#dc2626", lineHeight: 1.25 }}>
              Red bin + NG tag.<br />Inform line leader.
            </div>
          </div>
          <div style={{ flex: 1, border: `1px solid ${ink}`, padding: "10px 14px", fontSize: 18 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Remarks</div>
            {[0, 1, 2, 3].map(i => <div key={i} style={{ borderBottom: `1px dashed ${rule}`, height: 32 }} />)}
          </div>
        </div>
        <table style={{ borderCollapse: "collapse", width: "100%", alignSelf: "start" }}>
          <thead><tr>
            {["#", "Check point", "Standard", "Method", "Frequency"].map(h => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}><td style={{ ...td, height: 44 }}>{i + 1}</td>
                {r.map((c, j) => <td key={j} style={{ ...td, height: 44 }}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <SignOff />
    </div>
  );
}

// ── 3. Safety ─────────────────────────────────────────────────────────
function SheetSafety({ info }) {
  const ppe = [["🥾", "Safety shoes"], ["🧤", "Hand gloves"], ["🥽", "Safety goggles"],
               ["🎧", "Ear plugs"], ["🦺", "Uniform"], ["⛑️", "Safety cap"]];
  const dos = ["Wear all PPE before start", "Keep the work area clean", "Use the tool only from its stand",
               "Report any unsafe condition"];
  const donts = ["No hand inside a running machine", "No mobile phone at the station",
                 "Do not bypass any safety sensor", "Do not run with a damaged tool"];
  return (
    <div style={page}>
      <Watermark />
      <Letterhead title="SAFETY INSTRUCTION SHEET" color="#dc2626" info={info} />
      <div style={{ ...body, gridTemplateColumns: "1fr 1.25fr" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 1 }}>PPE REQUIRED</div>
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {ppe.map(([i, l]) => (
              <div key={l} style={{ border: "4px solid #1d4ed8", borderRadius: 10, padding: 8, textAlign: "center",
                                    display: "flex", flexDirection: "column", justifyContent: "center" }}>
                <div style={{ fontSize: 76, lineHeight: 1.1 }}>{i}</div>
                <div style={{ fontSize: 22, fontWeight: 800 }}>{l}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            {[["DO", "#16a34a", dos, "✔"], ["DON'T", "#dc2626", donts, "✖"]].map(([t, c, list, m]) => (
              <div key={t} style={{ border: `4px solid ${c}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ background: c, color: "#fff", fontSize: 30, fontWeight: 900, padding: "8px 14px" }}>{t}</div>
                {list.map(x => (
                  <div key={x} style={{ display: "flex", gap: 10, padding: "10px 14px", fontSize: 20,
                                        borderTop: `1px solid ${rule}` }}>
                    <span style={{ color: c, fontWeight: 900 }}>{m}</span><span>{x}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ flex: 1, border: "4px solid #dc2626", borderRadius: 10, padding: "12px 16px",
                        fontSize: 21, lineHeight: 1.7 }}>
            <div style={{ fontSize: 28, fontWeight: 900, color: "#dc2626" }}>IN AN EMERGENCY</div>
            <div>1. Press the red EMERGENCY STOP button.</div>
            <div>2. Inform the line leader at once.</div>
            <div>First-aid box: ______________________ &nbsp; Contact: ______________________</div>
          </div>
        </div>
      </div>
      <SignOff />
    </div>
  );
}

// ── 4. Blank slot ─────────────────────────────────────────────────────
function SheetBlank() {
  return (
    <div style={{ ...page, background: "transparent", border: "8px dashed #64748b", borderRadius: 16,
                  alignItems: "center", justifyContent: "center", color: "#94a3b8", textAlign: "center" }}>
      <div style={{ fontSize: 160, lineHeight: 1 }}>📄</div>
      <div style={{ fontSize: 64, fontWeight: 900 }}>DOCUMENT 4</div>
      <div style={{ fontSize: 36, fontWeight: 700 }}>Not assigned</div>
    </div>
  );
}

const SHEETS = [
  { key: "4m",      label: "4M Change", Comp: Sheet4M },
  { key: "quality", label: "Quality",   Comp: SheetQuality },
  { key: "safety",  label: "Safety",    Comp: SheetSafety },
  { key: "blank",   label: "Document 4", Comp: SheetBlank, blank: true },
];

// 2×2 grid of the four sheets + full-size viewer.  Fills the height it is given.
export default function DocSheetsRow({ card, hdr, lbl9, textMut, style, info }) {
  const [open, setOpen] = useState(null);   // index of the sheet in the viewer
  useEffect(() => {
    if (open == null) return;
    const onKey = e => {
      if (e.key === "Escape") setOpen(null);
      if (e.key === "ArrowRight") setOpen(i => (i + 1) % SHEETS.length);
      if (e.key === "ArrowLeft")  setOpen(i => (i + SHEETS.length - 1) % SHEETS.length);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const cur = open != null ? SHEETS[open] : null;
  const navBtn = { width: 44, height: 44, borderRadius: 99, border: "1px solid #475569", background: "#0f172a",
                   color: "#e2e8f0", fontSize: 22, fontWeight: 900, cursor: "pointer", flexShrink: 0 };
  return (
    <div style={{ ...card(), display: "flex", flexDirection: "column", minHeight: 0, ...style }}>
      <div style={hdr({ padding: "4px 10px" })}>
        <span style={lbl9}>Documents</span>
        <span style={{ fontSize: 10, color: textMut, fontWeight: 700 }}>Tap a sheet to open</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 1fr",
                    gridTemplateRows: "1fr 1fr", gap: 8, padding: 8 }}>
        {SHEETS.map(({ key, label, Comp, blank }, i) => (
          <div key={key} onClick={() => setOpen(i)}
               style={{ cursor: "pointer", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: textMut, letterSpacing: ".06em",
                          textTransform: "uppercase", marginBottom: 4, whiteSpace: "nowrap",
                          overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
            <div style={{ flex: 1, minHeight: 0 }}>
              <FitPage blank={blank}><Comp info={info} /></FitPage>
            </div>
          </div>
        ))}
      </div>

      {cur && createPortal((
        <div onClick={() => setOpen(null)}
             style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.85)",
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: 12 }}>
          <button style={navBtn} title="Previous"
                  onClick={e => { e.stopPropagation(); setOpen(i => (i + SHEETS.length - 1) % SHEETS.length); }}>‹</button>
          <div style={{ flex: 1, height: "100%", minWidth: 0, position: "relative" }}>
            <div onClick={e => e.stopPropagation()} style={{ width: "100%", height: "100%" }}>
              <FitPage key={cur.key} blank={cur.blank}><cur.Comp info={info} /></FitPage>
            </div>
            <button onClick={() => setOpen(null)} title="Close"
                    style={{ ...navBtn, position: "absolute", top: 8, right: 8, width: 36, height: 36, fontSize: 16 }}>✕</button>
          </div>
          <button style={navBtn} title="Next"
                  onClick={e => { e.stopPropagation(); setOpen(i => (i + 1) % SHEETS.length); }}>›</button>
        </div>
      ), document.body)}
    </div>
  );
}
