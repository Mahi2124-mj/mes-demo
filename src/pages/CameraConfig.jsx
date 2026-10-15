// Camera Configuration — standalone demo page (route /camera).
//
// Visual clone of the MES admin pages (AdminPanel.jsx helpers + CameraListPage
// table + the line "Camera Recording" toggle).  Field set follows the CMS
// camera editor (Name, IP, Port, RTSP path, Username, Password — blank password
// keeps the stored one) and CameraMaster (video save path, retention days).
//
// This page talks ONLY to the demo server's own endpoints:
//   GET/PUT /api/demo/camera             camera config object
//   GET     /api/demo/camera/sample-clip recorded sample clip (video/mp4)
//   GET     /api/demo/camera/live.mjpg   live preview (via LivePanels)
// The demo server (camera.py) opens the RTSP stream; the browser never talks to the camera.
import { useState, useEffect, useMemo, useCallback } from "react";
import PageTopbar from "../components/PageTopbar";
import { COLORS, pageWrap } from "../components/whiteTheme";
import { CameraLive, useCollector } from "../components/LivePanels";

const API_CAMERA = "/api/demo/camera";
const SAMPLE_CLIP = "/api/demo/camera/sample-clip";

export const DEFAULTS = {
  camera_id: "CAM-01",
  name: "Station camera",
  ip: "192.168.30.20",
  port: 554,
  rtsp_path: "/h264/ch1/main/av_stream",    // the station camera's main stream
  username: "admin",
  password: "",
  assigned_machine: "Nut-Runner Demo Station",
  recording_enabled: true,
  codec: "H.264 Main",
  resolution: "1920 × 1080",
  fps: 25,
  bitrate_kbps: 2000,
  iframe_interval: 25,
  video_save_path: "/home/server/mes-demo-5000/clips",
  retention_days: 30,
  pre_roll_s: 2,
  post_roll_s: 2,
};

const MACHINES = ["Nut-Runner Demo Station"];
const CODECS = ["H.264 Main", "H.264 High", "H.265"];
const RESOLUTIONS = ["1280 × 720", "1920 × 1080", "2560 × 1440"];

// ─── Shared UI helpers (copied from MES AdminPanel.jsx) ───────
function Card({ children, style, className }) {
  return (
    <div className={className} style={{
      background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14,
      padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,.05)", minWidth: 0, ...style,
    }}>
      {children}
    </div>
  );
}

function CardTitle({ title, sub, right }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{title}</div>
        {sub && <div style={{ fontSize: 11, color: "#64748b", marginTop: 2, maxWidth: 760, lineHeight: 1.5 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function Pill({ label, color = "blue" }) {
  const colors = {
    green:  { bg: "rgba(22,163,74,.1)",   border: "rgba(22,163,74,.25)",   text: "#16a34a" },
    red:    { bg: "rgba(220,38,38,.1)",    border: "rgba(220,38,38,.25)",   text: "#dc2626" },
    blue:   { bg: "rgba(30,64,175,.1)",    border: "rgba(30,64,175,.2)",    text: "#1e40af" },
    amber:  { bg: "rgba(217,119,6,.1)",    border: "rgba(217,119,6,.25)",   text: "#d97706" },
    gray:   { bg: "#f1f5f9",               border: "#e2e8f0",               text: "#64748b" },
  };
  const c = colors[color] || colors.blue;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 10px", borderRadius: 99,
      background: c.bg, border: `1px solid ${c.border}`,
      fontSize: 11, fontWeight: 600, color: c.text, whiteSpace: "nowrap",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: c.text }} />
      {label}
    </span>
  );
}

function Btn({ children, onClick, variant = "ghost", size = "md", disabled = false, style: s, title }) {
  const [h, setH] = useState(false);
  const pad = size === "sm" ? "5px 12px" : "9px 18px";
  const fs  = size === "sm" ? 11 : 13;
  const styles = {
    primary: { background: h ? "#1d3fa8" : "linear-gradient(135deg,#1e40af,#2563eb)", color: "#fff", border: "none", boxShadow: "0 2px 8px rgba(30,64,175,.3)" },
    danger:  { background: h ? "rgba(220,38,38,.12)" : "rgba(220,38,38,.06)", color: "#dc2626", border: "1px solid rgba(220,38,38,.3)" },
    success: { background: h ? "rgba(22,163,74,.12)"  : "rgba(22,163,74,.06)",  color: "#16a34a", border: "1px solid rgba(22,163,74,.3)"  },
    ghost:   { background: h ? "#f1f5f9" : "#f8fafc", color: h ? "#0f172a" : "#334155", border: `1px solid ${h ? "#3b82f6" : "#e2e8f0"}` },
  };
  return (
    <button
      type="button"
      onClick={onClick} disabled={disabled} title={title}
      data-variant={variant}
      onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: pad, borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
        fontSize: fs, fontWeight: 600, fontFamily: "'Barlow',sans-serif",
        transition: "all .12s", opacity: disabled ? .55 : 1, whiteSpace: "nowrap",
        ...styles[variant], ...s,
      }}
    >{children}</button>
  );
}

// FF = MES form field (label + control + hint); `error` replaces the hint in red.
function FF({ label, children, hint, error, htmlFor }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <label htmlFor={htmlFor} style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#64748b" }}>{label}</label>
      {children}
      {error
        ? <span role="alert" style={{ fontSize: 11, fontWeight: 600, color: "#dc2626" }}>{error}</span>
        : hint && <span style={{ fontSize: 10, color: "#94a3b8" }}>{hint}</span>}
    </div>
  );
}

const inputStyle = {
  background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 8,
  padding: "10px 12px", color: "#0f172a", fontFamily: "'Barlow',sans-serif",
  fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box",
  transition: "border-color .15s, box-shadow .15s",
};
const monoInput = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 12.5 };
const lockedInput = { background: "#f1f5f9", color: "#64748b", cursor: "not-allowed" };

function Input({ invalid, ...props }) {
  const [f, setF] = useState(false);
  const bc = invalid ? "#dc2626" : f ? "#3b82f6" : "#e2e8f0";
  const sh = f ? (invalid ? "0 0 0 3px rgba(220,38,38,.1)" : "0 0 0 3px rgba(59,130,246,.1)") : "none";
  return (
    <input
      {...props}
      aria-invalid={invalid ? "true" : undefined}
      onFocus={() => setF(true)}
      onBlur={e => { setF(false); props.onBlur && props.onBlur(e); }}
      style={{ ...inputStyle, ...props.style, borderColor: bc, boxShadow: sh }}
    />
  );
}

function Select({ children, invalid, ...props }) {
  const [f, setF] = useState(false);
  return (
    <select
      {...props}
      onFocus={() => setF(true)} onBlur={() => setF(false)}
      style={{
        ...inputStyle, appearance: "none", cursor: "pointer",
        backgroundImage: "linear-gradient(45deg,transparent 50%,#64748b 50%),linear-gradient(135deg,#64748b 50%,transparent 50%)",
        backgroundPosition: "calc(100% - 17px) 50%, calc(100% - 12px) 50%",
        backgroundSize: "5px 5px, 5px 5px", backgroundRepeat: "no-repeat", paddingRight: 30,
        borderColor: invalid ? "#dc2626" : f ? "#3b82f6" : "#e2e8f0",
        boxShadow: f ? "0 0 0 3px rgba(59,130,246,.1)" : "none", ...props.style,
      }}
    >{children}</select>
  );
}

function Modal({ open, onClose, title, children, wide }) {
  useEffect(() => {
    const h = e => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div onClick={e => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", backdropFilter: "blur(4px)", zIndex: 500, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "48px 16px", overflowY: "auto" }}>
      <div role="dialog" aria-modal="true" aria-label={title}
        style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: wide ? 860 : 560, boxShadow: "0 24px 80px rgba(0,0,0,.2)", animation: "slideUp .22s cubic-bezier(.16,1,.3,1)", marginBottom: 40, overflow: "hidden" }}>
        <div style={{ padding: "18px 24px", background: "linear-gradient(135deg,#1e40af,#2563eb)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#fff" }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, borderRadius: 7, background: "rgba(255,255,255,.15)", border: "1px solid rgba(255,255,255,.25)", color: "#fff", cursor: "pointer", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>
        <div style={{ padding: 24 }}>{children}</div>
      </div>
    </div>
  );
}

function ModalActions({ children }) {
  return <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24, paddingTop: 20, borderTop: "1px solid #f1f5f9", flexWrap: "wrap" }}>{children}</div>;
}

function Toast({ msg, type, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []); // eslint-disable-line
  const colors = { ok: "#16a34a", err: "#dc2626", info: "#1e40af" };
  return (
    <div role="status" style={{
      position: "fixed", top: 24, right: 24, zIndex: 10001,
      padding: "12px 18px", borderRadius: 9, fontSize: 13, fontWeight: 500,
      background: "#fff", borderLeft: `4px solid ${colors[type] || colors.info}`,
      boxShadow: "0 8px 30px rgba(0,0,0,.15)", color: colors[type] || colors.info,
      animation: "slideDown .2s ease", maxWidth: 340, fontFamily: "'Barlow',sans-serif",
    }}>{msg}</div>
  );
}

function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, type = "ok") => setToast({ msg, type, k: Date.now() }), []);
  const el = toast ? <Toast key={toast.k} msg={toast.msg} type={toast.type} onDone={() => setToast(null)} /> : null;
  return [show, el];
}

function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60 }}>
      <div style={{ width: 32, height: 32, borderRadius: "50%", border: "3px solid #e2e8f0", borderTopColor: "#1e40af", animation: "spin .6s linear infinite" }} />
    </div>
  );
}

// Amber / blue notice box — same shape as the MES line-config notices.
function Notice({ tone = "amber", children, style }) {
  const t = tone === "amber"
    ? { bg: "rgba(217,119,6,.06)", bd: "rgba(217,119,6,.3)", fg: "#b45309" }
    : { bg: "rgba(30,64,175,.04)", bd: "rgba(30,64,175,.15)", fg: "#1e40af" };
  return (
    <div style={{ background: t.bg, border: `1px solid ${t.bd}`, borderRadius: 9, padding: "10px 14px", fontSize: 12, color: t.fg, lineHeight: 1.5, ...style }}>
      {children}
    </div>
  );
}

// ─── Validation (MES style: required, IPv4, parseInt port 1-65535, >= 0) ───
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const isInt = v => /^\d+$/.test(String(v ?? "").trim());
const isNum = v => String(v ?? "").trim() !== "" && Number.isFinite(Number(v));

function intIn(v, lo, hi, label) {
  if (String(v ?? "").trim() === "") return `${label} is required`;
  if (!isInt(v)) return `${label} must be a whole number`;
  const n = parseInt(v, 10);
  if (n < lo || n > hi) return `${label} must be ${lo}-${hi}`;
  return null;
}

function validate(f) {
  const e = {};
  if (!String(f.name || "").trim()) e.name = "Name is required";
  const ip = String(f.ip || "").trim();
  if (!ip) e.ip = "IP address is required";
  else if (!IPV4_RE.test(ip)) e.ip = "Enter a valid IPv4 address, e.g. 192.168.30.251";
  const port = String(f.port ?? "").trim();
  if (!isInt(port) || parseInt(port, 10) < 1 || parseInt(port, 10) > 65535) e.port = "Port must be an integer 1-65535";
  const path = String(f.rtsp_path || "").trim();
  if (path && !path.startsWith("/")) e.rtsp_path = "Path must start with /";
  else if (/\s/.test(path)) e.rtsp_path = "Path cannot contain spaces";
  if (!String(f.username || "").trim()) e.username = "Username is required";
  if (!String(f.assigned_machine || "").trim()) e.assigned_machine = "Select a machine";
  if (!String(f.codec || "").trim()) e.codec = "Select a codec";
  if (!String(f.resolution || "").trim()) e.resolution = "Select a resolution";
  const fps = intIn(f.fps, 1, 60, "FPS"); if (fps) e.fps = fps;
  const br = intIn(f.bitrate_kbps, 1, 20000, "Bitrate"); if (br) e.bitrate_kbps = br;
  const gop = intIn(f.iframe_interval, 1, 400, "I-frame interval"); if (gop) e.iframe_interval = gop;
  const sp = String(f.video_save_path || "").trim();
  if (!sp) e.video_save_path = "Video save path is required";
  else if (!(sp.startsWith("/") || /^[A-Za-z]:[\\/]/.test(sp))) e.video_save_path = "Enter an absolute folder path";
  const rd = intIn(f.retention_days, 1, 365, "Retention"); if (rd) e.retention_days = rd;
  for (const [k, label] of [["pre_roll_s", "Pre-roll"], ["post_roll_s", "Post-roll"]]) {
    if (!isNum(f[k])) e[k] = `${label} is required`;
    else if (Number(f[k]) < 0) e[k] = `${label} must be 0 or more`;
    else if (Number(f[k]) > 60) e[k] = `${label} must be 60 s or less`;
  }
  return e;
}

// Form values are kept as strings while editing; convert on save.
function toPayload(f) {
  return {
    ...f,
    camera_id: DEFAULTS.camera_id,
    name: String(f.name || "").trim(),
    ip: String(f.ip || "").trim(),
    port: parseInt(f.port, 10),
    rtsp_path: String(f.rtsp_path || "").trim(),
    username: String(f.username || "").trim(),
    password: f.password ? f.password : null,          // null = keep stored password
    recording_enabled: !!f.recording_enabled,
    fps: parseInt(f.fps, 10),
    bitrate_kbps: parseInt(f.bitrate_kbps, 10),
    iframe_interval: parseInt(f.iframe_interval, 10),
    video_save_path: String(f.video_save_path || "").trim(),
    retention_days: parseInt(f.retention_days, 10),
    pre_roll_s: Number(f.pre_roll_s),
    post_roll_s: Number(f.post_roll_s),
  };
}

// Server object → editable form (never echo a stored password into the field).
function fromServer(obj) {
  const src = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  const f = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (src[k] !== undefined && src[k] !== null) f[k] = src[k];
  f.camera_id = DEFAULTS.camera_id;
  f.password = "";
  f.recording_enabled = src.recording_enabled === undefined ? DEFAULTS.recording_enabled : !!src.recording_enabled;
  const stored = !!(src.password_set || src.has_password || (typeof src.password === "string" && src.password.length));
  return { form: f, storedPw: stored };
}

const sig = f => JSON.stringify(Object.keys(DEFAULTS).map(k => k === "password" ? (f.password ? "*" : "") : String(f[k] ?? "")));

function rtspUrl(f) {
  const ip = String(f.ip || "").trim() || "<ip>";
  const user = String(f.username || "").trim();
  const port = String(f.port ?? "").trim() || "554";
  const path = String(f.rtsp_path || "").trim();
  return `rtsp://${user ? `${user}:****@` : ""}${ip}:${port}${path}`;
}

const PAGE_CSS = `
  @keyframes slideUp   { from { transform:translateY(18px);opacity:0 } to { transform:none;opacity:1 } }
  @keyframes slideDown { from { transform:translateY(-18px);opacity:0 } to { transform:none;opacity:1 } }
  @keyframes spin { to { transform:rotate(360deg) } }
  .cc-body { padding:30px 40px 0; max-width:1180px; margin:0 auto; box-sizing:border-box; }
  .cc-row2  { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(0,1fr); gap:18px; margin-bottom:18px; align-items:start; }
  .cc-row2b { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:18px; margin-bottom:18px; align-items:start; }
  .cc-grid2 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; }
  .cc-grid3 { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1fr); gap:16px; }
  .cc-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  @media (max-width: 980px) {
    .cc-row2, .cc-row2b { grid-template-columns:minmax(0,1fr); }
  }
  @media (max-width: 600px) {
    .cc-body { padding:18px 12px 0; }
    .cc-grid2, .cc-grid3 { grid-template-columns:minmax(0,1fr); }
    .cc-card { padding:18px !important; }
    .cc-topbar > div > div:last-child { font-size:24px !important; left:auto !important; right:14px; transform:none !important; }
    .cc-stats > div { flex:1 1 40%; }
  }
`;

const TH = { padding: "8px 14px", textAlign: "left", fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "#94a3b8", borderBottom: "1px solid #f1f5f9", whiteSpace: "nowrap" };
const TD = { padding: "11px 14px", whiteSpace: "nowrap" };

// ─── Page ─────────────────────────────────────────────────────
export default function CameraConfig() {
  const [toast, toastEl] = useToast();
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState("server");        // "server" | "defaults"
  const [saved, setSaved] = useState(() => ({ ...DEFAULTS }));
  const [form, setForm] = useState(() => ({ ...DEFAULTS }));
  const [storedPw, setStoredPw] = useState(false);
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [clipErr, setClipErr] = useState(false);
  const [previewTab, setPreviewTab] = useState("live");   // "live" | "sample"
  const { data: live } = useCollector(2000);
  const camState = live?.camera?.state;

  useEffect(() => { document.title = "Camera Configuration"; }, []);

  useEffect(() => {
    const ac = new AbortController();
    (async () => {
      try {
        const r = await fetch(API_CAMERA, { signal: ac.signal, headers: { Accept: "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length) throw new Error("empty");
        const { form: f, storedPw: sp } = fromServer(data);
        setSaved(f); setForm(f); setStoredPw(sp); setSource("server");
      } catch (e) {
        if (e?.name === "AbortError") return;
        setSaved({ ...DEFAULTS }); setForm({ ...DEFAULTS }); setStoredPw(false); setSource("defaults");
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, []);

  const errors = useMemo(() => validate(form), [form]);
  const errCount = Object.keys(errors).length;
  const errOf = k => (submitted || touched[k]) ? errors[k] : undefined;
  const dirty = sig(form) !== sig(saved);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const touch = k => () => setTouched(t => (t[k] ? t : { ...t, [k]: true }));

  const save = async () => {
    setSubmitted(true);
    const errs = validate(form);
    const n = Object.keys(errs).length;
    if (n) {
      toast(n === 1 ? Object.values(errs)[0] : `Fix the ${n} highlighted fields before saving`, "err");
      return;
    }
    setSaving(true);
    const payload = toPayload(form);
    try {
      const r = await fetch(API_CAMERA, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      let body = null;
      try { body = await r.json(); } catch { body = null; }
      if (!r.ok) {
        const d = body?.detail ?? body?.error;
        const msg = typeof d === "string" ? d : Array.isArray(d) ? (d[0]?.msg || "Validation failed") : `Save failed (HTTP ${r.status})`;
        throw new Error(msg);
      }
      const usable = body && typeof body === "object" && !Array.isArray(body) && body.camera_id !== undefined;
      const { form: f, storedPw: sp } = fromServer(usable ? body : payload);
      setSaved(f); setForm(f);
      setStoredPw(sp || storedPw || !!payload.password);
      setSource("server"); setSubmitted(false); setTouched({});
      toast("Saved");
    } catch (e) {
      toast(e?.message && e.message !== "Failed to fetch" ? e.message : "Save failed — demo server not reachable", "err");
    } finally { setSaving(false); }
  };

  const doReset = () => {
    setForm({ ...DEFAULTS });
    setSubmitted(false); setTouched({});
    setConfirmReset(false);
    toast("Defaults restored — press Save to keep them", "info");
  };

  const recOn = !!form.recording_enabled;
  const savedRecOn = !!saved.recording_enabled;
  const isH265 = form.codec === "H.265";
  const withCurrent = (list, v) => (!v || list.includes(v) ? list : [...list, v]);
  const resOptions = withCurrent(RESOLUTIONS, form.resolution);
  const codecOptions = withCurrent(CODECS, form.codec);
  const machineOptions = withCurrent(MACHINES, form.assigned_machine);
  const savedIp = String(saved.ip || "").trim();
  const ipSet = !!String(form.ip || "").trim();
  const fpsN = parseInt(form.fps, 10);
  const gopN = parseInt(form.iframe_interval, 10);

  const actions = (
    <>
      <Btn onClick={() => setConfirmReset(true)} disabled={saving || loading}>Reset to defaults</Btn>
      <Btn variant="primary" onClick={save} disabled={saving || loading}>{saving ? "Saving…" : "Save"}</Btn>
    </>
  );

  return (
    <div style={{ ...pageWrap, minHeight: "100vh" }}>
      <style>{PAGE_CSS}</style>
      <div className="cc-topbar"><PageTopbar leading="Camera" accent="Configuration" /></div>

      <div className="cc-body">
        {/* Heading row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 10, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: COLORS.text }}>Station Camera</div>
              {!loading && (dirty
                ? <Pill label="Unsaved changes" color="amber" />
                : source === "defaults"
                  ? <Pill label="Default values — not saved yet" color="gray" />
                  : <Pill label="Saved" color="green" />)}
            </div>
            <div style={{ fontSize: 11, color: COLORS.textMut, marginTop: 2, maxWidth: 760, lineHeight: 1.5 }}>
              Camera that records cycle clips for the demo station. The demo server connects to it for the live
              preview and records one clip per PLC cycle (shown on MANAGEMENT-2).
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>
        </div>

        {/* Stats (CameraListPage style) */}
        <div className="cc-stats" style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
          {[
            { label: "Cameras",    val: 1, color: "#1e40af" },
            { label: "Recording",  val: savedRecOn ? "ON" : "OFF", color: savedRecOn ? "#16a34a" : "#64748b" },
            { label: "Codec",      val: saved.codec || "—", color: saved.codec === "H.265" ? "#d97706" : "#7c3aed" },
            { label: "Frame rate", val: `${saved.fps ?? "—"} fps`, color: "#0891b2" },
            { label: "Retention",  val: `${saved.retention_days ?? "—"} d`, color: "#d97706" },
          ].map(({ label, val, color }) => (
            <div key={label} style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: "12px 18px", minWidth: 100, boxSizing: "border-box" }}>
              <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color, whiteSpace: "nowrap" }}>{val}</div>
            </div>
          ))}
        </div>

        {/* Camera table (CameraListPage style) */}
        <Card style={{ padding: 0, overflow: "hidden", marginBottom: 18 }}>
          <div style={{ padding: "12px 16px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>◎</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>Demo Zone</span>
            <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: 4 }}>1 camera</span>
          </div>
          <div style={{ padding: "8px 16px 6px", fontSize: 11, fontWeight: 700, color: "#1e40af", letterSpacing: ".06em", textTransform: "uppercase", borderBottom: "1px solid #f1f5f9" }}>
            Demo Line
          </div>
          {loading ? <Spinner /> : (
            <div className="cc-table-wrap">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>{["Camera ID", "Name", "IP : Port", "Assigned Machine", "Recording", "Status"].map(h => <th key={h} style={TH}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  <tr style={{ borderBottom: "1px solid #f8fafc" }}>
                    <td style={{ ...TD, fontFamily: "monospace", fontWeight: 700, color: "#7c3aed", fontSize: 11 }}>{saved.camera_id || DEFAULTS.camera_id}</td>
                    <td style={{ ...TD, fontWeight: 600, color: "#0f172a" }}>{saved.name || "—"}</td>
                    <td style={{ ...TD, fontFamily: "monospace", fontWeight: 700, fontSize: 11, color: "#7c3aed" }}>
                      {savedIp ? `${savedIp}:${saved.port}` : <span style={{ color: "#d97706", fontWeight: 600 }}>IP not set</span>}
                    </td>
                    <td style={TD}>
                      <span style={{ padding: "2px 9px", borderRadius: 99, fontSize: 10, fontWeight: 700, background: "rgba(22,163,74,.1)", color: "#16a34a" }}>
                        {saved.assigned_machine || "—"}
                      </span>
                    </td>
                    <td style={TD}><Pill label={savedRecOn ? "ON" : "OFF"} color={savedRecOn ? "green" : "gray"} /></td>
                    <td style={TD}>
                      <Pill label={{ streaming: "Live", connecting: "Connecting", error: "Not connected", idle: "Idle",
                                     not_configured: "IP not set", no_ffmpeg: "No ffmpeg" }[camState] || "…"}
                            color={camState === "streaming" ? "green" : camState === "error" ? "red" : camState === "idle" ? "gray" : "amber"} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Editor + Preview */}
        <div className="cc-row2">
          <Card className="cc-card">
            <CardTitle title="Camera" sub="Connection details used by the recorder. Leave the password blank to keep the stored one." />

            {!ipSet ? (
              <Notice tone="amber" style={{ marginBottom: 18 }}>
                <strong>Set the camera's IP.</strong> The demo server needs it for the live preview and cycle clips.
              </Notice>
            ) : (
              <Notice tone="blue" style={{ marginBottom: 18 }}>
                The demo server keeps one RTSP stream open to this camera; it feeds both the live preview and the cycle clips.
              </Notice>
            )}

            {/* Recording toggle — MES "Camera Recording" banner */}
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", marginBottom: 18, borderRadius: 9,
                          border: `1.5px solid ${recOn ? "rgba(22,163,74,.35)" : "rgba(217,119,6,.45)"}`,
                          background: recOn ? "rgba(22,163,74,.06)" : "rgba(217,119,6,.06)" }}>
              <span style={{ fontSize: 20 }} aria-hidden="true">{recOn ? "🎥" : "🚫"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "#0f172a" }}>
                  Camera Recording — <span style={{ color: recOn ? "#16a34a" : "#d97706" }}>{recOn ? "ON" : "OFF"}</span>
                </div>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                  {recOn
                    ? "Turn OFF to stop recording clips for this camera. Cycle counting is unaffected."
                    : "No clips are recorded for this camera. Turn ON to record. Cycle counting is unaffected."}
                </div>
              </div>
              <button
                type="button" role="switch" aria-checked={recOn} aria-label="Camera recording"
                onClick={() => set("recording_enabled", !recOn)}
                title={recOn ? "Turn recording OFF" : "Turn recording ON"}
                style={{ position: "relative", width: 60, height: 30, borderRadius: 999, border: "none", flexShrink: 0, cursor: "pointer",
                         background: recOn ? "#16a34a" : "#cbd5e1", transition: "background .15s" }}
              >
                <span style={{ position: "absolute", top: 3, left: recOn ? 33 : 3, width: 24, height: 24, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.3)", transition: "left .15s" }} />
              </button>
            </div>

            <div className="cc-grid2" style={{ marginBottom: 16 }}>
              <FF label="Camera ID" hint="Fixed for this demo" htmlFor="cc-id">
                <Input id="cc-id" value={form.camera_id} readOnly disabled style={{ ...monoInput, ...lockedInput }} />
              </FF>
              <FF label="Name *" error={errOf("name")} htmlFor="cc-name">
                <Input id="cc-name" value={form.name} onChange={e => set("name", e.target.value)} onBlur={touch("name")}
                       placeholder="e.g. Station camera" invalid={!!errOf("name")} maxLength={60} />
              </FF>
              <FF label="IP Address *" error={errOf("ip")} hint="Required to save" htmlFor="cc-ip">
                <Input id="cc-ip" value={form.ip} onChange={e => set("ip", e.target.value)} onBlur={touch("ip")}
                       placeholder="e.g. 192.168.30.251" invalid={!!errOf("ip")} inputMode="decimal" autoComplete="off" spellCheck={false}
                       style={monoInput} />
              </FF>
              <FF label="RTSP Port *" error={errOf("port")} hint="Default 554" htmlFor="cc-port">
                <Input id="cc-port" type="number" min={1} max={65535} step={1} value={form.port}
                       onChange={e => set("port", e.target.value)} onBlur={touch("port")} invalid={!!errOf("port")} style={monoInput} />
              </FF>
              <FF label="RTSP Path" error={errOf("rtsp_path")} hint="Main stream, e.g. /h264/ch1/main/av_stream" htmlFor="cc-path">
                <Input id="cc-path" value={form.rtsp_path} onChange={e => set("rtsp_path", e.target.value)} onBlur={touch("rtsp_path")}
                       placeholder="/h264/ch1/main/av_stream" invalid={!!errOf("rtsp_path")} spellCheck={false} style={monoInput} />
              </FF>
              <FF label="Assigned Machine *" error={errOf("assigned_machine")} htmlFor="cc-mach">
                <Select id="cc-mach" value={form.assigned_machine} onChange={e => set("assigned_machine", e.target.value)} invalid={!!errOf("assigned_machine")}>
                  {machineOptions.map(m => <option key={m} value={m}>{m}</option>)}
                </Select>
              </FF>
              <FF label="Username *" error={errOf("username")} htmlFor="cc-user">
                <Input id="cc-user" value={form.username} onChange={e => set("username", e.target.value)} onBlur={touch("username")}
                       invalid={!!errOf("username")} autoComplete="off" spellCheck={false} />
              </FF>
              <FF label="Password" hint="Leave blank to keep the stored password" htmlFor="cc-pass">
                <Input id="cc-pass" type="password" value={form.password} onChange={e => set("password", e.target.value)}
                       placeholder={storedPw ? "•••••••• (stored)" : "unchanged"} autoComplete="new-password" />
              </FF>
            </div>

            <FF label="Generated RTSP URL" hint="Read-only. The password is never shown.">
              <div style={{ ...inputStyle, ...monoInput, background: "#f1f5f9", color: ipSet ? "#334155" : "#94a3b8", wordBreak: "break-all" }}>
                {rtspUrl(form)}
              </div>
            </FF>
          </Card>

          <Card className="cc-card">
            <CardTitle title="Preview" sub="Live picture from the camera, or a clip already recorded by the demo server."
              right={
                <div style={{ display: "inline-flex", border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
                  {[["live", "Live"], ["sample", "Recorded clip"]].map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setPreviewTab(k)}
                      style={{ padding: "5px 12px", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700,
                               background: previewTab === k ? "#1e40af" : "#f8fafc", color: previewTab === k ? "#fff" : "#334155" }}>
                      {label}
                    </button>
                  ))}
                </div>
              } />
            {previewTab === "live" ? (
              savedIp ? <CameraLive /> : (
                <Notice tone="amber">Save the camera's IP first; the live preview uses the saved settings.</Notice>
              )
            ) : (
              <>
                <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", background: "#0f172a", borderRadius: 10, overflow: "hidden", border: "1px solid #e2e8f0" }}>
                  {!clipErr ? (
                    <video
                      controls preload="metadata" playsInline muted
                      src={SAMPLE_CLIP}
                      onError={() => setClipErr(true)}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", background: "#0f172a", display: "block" }}
                    />
                  ) : (
                    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, color: "#94a3b8", textAlign: "center", padding: 16 }}>
                      <div style={{ fontSize: 34, opacity: .35 }}>▶</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#cbd5e1" }}>Sample clip not available</div>
                      <div style={{ fontSize: 11 }}>The demo server has no recorded clip to play.</div>
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#64748b", fontWeight: 600 }}>Recorded sample clip (not a live stream)</span>
                  <Pill label="Recorded" color="gray" />
                </div>
              </>
            )}
            <div style={{ marginTop: 14, padding: "10px 12px", background: "#f8fafc", border: "1px solid #f1f5f9", borderRadius: 9, fontSize: 11, color: "#64748b", lineHeight: 1.7 }}>
              <div><span style={{ color: "#94a3b8" }}>Camera:</span> <b style={{ color: "#0f172a" }}>{saved.name || "—"}</b> <span style={{ fontFamily: "monospace", color: "#7c3aed" }}>{saved.camera_id}</span></div>
              <div><span style={{ color: "#94a3b8" }}>Machine:</span> <b style={{ color: "#0f172a" }}>{saved.assigned_machine || "—"}</b></div>
              <div><span style={{ color: "#94a3b8" }}>Stream:</span> {saved.codec} · {saved.resolution} · {saved.fps} fps · {saved.bitrate_kbps} kbps CBR</div>
            </div>
          </Card>
        </div>

        {/* Stream + Clip settings */}
        <div className="cc-row2b">
          <Card className="cc-card">
            <CardTitle title="Stream settings" sub="Configured on the camera itself (camera web page). Shown here as the recommended values for clip recording." />
            <div className="cc-grid2">
              <FF label="Codec *" error={errOf("codec")} htmlFor="cc-codec">
                <Select id="cc-codec" value={form.codec} onChange={e => set("codec", e.target.value)} invalid={!!errOf("codec")}>
                  {codecOptions.map(c => <option key={c} value={c}>{c}</option>)}
                </Select>
              </FF>
              <FF label="Resolution *" error={errOf("resolution")} htmlFor="cc-res">
                <Select id="cc-res" value={form.resolution} onChange={e => set("resolution", e.target.value)} invalid={!!errOf("resolution")}>
                  {resOptions.map(r => <option key={r} value={r}>{r}</option>)}
                </Select>
              </FF>
              {isH265 && (
                <Notice tone="amber" style={{ gridColumn: "1 / -1" }}>
                  <strong>Browsers cannot play H.265 everywhere.</strong> Use H.264 so every PC can play the clips.
                </Notice>
              )}
              <FF label="Frame rate (fps) *" error={errOf("fps")} hint="Recommended 25" htmlFor="cc-fps">
                <Input id="cc-fps" type="number" min={1} max={60} step={1} value={form.fps}
                       onChange={e => set("fps", e.target.value)} onBlur={touch("fps")} invalid={!!errOf("fps")} />
              </FF>
              <FF label="Bitrate (kbps, CBR) *" error={errOf("bitrate_kbps")} hint="Constant bitrate, recommended 2000" htmlFor="cc-br">
                <Input id="cc-br" type="number" min={1} max={20000} step={1} value={form.bitrate_kbps}
                       onChange={e => set("bitrate_kbps", e.target.value)} onBlur={touch("bitrate_kbps")} invalid={!!errOf("bitrate_kbps")} />
              </FF>
              <FF label="I-frame interval *" error={errOf("iframe_interval")} hint="Frames between key frames" htmlFor="cc-gop">
                <Input id="cc-gop" type="number" min={1} max={400} step={1} value={form.iframe_interval}
                       onChange={e => set("iframe_interval", e.target.value)} onBlur={touch("iframe_interval")} invalid={!!errOf("iframe_interval")} />
              </FF>
              <div style={{ display: "flex", alignItems: "flex-start", paddingTop: 22, minWidth: 0 }}>
                <Notice tone="blue" style={{ width: "100%", boxSizing: "border-box" }}>
                  {isInt(form.fps) && isInt(form.iframe_interval) && fpsN > 0
                    ? (gopN === fpsN
                        ? "One key frame per second. Clips start within 1 s of the cycle."
                        : `One key frame every ${(gopN / fpsN).toFixed(1)} s. Set equal to fps for 1 s.`)
                    : "Set fps and I-frame interval to the same value."}
                </Notice>
              </div>
            </div>
          </Card>

          <Card className="cc-card">
            <CardTitle title="Clip settings" sub="Where cycle clips are saved and how long they are kept." />
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <FF label="Video save path *" error={errOf("video_save_path")} hint="Cycle clips save as <path>/live/cycle_<no>.mp4 on the demo server PC" htmlFor="cc-vpath">
                <Input id="cc-vpath" value={form.video_save_path} onChange={e => set("video_save_path", e.target.value)} onBlur={touch("video_save_path")}
                       placeholder="/home/server/mes-demo-5000/clips" invalid={!!errOf("video_save_path")} spellCheck={false} style={monoInput} />
              </FF>
              <div className="cc-grid3">
                <FF label="Retention (days) *" error={errOf("retention_days")} hint="1-365" htmlFor="cc-ret">
                  <Input id="cc-ret" type="number" min={1} max={365} step={1} value={form.retention_days}
                         onChange={e => set("retention_days", e.target.value)} onBlur={touch("retention_days")} invalid={!!errOf("retention_days")} />
                </FF>
                <FF label="Pre-roll (s) *" error={errOf("pre_roll_s")} hint="Before cycle start" htmlFor="cc-pre">
                  <Input id="cc-pre" type="number" min={0} max={60} step={0.5} value={form.pre_roll_s}
                         onChange={e => set("pre_roll_s", e.target.value)} onBlur={touch("pre_roll_s")} invalid={!!errOf("pre_roll_s")} />
                </FF>
                <FF label="Post-roll (s) *" error={errOf("post_roll_s")} hint="After cycle end" htmlFor="cc-post">
                  <Input id="cc-post" type="number" min={0} max={60} step={0.5} value={form.post_roll_s}
                         onChange={e => set("post_roll_s", e.target.value)} onBlur={touch("post_roll_s")} invalid={!!errOf("post_roll_s")} />
                </FF>
              </div>
              <Notice tone="blue">
                Clips older than <strong>{isInt(form.retention_days) ? parseInt(form.retention_days, 10) : "—"} days</strong> are deleted.
                Each clip covers the cycle plus {isNum(form.pre_roll_s) ? Number(form.pre_roll_s) : "—"} s before and {isNum(form.post_roll_s) ? Number(form.post_roll_s) : "—"} s after.
              </Notice>
            </div>
          </Card>
        </div>

        {/* Footer actions */}
        <Card style={{ padding: "16px 22px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: submitted && errCount ? "#dc2626" : dirty ? "#d97706" : "#64748b" }}>
            {submitted && errCount
              ? `${errCount} field${errCount > 1 ? "s" : ""} need${errCount > 1 ? "" : "s"} attention`
              : dirty ? "You have unsaved changes."
              : source === "defaults" ? "Default values shown. Set the IP and press Save to store them."
              : "No unsaved changes."}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{actions}</div>
        </Card>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset to defaults">
        <div style={{ fontSize: 13, color: "#334155", lineHeight: 1.6 }}>
          All fields return to their default values. The IP address is cleared and must be set again.
          Nothing is stored until you press <strong>Save</strong>.
        </div>
        <ModalActions>
          <Btn onClick={() => setConfirmReset(false)}>Cancel</Btn>
          <Btn variant="danger" onClick={doReset}>Reset</Btn>
        </ModalActions>
      </Modal>

      {toastEl}
    </div>
  );
}
