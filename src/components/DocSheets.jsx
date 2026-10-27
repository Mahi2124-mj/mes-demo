// Line documents shown on MANAGEMENT-2: the plant's own sheets (Track Record, 4M Change, Operator
// Visualization, Safety Chart, Defect Record), rendered from the Excel files to PNG pages in
// public/docs/ (one image per sheet, plus a print-ready PDF per document).
//
//   <DocSheetsRow>  card (portrait layout): Track Record upright on the left, the four landscape sheets
//                   in a 2 x 2 grid beside it; tap opens the viewer
//   <DocViewer>     full-screen popup: document tabs, sheet tabs, ‹ › paging, Fit / 100 % zoom, PDF,
//                   ✕ on the sheet's top-right corner
import { useEffect, useRef, useState } from "react";

const SHEETS_RATIO = 2.15;   // width : height of the card's sheets (Track Record upright + 2 x 2 landscape)
import { createPortal } from "react-dom";

const page = (key, n, label, w, h) => ({ src: `/docs/${key}-${n}.png`, thumb: `/docs/${key}-${n}.thumb.png`, label, w, h });

export const DOCS = [
  { key: "track_record", label: "Track Record Sheet", short: "Track Record", pdf: "/docs/track_record.pdf",
    pages: ["YNC", "YHB", "YRA", "YSD"].map((s, i) => page("track_record", i + 1, s, 1600, 1872)) },
  { key: "4m_change", label: "4M Change Control Sheet", short: "4M Change", pdf: "/docs/4m_change.pdf",
    pages: [1, 2, 3, 4].map(i => page("4m_change", i, `4M Sheet ${i}`, 2200, 1472)) },
  { key: "operator_visualization", label: "Operator Visualization Sheet", short: "Operator Visualization",
    pdf: "/docs/operator_visualization.pdf", pages: [page("operator_visualization", 1, "Visualization Sheet", 2200, 1442)] },
  { key: "safety_chart", label: "Annual Safety Chart", short: "Safety Chart", pdf: "/docs/safety_chart.pdf",
    pages: [page("safety_chart", 1, "Safety Chart", 2200, 1517)] },
  { key: "defect_record", label: "Defect Recording Sheet", short: "Defect Record", pdf: "/docs/defect_record.pdf",
    pages: [page("defect_record", 1, "Defect Recording Sheet", 2200, 1556)] },
];

// ─── Full-screen viewer ───────────────────────────────────────
export function DocViewer({ start = 0, onClose }) {
  const [di, setDi] = useState(start);   // document index
  const [pi, setPi] = useState(0);       // page index inside the document
  const [zoom, setZoom] = useState(false);
  const boxRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });   // room for the sheet (inside the scroll area)
  const doc = DOCS[di];
  const pg = doc.pages[Math.min(pi, doc.pages.length - 1)];

  const openDoc = (i) => { setDi(i); setPi(0); setZoom(false); };
  // ‹ › walk through every page of every document, in order.
  const step = (d) => {
    setZoom(false);
    const np = pi + d;
    if (np >= 0 && np < doc.pages.length) return setPi(np);
    const nd = (di + d + DOCS.length) % DOCS.length;
    setDi(nd);
    setPi(d > 0 ? 0 : DOCS[nd].pages.length - 1);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") step(1);
      if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    const el = boxRef.current;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {                    // warm the next pages so paging is instant
    for (const d of [DOCS[di], DOCS[(di + 1) % DOCS.length]]) for (const p of d.pages) { const im = new Image(); im.src = p.src; }
  }, [di]);

  const btn = { height: 34, padding: "0 12px", borderRadius: 8, border: "1px solid #475569", background: "#0f172a",
                color: "#e2e8f0", fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" };
  const tab = (active) => ({ ...btn, height: 30, background: active ? "#2563eb" : "#0f172a",
                             borderColor: active ? "#2563eb" : "#334155", color: active ? "#fff" : "#cbd5e1" });
  // Where the sheet sits in the box: fitted and centred, or 100 % (scrolls; the ✕ stays on its visible corner).
  const fit = Math.min(box.w / pg.w, box.h / pg.h);
  const shown = zoom ? { w: pg.w, h: pg.h } : { w: pg.w * fit, h: pg.h * fit };
  const vis = { x: Math.max(0, (box.w - shown.w) / 2), y: zoom ? 0 : Math.max(0, (box.h - shown.h) / 2),
                w: Math.min(shown.w, box.w) };
  const PAD = 18, X = 34;               // PAD: room around the sheet for the ✕ to sit half outside its corner
  const clipped = zoom && shown.w >= box.w;          // zoomed past the box: keep the ✕ inside, clear of the scrollbar
  const close = clipped ? { left: PAD + box.w - X - 6, top: PAD + 6 }
                        : { left: PAD + Math.min(vis.x + vis.w - X / 2, box.w + PAD - X), top: PAD + vis.y - X / 2 };
  const narrow = window.innerWidth < 640;            // phone: ‹ › float over the sheet instead of beside it
  const side = (edge) => ({ width: 46, height: 46, borderRadius: 99, border: "1px solid #475569", background: "rgba(15,23,42,.85)",
                 color: "#e2e8f0", fontSize: 24, fontWeight: 900, cursor: "pointer", flexShrink: 0,
                 ...(narrow ? { position: "absolute", top: "50%", [edge]: 6, transform: "translateY(-50%)", zIndex: 1 } : {}) });

  return createPortal((
    <div role="dialog" aria-modal="true" aria-label={doc.label} onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 9999, background: "rgba(2,6,23,.96)", display: "flex",
               flexDirection: "column", fontFamily: "'Barlow','Segoe UI',sans-serif" }}>
      {/* Top bar: documents + actions */}
      <div onClick={e => e.stopPropagation()}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", flexWrap: "wrap", borderBottom: "1px solid #1e293b" }}>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", flex: "1 1 400px", minWidth: 0, paddingBottom: 2 }}>
          {DOCS.map((d, i) => (
            <button key={d.key} type="button" style={tab(i === di)} onClick={() => openDoc(i)}>📄 {d.short}</button>
          ))}
        </div>
        <button type="button" style={btn} onClick={() => setZoom(z => !z)} title="Fit to screen / actual size">
          {zoom ? "⤡ Fit" : "🔍 100%"}
        </button>
        <a href={doc.pdf} target="_blank" rel="noopener noreferrer" style={{ ...btn, display: "inline-flex", alignItems: "center", textDecoration: "none" }}
           title="Open the PDF to print or download">⬇ PDF / Print</a>
      </div>

      {/* Title + sheet tabs */}
      <div onClick={e => e.stopPropagation()}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", flexWrap: "wrap" }}>
        <span style={{ color: "#f1f5f9", fontSize: 15, fontWeight: 800 }}>{doc.label}</span>
        {doc.pages.length > 1 && doc.pages.map((p, i) => (
          <button key={p.src} type="button" style={tab(i === pi)} onClick={() => { setPi(i); setZoom(false); }}>{p.label}</button>
        ))}
        <span style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 11 }}>
          {doc.pages.length > 1 ? `Sheet ${pi + 1} of ${doc.pages.length} · ` : ""}← → to page · click the sheet to zoom · Esc closes
        </span>
      </div>

      {/* Page */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", gap: 10, padding: "0 10px 12px", position: "relative" }}>
        <button type="button" style={side("left")} title="Previous" onClick={e => { e.stopPropagation(); step(-1); }}>‹</button>
        <div style={{ flex: 1, height: "100%", minWidth: 0, position: "relative", padding: `${PAD}px ${PAD}px 0` }}>
          <div ref={boxRef} onClick={e => e.stopPropagation()}
            style={{ height: "100%", overflow: zoom ? "auto" : "hidden", display: "flex", alignItems: "flex-start" }}>
            <img key={pg.src} src={pg.src} alt={`${doc.label} — ${pg.label}`} onClick={() => setZoom(z => !z)}
              style={{ width: shown.w || undefined, height: shown.h || undefined, maxWidth: "none", flexShrink: 0,
                       margin: zoom ? "0 auto" : `${vis.y}px auto 0`, cursor: zoom ? "zoom-out" : "zoom-in",
                       background: "#fff", boxShadow: zoom ? "none" : "0 8px 40px rgba(0,0,0,.6)", display: "block",
                       visibility: box.w ? "visible" : "hidden" }} />
          </div>
          {box.w > 0 && (
            <button type="button" onClick={e => { e.stopPropagation(); onClose(); }} title="Close (Esc)" aria-label="Close"
              style={{ position: "absolute", left: close.left, top: close.top, width: X, height: X, borderRadius: 99,
                       border: "2px solid #fff", background: "#dc2626", color: "#fff", fontSize: 16, fontWeight: 900,
                       lineHeight: 1, cursor: "pointer", boxShadow: "0 2px 10px rgba(0,0,0,.5)", zIndex: 2 }}>✕</button>
          )}
        </div>
        <button type="button" style={side("right")} title="Next" onClick={e => { e.stopPropagation(); step(1); }}>›</button>
      </div>
    </div>
  ), document.body);
}

// ─── Card (portrait layout): Track Record upright on the left, 2 x 2 landscape sheets beside it ───
export default function DocSheetsRow({ card, hdr, lbl9, textMut, style, boxId, fixedHeight = false }) {
  const [open, setOpen] = useState(null);
  const boxRef = useRef(null);
  const [box, setBox] = useState(null);
  useEffect(() => {
    const el = boxRef.current;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // as large as the card allows, keeping the sheets' shape (a card of its own height: as wide as it is)
  const fitW = fixedHeight && box && box.h > 0 ? Math.min(box.w, box.h * SHEETS_RATIO) : null;
  const tile = (d, i, big) => (
    <button key={d.key} type="button" onClick={() => setOpen(i)} title={`Open ${d.label}`}
      style={{ cursor: "pointer", minWidth: 0, minHeight: 0, width: "100%", height: "100%", display: "flex",
               flexDirection: "column", padding: 0, border: "none", background: "transparent", textAlign: "left" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, width: "100%", height: 16, flexShrink: 0 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: textMut, letterSpacing: ".06em", textTransform: "uppercase",
                       whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.short}</span>
        {d.pages.length > 1 && (
          <span style={{ marginLeft: "auto", fontSize: 9, fontWeight: 800, color: "#fff", background: "#2563eb",
                         borderRadius: 99, padding: "1px 6px", flexShrink: 0 }}>{d.pages.length} sheets</span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, width: "100%", display: "flex", alignItems: "flex-start", justifyContent: "flex-start",
                    overflow: "hidden" }}>
        {/* the big tile is shown near full size, so it uses the page image instead of the thumbnail */}
        <img src={big ? d.pages[0].src : d.pages[0].thumb} alt={d.label} loading="lazy"
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "#fff",
                   boxShadow: "0 2px 10px rgba(0,0,0,.35)", display: "block" }} />
      </div>
    </button>
  );
  const [upright, ...rest] = DOCS;
  return (
    <div data-box={boxId} style={{ ...card(), display: "flex", flexDirection: "column", minHeight: 0, ...style }}>
      <div style={hdr({ padding: "4px 10px" })}>
        <span style={lbl9}>Documents</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 10, color: textMut, fontWeight: 700 }}>Tap a sheet to open</span>
          <button type="button" onClick={() => setOpen(0)}
            style={{ cursor: "pointer", border: "1px solid #475569", borderRadius: 6, background: "transparent",
                     color: textMut, fontSize: 10, fontWeight: 800, padding: "2px 8px" }}>📄 Open all</button>
        </span>
      </div>
      {/* The upright sheet (1600 x 1872) is as tall as two rows of landscape sheets (~1.48 : 1), so
          1.24fr : 1fr : 1fr columns at SHEETS_RATIO fill the cells; centred in the card. */}
      <div ref={boxRef} style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: fitW ?? "100%", aspectRatio: `${SHEETS_RATIO} / 1`, display: "grid", gap: 10, padding: 8,
                      gridTemplateColumns: "minmax(0, 1.24fr) minmax(0, 1fr) minmax(0, 1fr)",
                      gridTemplateRows: "repeat(2, minmax(0, 1fr))" }}>
          <div style={{ gridRow: "1 / span 2", minWidth: 0, minHeight: 0 }}>{tile(upright, 0, true)}</div>
          {rest.map((d, k) => tile(d, k + 1))}
        </div>
      </div>
      {open != null && <DocViewer start={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
