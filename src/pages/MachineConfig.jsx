// MachineConfig.jsx — standalone demo clone of the MES machine editor
// (AdminPanel.jsx → MachinesPage: ① Machines / ② PLC Config / ③ Monitor Config).
//
// The demo holds exactly ONE machine. Everything is stored by the demo's own
// server (GET/PUT /api/demo/machine). The server's collector reads this PLC
// (read only); tab ④ shows what it reads (GET /api/demo/collector).
import { useState, useEffect, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import PageTopbar from "../components/PageTopbar";
import { COLORS, thStyle, tdStyle } from "../components/whiteTheme";
import { CollectorLive, useCollector } from "../components/LivePanels";

const API_URL = "/api/demo/machine";

// Fixed cascade values (selectors are shown locked — one machine only).
const ZONE_NAME = "Demo";
const LINE_NAME = "Nut-Runner Demo";
const DEFAULT_MACHINE_NAME = "Nut-Runner Demo Station";

const PLC_MODELS = [
  "Mitsubishi FX5U-32MT/ESS",
  "Mitsubishi FX5U-64MT/ESS",
  "Mitsubishi FX5UC",
  "Mitsubishi FX5UJ",
];
const PROTOCOLS = ["SLMP 3E (binary)", "SLMP 4E (binary)", "MC 3E ASCII"];
const MAX_DATA_REGS = 15;

// Andon (loss) registers: a value other than 0 puts that loss on the shift timeline.
const ANDON_FIELDS = [
  { key: "andon_maintenance", label: "Maintenance",  status: "Breakdown",   def: "D100" },
  { key: "andon_quality",     label: "Quality",      status: "Quality",     def: "D200" },
  { key: "andon_material",    label: "Material",     status: "Material",    def: "D300" },
  { key: "andon_setup",       label: "Setup",        status: "Setup",       def: "D400" },
  { key: "andon_change_over", label: "Change Over",  status: "Change Over", def: "D500" },
  { key: "andon_others",      label: "Other Losses", status: "Others",      def: "D600" },
];

// ─── Defaults for the demo station ────────────────────────────
const DEFAULTS = {
  machine_name: DEFAULT_MACHINE_NAME,
  plc_model: "Mitsubishi FX5U-32MT/ESS",
  plc_ip: "192.168.30.10",
  plc_port: 5000,
  protocol: "SLMP 3E (binary)",
  count_mode: "bit",
  ok_bit_address: "L108",
  ng_bit_address: "L109",
  ok_data_register: "D101",
  ng_data_register: "D102",
  shift_reset_bit: "L110",
  status_address: "",
  ...Object.fromEntries(ANDON_FIELDS.map(a => [a.key, a.def])),
  ct_register: "D103",          // PLC-measured cycle time; blank = time between OK/NG signals
  ct_register_scale: 0.1,
  ideal_cycle_time: 10.0,
  max_allowed_cycle: 40.0,
  ok_ng_pulse_min_gap: 0.5,
  nf2_camera_id: "CAM-01",
  machine_seq: 0,
  monitor_registers: [
    { register: "D103", content: "Last cycle time",           unit: "0.1 s",            example: "245 → 24.5 s" },
    { register: "D104", content: "Direction",                 unit: "1 = A→B, 2 = B→A", example: "1 → A→B" },
    { register: "D105", content: "NG reason code",            unit: "Code",             example: "Raw code" },
    { register: "D106", content: "Cycle sequence",            unit: "Count",            example: "1287" },
    { register: "D107", content: "Target cycle time",         unit: "0.1 s",            example: "200 → 20.0 s" },
    { register: "D109", content: "Final torque",              unit: "0.01 Nm",          example: "1350 → 13.50 Nm" },
    { register: "D110", content: "Breakaway torque",          unit: "0.01 Nm",          example: "1420 → 14.20 Nm" },
    { register: "D111", content: "Torque low limit",          unit: "0.01 Nm",          example: "Default 1200 → 12.00 Nm" },
    { register: "D112", content: "Torque high limit",         unit: "0.01 Nm",          example: "Default 1500 → 15.00 Nm" },
    { register: "D114", content: "Torque flags",              unit: "Bitmask",          example: "One flag per bit" },
    { register: "D118", content: "Torque sequence handshake", unit: "Counter",          example: "Changes on each tightening" },
  ],
  inputs: [
    { type: "digital", address: "X0",  signal: "Gun in stand",    note: "M18 inductive sensor" },
    { type: "digital", address: "X1",  signal: "Nut seated A",    note: "" },
    { type: "digital", address: "X2",  signal: "Nut seated B",    note: "" },
    { type: "digital", address: "X3",  signal: "Torque OK",       note: "" },
    { type: "digital", address: "X4",  signal: "Torque NG",       note: "" },
    { type: "digital", address: "X5",  signal: "Gun running",     note: "" },
    { type: "digital", address: "X6",  signal: "Reset",           note: "" },
    { type: "digital", address: "X7",  signal: "E-stop healthy",  note: "" },
    { type: "digital", address: "X10", signal: "Calibration mode", note: "" },
    { type: "analog",  address: "FX5-4AD CH1", signal: "Torque A", note: "±10 V = ±30 Nm" },
    { type: "analog",  address: "FX5-4AD CH2", signal: "Torque B", note: "±10 V = ±30 Nm" },
  ],
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const str = (v) => (v == null ? "" : String(v));

// Accept whatever shape the server returns and fold it onto DEFAULTS so the
// form always has every field (unknown keys are kept and sent back on save).
function normalize(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const d = clone(DEFAULTS);
  const out = { ...d, ...src };
  for (const k of Object.keys(d)) {
    if (k === "monitor_registers" || k === "inputs") continue;
    if (out[k] === undefined) out[k] = d[k];
  }
  out.count_mode = out.count_mode === "register" ? "register" : "bit";

  out.monitor_registers = Array.isArray(src.monitor_registers)
    ? src.monitor_registers.map(r => ({
        register: str(r?.register ?? r?.address),
        content:  str(r?.content ?? r?.label ?? r?.name),
        unit:     str(r?.unit ?? r?.scale),
        example:  str(r?.example),
      }))
    : d.monitor_registers;

  let inputs = src.inputs;
  if (inputs && !Array.isArray(inputs) && typeof inputs === "object") {
    inputs = [
      ...(Array.isArray(inputs.digital) ? inputs.digital.map(x => ({ ...x, type: "digital" })) : []),
      ...(Array.isArray(inputs.analog)  ? inputs.analog.map(x  => ({ ...x, type: "analog"  })) : []),
    ];
  }
  out.inputs = Array.isArray(inputs)
    ? inputs.map(x => {
        const address = str(x?.address ?? x?.register ?? x?.channel);
        return {
          type:    x?.type === "analog" || x?.type === "digital" ? x.type : (/^X[0-7]+$/i.test(address) ? "digital" : "analog"),
          address,
          signal:  str(x?.signal ?? x?.label ?? x?.content ?? x?.name),
          note:    str(x?.note ?? x?.detail ?? x?.range ?? x?.unit),
        };
      })
    : d.inputs;
  return out;
}

const up = (v) => str(v).trim().toUpperCase();
const toInt = (v) => { const s = str(v).trim(); return s === "" ? null : parseInt(s, 10); };
const toNum = (v) => { const s = str(v).trim(); return s === "" ? null : parseFloat(s); };

// Form → the full object PUT to the server.
function toPayload(f) {
  return {
    ...f,
    machine_name:        str(f.machine_name).trim(),
    plc_ip:              str(f.plc_ip).trim(),
    plc_port:            toInt(f.plc_port),
    ok_bit_address:      up(f.ok_bit_address),
    ng_bit_address:      up(f.ng_bit_address),
    ok_data_register:    up(f.ok_data_register),
    ng_data_register:    up(f.ng_data_register),
    shift_reset_bit:     up(f.shift_reset_bit),
    status_address:      up(f.status_address),
    ...Object.fromEntries(ANDON_FIELDS.map(a => [a.key, up(f[a.key])])),
    ct_register:         up(f.ct_register),
    ct_register_scale:   toNum(f.ct_register_scale),
    ideal_cycle_time:    toNum(f.ideal_cycle_time),
    max_allowed_cycle:   toNum(f.max_allowed_cycle),
    ok_ng_pulse_min_gap: toNum(f.ok_ng_pulse_min_gap),
    nf2_camera_id:       str(f.nf2_camera_id).trim(),
    machine_seq:         toInt(f.machine_seq),
    monitor_registers: f.monitor_registers.map(r => ({
      register: up(r.register), content: str(r.content).trim(), unit: str(r.unit).trim(), example: str(r.example),
    })),
    inputs: f.inputs.map(x => ({
      type: x.type, address: x.type === "digital" ? up(x.address) : str(x.address).trim(),
      signal: str(x.signal).trim(), note: str(x.note).trim(),
    })),
  };
}

// ─── Validation (same rules the MES forms apply, plus format checks) ───
const IP_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const WORD_DEVS = ["D", "W", "R", "SD", "ZR"];
const BIT_DEVS  = ["X", "Y", "M", "L", "B", "F", "SM"];

function deviceError(v, { required = true, kind = "any" } = {}) {
  const s = up(v);
  if (!s) return required ? "Required" : null;
  const m = s.match(/^(SM|SD|ZR|X|Y|M|L|B|F|D|W|R)([0-9A-F]+)$/);
  if (!m) return "Use a device address, e.g. D100 or L108";
  const [, dev, num] = m;
  if (kind === "bit"  && !BIT_DEVS.includes(dev))  return "Use a bit device (L, M, X, Y, B)";
  if (kind === "word" && !WORD_DEVS.includes(dev)) return "Use a word device (D, W, R)";
  if (dev === "X" || dev === "Y") {
    if (!/^[0-7]+$/.test(num)) return "X/Y addresses are octal (digits 0-7)";
  } else if (dev !== "B" && dev !== "W" && !/^\d+$/.test(num)) {
    return "Address number must be decimal";
  }
  return null;
}

function numberError(v, { required = true, integer = false, min = 0, max = null, label = "" } = {}) {
  const s = str(v).trim();
  if (s === "") return required ? "Required" : null;
  if (integer) {
    const n = parseInt(s, 10);
    if (!/^-?\d+$/.test(s) || Number.isNaN(n)) return "Enter a whole number";
    if (n < min || (max != null && n > max)) return max != null ? `${label || "Value"} must be ${min}-${max}` : `Must be ${min} or more`;
    return null;
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return "Enter a number";
  if (n < min) return `Must be ${min} or more`;
  return null;
}

function validate(f) {
  const e = {};
  const put = (k, msg) => { if (msg) e[k] = msg; };

  if (!str(f.machine_name).trim()) e.machine_name = "Machine name is required";
  const ip = str(f.plc_ip).trim();
  if (!ip) e.plc_ip = "PLC IP address is required";
  else if (!IP_RE.test(ip)) e.plc_ip = "Enter a valid IPv4 address, e.g. 192.168.30.250";
  else if (ip === "0.0.0.0" || ip === "255.255.255.255") e.plc_ip = "Not a usable host address";
  put("plc_port", numberError(f.plc_port, { integer: true, min: 1, max: 65535, label: "Port" }));
  if (!str(f.plc_model).trim()) e.plc_model = "Required";
  if (!str(f.protocol).trim()) e.protocol = "Required";
  put("ideal_cycle_time",    numberError(f.ideal_cycle_time));
  put("max_allowed_cycle",   numberError(f.max_allowed_cycle));
  put("ok_ng_pulse_min_gap", numberError(f.ok_ng_pulse_min_gap));
  put("machine_seq",         numberError(f.machine_seq, { required: false, integer: true, min: 0, max: 99, label: "Machine No." }));

  put("ok_bit_address", deviceError(f.ok_bit_address, { kind: "bit" }));
  put("ng_bit_address", deviceError(f.ng_bit_address, { kind: "bit" }));
  put("status_address", deviceError(f.status_address, { kind: "word", required: false }));
  const used = { [up(f.ct_register)]: "Cycle Time Register" };
  if (f.count_mode === "register") Object.assign(used, { [up(f.ok_data_register)]: "OK Data Register", [up(f.ng_data_register)]: "NG Data Register" });
  ANDON_FIELDS.forEach(a => {
    const err = deviceError(f[a.key], { kind: "word", required: false });
    const v = up(f[a.key]);
    if (err) e[a.key] = err;
    else if (v && used[v]) e[a.key] = `Already used by ${used[v]}`;
    else if (v) used[v] = `${a.label} andon`;
  });
  put("ct_register", deviceError(f.ct_register, { kind: "word", required: false }));
  if (str(f.ct_register).trim()) put("ct_register_scale", numberError(f.ct_register_scale));
  if (f.count_mode === "register") {
    put("ok_data_register", deviceError(f.ok_data_register, { kind: "word" }));
    put("ng_data_register", deviceError(f.ng_data_register, { kind: "word" }));
    put("shift_reset_bit",  deviceError(f.shift_reset_bit,  { kind: "bit", required: false }));
  }
  const cam = str(f.nf2_camera_id).trim();
  if (cam && !/^[A-Za-z0-9_.-]+$/.test(cam)) e.nf2_camera_id = "Letters, digits, - _ . only";

  const seenReg = {};
  f.monitor_registers.forEach((r, i) => {
    const regErr = deviceError(r.register, { kind: "word" });
    if (regErr) e[`reg.${i}.register`] = regErr;
    else {
      const k = up(r.register);
      if (seenReg[k] != null) e[`reg.${i}.register`] = `Duplicate of row ${seenReg[k] + 1}`;
      else seenReg[k] = i;
    }
    if (!str(r.content).trim()) e[`reg.${i}.content`] = "Required";
  });

  const seenX = {};
  f.inputs.forEach((x, i) => {
    if (x.type === "digital") {
      let err = deviceError(x.address);
      if (!err && !up(x.address).startsWith("X")) err = "Use an X input, e.g. X0";
      if (err) e[`in.${i}.address`] = err;
      else {
        const k = up(x.address);
        if (seenX[k] != null) e[`in.${i}.address`] = `Duplicate of ${k}`;
        else seenX[k] = i;
      }
    } else if (!str(x.address).trim()) {
      e[`in.${i}.address`] = "Required";
    }
    if (!str(x.signal).trim()) e[`in.${i}.signal`] = "Required";
  });
  return e;
}
const tabOfError = (k) => (k.startsWith("reg.") || k.startsWith("in.") ? 2 : 1);

// ─── Shared UI helpers (copied from MES AdminPanel.jsx) ───────
function Card({ children, style, className = "" }) {
  return (
    <div className={`mc-card ${className}`.trim()} style={{
      background: "#fff", border: "1px solid #e2e8f0", borderRadius: 14,
      padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,.05)", ...style,
    }}>
      {children}
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

function Btn({ children, onClick, variant = "ghost", size = "md", disabled = false, style: s }) {
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
      onClick={onClick} disabled={disabled}
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

function FF({ label, children, hint, style, className }) {
  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0, ...style }}>
      <label style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "#64748b" }}>{label}</label>
      {children}
      {hint && <span style={{ fontSize: 10, color: "#94a3b8" }}>{hint}</span>}
    </div>
  );
}

const inputStyle = {
  background: "#f8fafc", border: "1.5px solid #e2e8f0", borderRadius: 8,
  padding: "10px 12px", color: "#0f172a", fontFamily: "'Barlow',sans-serif",
  fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box",
  transition: "border-color .15s, box-shadow .15s",
};
// The machine editor's compact field style (MES: `mini`).
const mini = { ...inputStyle, padding: "8px 10px", fontSize: 12 };
const errBorder = { borderColor: "#dc2626", boxShadow: "0 0 0 3px rgba(220,38,38,.08)" };

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
      <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: wide ? 860 : 560, boxShadow: "0 24px 80px rgba(0,0,0,.2)", animation: "slideUp .22s cubic-bezier(.16,1,.3,1)", marginBottom: 40, overflow: "hidden" }}>
        <div style={{ padding: "18px 24px", background: "linear-gradient(135deg,#1e40af,#2563eb)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#fff", textTransform: "capitalize" }}>{title}</div>
          <button type="button" onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, background: "rgba(255,255,255,.15)", border: "1px solid rgba(255,255,255,.25)", color: "#fff", cursor: "pointer", fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
        </div>
        <div style={{ padding: 24 }}>{children}</div>
      </div>
      <style>{`
        @keyframes slideUp   { from { transform:translateY(18px);opacity:0 } to { transform:none;opacity:1 } }
        @keyframes slideDown { from { transform:translateY(-18px);opacity:0 } to { transform:none;opacity:1 } }
      `}</style>
    </div>
  );
}

function ModalActions({ children }) {
  return <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 24, paddingTop: 20, borderTop: "1px solid #f1f5f9", flexWrap: "wrap" }}>{children}</div>;
}

function Toast({ msg, type, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const colors = { ok: "#16a34a", err: "#dc2626", info: "#1e40af" };
  return (
    <div role="status" aria-live="polite" style={{
      position: "fixed", top: 24, right: 24, zIndex: 10001,
      padding: "12px 18px", borderRadius: 9, fontSize: 13, fontWeight: 500,
      background: "#fff", borderLeft: `4px solid ${colors[type] || colors.info}`,
      boxShadow: "0 8px 30px rgba(0,0,0,.15)", color: colors[type] || colors.info,
      animation: "slideDown .2s ease", maxWidth: 340, fontFamily: "'Barlow',sans-serif",
    }}>
      {msg}
    </div>
  );
}

function useToast() {
  const [toast, setToast] = useState(null);
  const show = useCallback((msg, type = "ok") => setToast({ msg, type, id: Date.now() }), []);
  const el = toast ? <Toast key={toast.id} msg={toast.msg} type={toast.type} onDone={() => setToast(null)} /> : null;
  return [show, el];
}

function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 60 }}>
      <div style={{ width: 32, height: 32, borderRadius: "50%", border: "3px solid #e2e8f0", borderTopColor: "#1e40af", animation: "spin .6s linear infinite" }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

// Small helpers local to this page
const hintStyle = { fontSize: 10, color: "#94a3b8", marginTop: 4 };
function FieldErr({ msg }) {
  if (!msg) return null;
  return <div role="alert" style={{ fontSize: 10, fontWeight: 600, color: "#dc2626", marginTop: 2 }}>{msg}</div>;
}
const sectionHead = { fontSize: 13, fontWeight: 700, color: "#0f172a", margin: 0 };

// Page-scoped responsive rules (the MES index.html phone rules are not in the demo).
const PAGE_CSS = `
  @keyframes slideDown { from { transform:translateY(-18px);opacity:0 } to { transform:none;opacity:1 } }
  .mc-root input::placeholder { color:#94a3b8; }
  .mc-root input[type=number]::-webkit-inner-spin-button { opacity:.5; }
  .mc-subtabs { overflow-x:auto; scrollbar-width:none; }
  .mc-subtabs::-webkit-scrollbar { display:none; }
  .mc-scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; }
  @media (max-width: 760px) {
    .mc-grid2, .mc-grid3 { grid-template-columns: 1fr !important; }
  }
  @media (max-width: 600px) {
    .mc-root > div:first-of-type { padding-left: 84px !important; padding-right: 12px !important; }
    .mc-root > div:first-of-type > div[style*="translateX(-50%)"] { font-size: 20px !important; white-space: nowrap; }
    .mc-body { padding: 18px 12px 0 !important; }
    .mc-card { padding: 18px 14px !important; }
    .mc-actions { justify-content: stretch !important; }
    .mc-actions > .mc-actions-left { width: 100%; }
    .mc-ff { flex: 1 1 100% !important; max-width: none !important; }
  }
`;

const TAB_KEYS = ["machines", "plc", "monitor", "collector"];
const TAB_LABELS = ["① Machines", "② PLC Config", "③ Monitor Config", "④ Collector Data"];
const tabFromHash = () => {
  try {
    const i = TAB_KEYS.indexOf((window.location.hash || "").replace(/^#/, ""));
    return i >= 0 ? i : 0;
  } catch { return 0; }
};

// Live connection state for the machine list.
function CollectorPill() {
  const { data } = useCollector(3000);
  const st = data?.plc?.state;
  const map = { connected: ["Connected", "green"], connecting: ["Connecting", "amber"], error: ["Not connected", "red"],
                not_configured: ["IP not set", "amber"] };
  const [label, color] = map[st] || ["…", "gray"];
  return <Pill label={label} color={color} />;
}

// ─── Page ─────────────────────────────────────────────────────
export default function MachineConfig() {
  const [toast, toastEl] = useToast();
  const [subPage, setSubPage] = useState(tabFromHash);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(() => normalize(null));
  const [original, setOriginal] = useState(() => normalize(null));
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState({});
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => { document.title = "Machine Configuration"; }, []);

  // Load the saved config; fall back to DEFAULTS if the demo server is not up.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!alive) return;
        const n = normalize(data);
        setForm(n); setOriginal(n);
      } catch {
        if (!alive) return;
        toast("Saved config unavailable. Showing defaults.", "info");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [toast]);

  const pickTab = (i) => {
    setSubPage(i);
    try { window.history.replaceState(window.history.state, "", `${window.location.pathname}#${TAB_KEYS[i]}`); } catch { /* ignore */ }
  };

  const errors = useMemo(() => validate(form), [form]);
  const showErr = (k) => (submitted || touched[k]) ? errors[k] : null;
  const errCountByTab = useMemo(() => {
    const c = [0, 0, 0];
    Object.keys(errors).forEach(k => { c[tabOfError(k)] += 1; });
    return c;
  }, [errors]);

  const dirty = useMemo(
    () => JSON.stringify(toPayload(form)) !== JSON.stringify(toPayload(original)),
    [form, original],
  );

  const setField = (k, v) => {
    setForm(f => ({ ...f, [k]: v }));
    setTouched(t => (t[k] ? t : { ...t, [k]: true }));
  };
  const setReg = (i, field, v) => {
    setForm(f => ({ ...f, monitor_registers: f.monitor_registers.map((r, idx) => idx === i ? { ...r, [field]: v } : r) }));
    setTouched(t => ({ ...t, [`reg.${i}.${field}`]: true }));
  };
  const addReg = () => setForm(f => (
    f.monitor_registers.length >= MAX_DATA_REGS ? f
      : { ...f, monitor_registers: [...f.monitor_registers, { register: "", content: "", unit: "", example: "" }] }
  ));
  const removeReg = (i) => {
    setForm(f => ({ ...f, monitor_registers: f.monitor_registers.filter((_, idx) => idx !== i) }));
    setTouched({});
  };
  const setInput = (i, field, v) => {
    setForm(f => ({ ...f, inputs: f.inputs.map((x, idx) => idx === i ? { ...x, [field]: v } : x) }));
    setTouched(t => ({ ...t, [`in.${i}.${field}`]: true }));
  };

  const save = async () => {
    setSubmitted(true);
    const keys = Object.keys(errors);
    if (keys.length) {
      const tab = Math.min(...keys.map(tabOfError));
      if (tab !== subPage) pickTab(tab);
      toast(keys.includes("plc_ip") ? "PLC IP address required" : "Fix the highlighted fields before saving", "err");
      return;
    }
    setSaving(true);
    try {
      const body = toPayload(form);
      const res = await fetch(API_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
        } catch { /* keep HTTP code */ }
        throw new Error(detail);
      }
      let saved = body;
      try {
        const j = await res.json();
        if (j && typeof j === "object" && !Array.isArray(j) && "machine_name" in j) saved = j;
      } catch { /* server echoed nothing usable — keep what we sent */ }
      const n = normalize(saved);
      setForm(n); setOriginal(n);
      setSubmitted(false); setTouched({});
      toast("Saved");
    } catch (e) {
      toast(`Save failed: ${e.message || "network error"}`, "err");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => { setForm(clone(original)); setSubmitted(false); setTouched({}); };
  const closeReset = useCallback(() => setResetOpen(false), []);
  const doReset = () => {
    setForm(normalize(null));
    setSubmitted(false); setTouched({});
    setResetOpen(false);
    toast("Defaults restored. Press Save to keep them.", "info");
  };

  const savedName = str(original.machine_name).trim() || DEFAULT_MACHINE_NAME;
  const ipMissing = !str(form.plc_ip).trim();
  const is4E = /4E/i.test(str(form.protocol));
  const modelOptions = PLC_MODELS.includes(form.plc_model) || !form.plc_model ? PLC_MODELS : [...PLC_MODELS, form.plc_model];
  const protocolOptions = PROTOCOLS.includes(form.protocol) || !form.protocol ? PROTOCOLS : [...PROTOCOLS, form.protocol];
  const digital = form.inputs.map((x, i) => ({ ...x, i })).filter(x => x.type === "digital");
  const analog  = form.inputs.map((x, i) => ({ ...x, i })).filter(x => x.type !== "digital");

  // Shared footer: Reset to defaults · (unsaved) · Discard · Save
  const actionBar = (
    <div className="mc-actions" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 20, paddingTop: 18, borderTop: "1px solid #f1f5f9" }}>
      <div className="mc-actions-left">
        <Btn onClick={() => setResetOpen(true)} disabled={saving}>Reset to defaults</Btn>
      </div>
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {dirty && <Pill label="Unsaved changes" color="amber" />}
        {dirty && <Btn onClick={discard} disabled={saving}>Discard</Btn>}
        <Btn variant="primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Btn>
      </div>
    </div>
  );

  // A labelled PLC field (text or number) in the compact MES style.
  const field = (k, label, { type = "text", step, placeholder, hint, upper = false, min, max, extra } = {}) => (
    <FF key={k} label={label}>
      <input
        style={{ ...mini, ...(showErr(k) ? errBorder : null) }}
        type={type} step={step} min={min} max={max} placeholder={placeholder}
        inputMode={type === "number" ? (step === "1" ? "numeric" : "decimal") : undefined}
        aria-label={label}
        aria-invalid={!!showErr(k)}
        value={form[k] ?? ""}
        onChange={e => setField(k, upper ? e.target.value.toUpperCase() : e.target.value)}
        onBlur={() => setTouched(t => (t[k] ? t : { ...t, [k]: true }))}
      />
      <FieldErr msg={showErr(k)} />
      {hint && <div style={hintStyle}>{hint}</div>}
      {extra}
    </FF>
  );

  return (
    <div className="mc-root" style={{ minHeight: "100vh", background: COLORS.bgPage, fontFamily: "'Barlow',sans-serif", color: COLORS.text, paddingBottom: 60 }}>
      <style>{PAGE_CSS}</style>
      <PageTopbar leading="Machine" accent="Configuration" />

      <div className="mc-body" style={{ padding: "30px 40px 0", maxWidth: 1180, margin: "0 auto", boxSizing: "border-box" }}>

        {/* Cascade selects — locked: this demo holds exactly one machine */}
        <Card style={{ marginBottom: 20 }}>
          <div className="mc-cascade" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <FF label="Zone" className="mc-ff" style={{ flex: "1 1 180px", maxWidth: 260 }}>
              <select style={{ ...mini, color: "#0f172a", opacity: 1, cursor: "not-allowed" }} value="demo" disabled aria-label="Zone (locked)">
                <option value="demo">{ZONE_NAME}</option>
              </select>
            </FF>
            <FF label="Line" className="mc-ff" style={{ flex: "1 1 180px", maxWidth: 260 }}>
              <select style={{ ...mini, color: "#0f172a", opacity: 1, cursor: "not-allowed" }} value="demo" disabled aria-label="Line (locked)">
                <option value="demo">{LINE_NAME}</option>
              </select>
            </FF>
            <FF label="Machine" className="mc-ff" style={{ flex: "1 1 220px", maxWidth: 320 }}>
              <select style={{ ...mini, color: "#0f172a", opacity: 1, cursor: "not-allowed" }} value="demo" disabled aria-label="Machine (locked)">
                <option value="demo">{savedName}</option>
              </select>
            </FF>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, paddingBottom: 6 }}>
              <span style={{ fontSize: 11, color: "#94a3b8" }}>Selection fixed: one machine in this demo</span>
            </div>
          </div>
        </Card>

        {/* Sub-page tabs */}
        <div className="mc-subtabs" style={{ display: "flex", gap: 0, borderBottom: "2px solid #e2e8f0", marginBottom: 24 }}>
          {TAB_LABELS.map((label, i) => (
            <button key={i} type="button" onClick={() => pickTab(i)}
              style={{ padding: "8px 16px", border: "none", background: "none", fontFamily: "'Barlow',sans-serif",
                fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
                color: subPage === i ? "#1e40af" : "#64748b",
                borderBottom: `2px solid ${subPage === i ? "#1e40af" : "transparent"}`,
                marginBottom: -2, transition: "all .12s", display: "inline-flex", alignItems: "center", gap: 6 }}>
              {label}
              {submitted && errCountByTab[i] > 0 && (
                <span style={{ minWidth: 16, height: 16, padding: "0 5px", borderRadius: 99, background: "#dc2626", color: "#fff",
                  fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
                  {errCountByTab[i]}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <Card><Spinner /></Card>
        ) : (
          <>
            {/* ── Sub-page 0: Machine list ── */}
            {subPage === 0 && (
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, gap: 12, flexWrap: "wrap" }}>
                  <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", margin: 0 }}>
                    Machines on {LINE_NAME}
                  </h3>
                  <span style={{ fontSize: 11, color: "#64748b" }}>1 machine</span>
                </div>
                <div className="mc-scroll" style={{ border: "1px solid #e2e8f0", borderRadius: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
                    <thead>
                      <tr>
                        {["Seq", "Machine", "PLC IP:Port", "Protocol", "Count Mode", "Ideal CT", "Status", ""].map((h, i) => (
                          <th key={i} style={{ ...thStyle, whiteSpace: "nowrap", ...(i === 7 ? { textAlign: "right" } : null) }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const m = toPayload(original);
                        const td = { ...tdStyle, borderBottom: "none", verticalAlign: "middle" };
                        return (
                          <tr style={{ background: "#fff" }}>
                            <td style={td}>
                              <span style={{ display: "inline-block", minWidth: 26, textAlign: "center", padding: "2px 6px", borderRadius: 6, background: "#f1f5f9", border: "1px solid #e2e8f0", fontSize: 11, fontWeight: 700, color: "#334155" }}>
                                {m.machine_seq ?? "—"}
                              </span>
                            </td>
                            <td style={{ ...td, minWidth: 220 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: "#0f172a", display: "flex", alignItems: "center", gap: 8 }}>
                                {m.machine_name || "(unnamed)"}
                                <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#dcfce7", color: "#15803d", letterSpacing: ".05em" }}>MAIN</span>
                              </div>
                              <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                                {m.plc_model}{m.nf2_camera_id ? ` · cam=${m.nf2_camera_id}` : ""}
                              </div>
                            </td>
                            <td style={td}>
                              {m.plc_ip
                                ? <span style={{ fontSize: 12 }}>{m.plc_ip}:{m.plc_port}</span>
                                : <span style={{ fontSize: 12, color: "#b45309", fontWeight: 600 }}>IP not set <span style={{ color: "#64748b", fontWeight: 400 }}>:{m.plc_port}</span></span>}
                            </td>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>{m.protocol}</td>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>
                              {m.count_mode === "register"
                                ? <>Register <span style={{ color: "#64748b", fontSize: 11 }}>({m.ok_data_register} / {m.ng_data_register})</span></>
                                : <>Bit edge <span style={{ color: "#64748b", fontSize: 11 }}>({m.ok_bit_address} / {m.ng_bit_address})</span></>}
                            </td>
                            <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 600 }}>
                              {m.ideal_cycle_time != null && Number.isFinite(m.ideal_cycle_time) ? `${m.ideal_cycle_time.toFixed(1)} s` : "—"}
                            </td>
                            <td style={td}><CollectorPill /></td>
                            <td style={{ ...td, textAlign: "right" }}>
                              <div style={{ display: "inline-flex", gap: 8 }}>
                                <Btn size="sm" onClick={() => pickTab(1)}>Edit PLC</Btn>
                                <Btn size="sm" onClick={() => pickTab(2)}>Monitor Config</Btn>
                              </div>
                            </td>
                          </tr>
                        );
                      })()}
                    </tbody>
                  </table>
                </div>
                <p style={{ fontSize: 11, color: "#94a3b8", margin: "12px 0 0" }}>
                  The demo server's collector reads this PLC (read only, nothing is written) and feeds MANAGEMENT-2.
                  Saving the PLC settings reconnects it. <button type="button" onClick={() => pickTab(3)}
                    style={{ border: "none", background: "none", padding: 0, color: "#1e40af", fontWeight: 700, cursor: "pointer", fontSize: 11 }}>
                    See collector data →</button>
                </p>
              </Card>
            )}

            {/* ── Sub-page 1: PLC Config ── */}
            {subPage === 1 && (
              <Card>
                <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", marginBottom: 18 }}>
                  Edit PLC — {savedName}
                  <span style={{ fontWeight: 400, color: "#64748b", fontSize: 12, marginLeft: 8 }}>for {LINE_NAME}</span>
                </h3>

                {ipMissing && (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 18, padding: "10px 14px", borderRadius: 8,
                    background: "#fefce8", border: "1px solid #fde68a", color: "#92400e", fontSize: 12, fontWeight: 600 }}>
                    <span aria-hidden="true" style={{ fontSize: 13, lineHeight: "16px" }}>⚠</span>
                    <span>Set the station PLC's IP. This demo never connects to the PLC.</span>
                  </div>
                )}

                <div className="mc-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                  {field("machine_name", "Machine Name")}
                  <FF label="PLC Model">
                    <select aria-label="PLC Model" style={{ ...mini, ...(showErr("plc_model") ? errBorder : null) }} value={form.plc_model ?? ""}
                      onChange={e => setField("plc_model", e.target.value)}>
                      {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                    <FieldErr msg={showErr("plc_model")} />
                  </FF>
                  {field("plc_ip", "PLC IP Address", { placeholder: "e.g. 192.168.30.250" })}
                  {field("plc_port", "PLC Port", { type: "number", step: "1", min: 1, max: 65535, hint: "SLMP connection port configured in GX Works3" })}
                  <FF label="Protocol">
                    <select aria-label="Protocol" style={{ ...mini, ...(showErr("protocol") ? errBorder : null) }} value={form.protocol ?? ""}
                      onChange={e => setField("protocol", e.target.value)}>
                      {protocolOptions.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <FieldErr msg={showErr("protocol")} />
                    <div style={{ ...hintStyle, ...(is4E ? { color: "#b45309", fontWeight: 600 } : null) }}>
                      FX5 SLMP server supports 3E/1E frames{is4E ? ". 4E frames will not be answered." : ""}
                    </div>
                  </FF>
                  {field("ideal_cycle_time",    "Ideal Cycle Time (s)",  { type: "number", step: "0.01", min: 0 })}
                  {field("max_allowed_cycle",   "Max Allowed Cycle (s)", { type: "number", step: "0.01", min: 0 })}
                  {field("ok_ng_pulse_min_gap", "OK/NG Min Gap (s)",     { type: "number", step: "0.01", min: 0 })}
                </div>

                {/* Bit addresses inline */}
                <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 20, paddingTop: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                    <h4 style={sectionHead}>Bit / Register Addresses</h4>
                  </div>
                  <div className="mc-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                    {field("ok_bit_address", "OK Bit Address", { upper: true, placeholder: "e.g. L108" })}
                    {field("ng_bit_address", "NG Bit Address", { upper: true, placeholder: "e.g. L109" })}
                    {field("status_address", "Status Address", { upper: true, placeholder: "blank = from the cycle signals",
                      hint: (() => {
                        const a = ANDON_FIELDS.find(x => up(form[x.key]) && up(form[x.key]) === up(form.status_address));
                        return a ? `Same as the ${a.label} andon register: not read as a status word.`
                                 : "Machine status word (0 idle, 1 running, 2+ loss). Blank: running / idle from the OK/NG signals.";
                      })() })}
                    {field("ct_register", "Cycle Time Register", { upper: true, placeholder: "e.g. D103 (blank = measure)",
                      hint: "PLC's last cycle time, read on each OK/NG signal. Blank: time between signals." })}
                    {field("ct_register_scale", "Cycle Time Unit (s per count)", { type: "number", step: "0.001", min: 0,
                      hint: "0.1 = register holds 0.1 s (245 → 24.5 s)" })}
                  </div>

                  {/* OK / NG count mode: bit edge OR D-register mirror */}
                  <div style={{ marginTop: 18, padding: 12, borderRadius: 6, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>
                      OK / NG Counting Mode
                    </div>
                    <div style={{ display: "flex", gap: "8px 18px", marginBottom: form.count_mode === "register" ? 10 : 0, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                        <input type="radio" name="count_mode"
                          checked={form.count_mode !== "register"}
                          onChange={() => setField("count_mode", "bit")} />
                        <span><b>Bit edge</b> — {up(form.ok_bit_address) || "OK bit"} rise = +1 OK, {up(form.ng_bit_address) || "NG bit"} rise = +1 NG</span>
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                        <input type="radio" name="count_mode"
                          checked={form.count_mode === "register"}
                          onChange={() => setField("count_mode", "register")} />
                        <span><b>Register</b> — poll D-register value, increment = +N OK/NG</span>
                      </label>
                    </div>
                    {form.count_mode === "register" && (
                      <div className="mc-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                        {field("ok_data_register", "OK Data Register", { upper: true, placeholder: "e.g. D101",
                          hint: "Word register holding shift OK count. Value increase → +N OK rows. Resets per shift." })}
                        {field("ng_data_register", "NG Data Register", { upper: true, placeholder: "e.g. D102",
                          hint: "Word register holding shift NG count. Same logic, separate from OK." })}
                        <div style={{ gridColumn: "1 / -1" }}>
                          {field("shift_reset_bit", "Shift Reset Bit", { upper: true, placeholder: "e.g. L110",
                            hint: "Bit that pulses ON at shift end. On its rising edge the closing OK/NG count is archived, then the registers reset to 0. Leave blank for no auto-reset." })}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Andon (loss) registers */}
                <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 20, paddingTop: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                    <h4 style={sectionHead}>Andon (Loss) Registers</h4>
                    <span style={{ fontSize: 10, color: "#64748b" }}>
                      Value not 0 = that loss is on: shown on the shift timeline and in the loss distribution. Blank = not used.
                    </span>
                  </div>
                  <div className="mc-grid3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 16px" }}>
                    {ANDON_FIELDS.map(a => (
                      <div key={a.key}>
                        {field(a.key, `${a.label} Andon`, { upper: true, placeholder: `e.g. ${a.def}`, hint: `Timeline: ${a.status}` })}
                      </div>
                    ))}
                  </div>
                </div>

                {/* Machine type & camera */}
                <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 20, paddingTop: 20 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 12, flexWrap: "wrap" }}>
                    <h4 style={sectionHead}>Machine Type</h4>
                    <span style={{ fontSize: 10, color: "#64748b" }}>
                      The demo station is the line's main PLC.
                    </span>
                  </div>
                  <div className="mc-grid3" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px 16px" }}>
                    <FF label="Type">
                      <select style={{ ...mini, color: "#0f172a", opacity: 1, cursor: "not-allowed" }} value="" disabled>
                        <option value="">Main PLC (primary station of this line)</option>
                      </select>
                    </FF>
                    {field("machine_seq", "Machine No. (M-N badge)", { type: "number", step: "1", min: 0, max: 99, placeholder: "e.g. 1, 2, 3 …",
                      hint: <>Shown as the <b>M-{str(form.machine_seq).trim() === "" ? "N" : form.machine_seq}</b> badge on the Dashboard tile. Leave blank to skip.</> })}
                    {field("nf2_camera_id", "Camera ID", { placeholder: "e.g. CAM-01",
                      hint: "Camera bound to this station's cycle clips.",
                      extra: (
                        <Link to="/camera" style={{ fontSize: 11, fontWeight: 600, color: "#2563eb", textDecoration: "none", marginTop: 2, alignSelf: "flex-start" }}>
                          Edit camera →
                        </Link>
                      ) })}
                  </div>
                </div>

                {actionBar}
              </Card>
            )}

            {/* ── Sub-page 2: Monitor Config ── */}
            {subPage === 2 && (
              <div style={{ maxWidth: 860 }}>
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, gap: 12, flexWrap: "wrap" }}>
                    <div>
                      <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", margin: 0 }}>
                        Monitor Config — {savedName}
                      </h3>
                      <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
                        Data registers read once per cycle, and the station's physical inputs.
                      </p>
                    </div>
                  </div>

                  {/* ── Data Registers ── */}
                  <div style={{ padding: 16, borderRadius: 8, border: "2px solid #3b82f6", background: "#f0f7ff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>Data Registers</span>
                      <span style={{ fontSize: 11, color: "#64748b" }}>— word/D-register values read once per cycle (max {MAX_DATA_REGS})</span>
                    </div>

                    <div className="mc-scroll" style={{ marginTop: 16 }}>
                      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 7px", minWidth: 640, marginTop: -7 }}>
                        <thead>
                          <tr>
                            {["Register", "Content", "Unit / Scale", "Example", ""].map((h, i) => (
                              <th key={i} style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase",
                                letterSpacing: ".06em", textAlign: "left", padding: "0 4px", whiteSpace: "nowrap",
                                width: [110, undefined, 150, 190, 32][i] }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {form.monitor_registers.map((r, i) => {
                            const eReg = showErr(`reg.${i}.register`);
                            const eCon = showErr(`reg.${i}.content`);
                            return (
                              <tr key={i}>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={{ ...mini, fontFamily: "monospace", fontWeight: 600, textTransform: "uppercase", ...(eReg ? errBorder : null) }}
                                    type="text" placeholder="D100" value={r.register} aria-label={`Register ${i + 1}`}
                                    onChange={e => setReg(i, "register", e.target.value.toUpperCase())} />
                                  <FieldErr msg={eReg} />
                                </td>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={{ ...mini, ...(eCon ? errBorder : null) }} type="text" placeholder="e.g. Final torque"
                                    value={r.content} aria-label={`Content ${i + 1}`}
                                    onChange={e => setReg(i, "content", e.target.value)} />
                                  <FieldErr msg={eCon} />
                                </td>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={mini} type="text" placeholder="e.g. 0.01 Nm" value={r.unit} aria-label={`Unit ${i + 1}`}
                                    onChange={e => setReg(i, "unit", e.target.value)} />
                                </td>
                                <td style={{ padding: "9px 4px 0", verticalAlign: "top" }}>
                                  <span style={{ fontSize: 12, color: "#475569" }}>{r.example || "—"}</span>
                                </td>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <button type="button" onClick={() => removeReg(i)} title="Remove register" aria-label={`Remove register ${r.register || i + 1}`}
                                    style={{ border: "none", background: "#fee2e2", color: "#dc2626", borderRadius: 6,
                                      width: 28, height: 28, marginTop: 2, cursor: "pointer", fontSize: 13, fontWeight: 700,
                                      display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                      <Btn size="sm" onClick={addReg} disabled={form.monitor_registers.length >= MAX_DATA_REGS}>+ Add Register</Btn>
                      {form.monitor_registers.length >= MAX_DATA_REGS && <span style={{ fontSize: 11, color: "#d97706" }}>Maximum {MAX_DATA_REGS} reached</span>}
                      <span style={{ fontSize: 11, color: "#64748b", marginLeft: "auto" }}>
                        {form.monitor_registers.filter(r => str(r.register).trim()).length} / {MAX_DATA_REGS} configured
                      </span>
                    </div>
                  </div>
                </Card>

                {/* ── Inputs ── */}
                <Card style={{ marginTop: 20 }}>
                  <div style={{ marginBottom: 18 }}>
                    <h3 style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", margin: 0 }}>Inputs</h3>
                    <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
                      Digital inputs wired to the PLC and analog torque channels. X addresses are octal (X7 is followed by X10).
                    </p>
                  </div>

                  {/* Digital inputs */}
                  <div style={{ padding: 16, borderRadius: 8, border: "2px solid #e2e8f0", background: "#fafafa" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>Digital Inputs</span>
                      <span style={{ fontSize: 11, color: "#64748b" }}>— X bits</span>
                    </div>
                    <div className="mc-scroll">
                      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 7px", minWidth: 560, marginTop: -7 }}>
                        <thead>
                          <tr>
                            {["Address", "Signal", "Note"].map((h, i) => (
                              <th key={h} style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase",
                                letterSpacing: ".06em", textAlign: "left", padding: "0 4px", width: [110, undefined, "38%"][i] }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {digital.map(x => {
                            const eA = showErr(`in.${x.i}.address`);
                            const eS = showErr(`in.${x.i}.signal`);
                            return (
                              <tr key={x.i}>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={{ ...mini, fontFamily: "monospace", fontWeight: 600, textTransform: "uppercase", ...(eA ? errBorder : null) }}
                                    type="text" placeholder="X0" value={x.address} aria-label={`Input address ${x.address}`}
                                    onChange={e => setInput(x.i, "address", e.target.value.toUpperCase())} />
                                  <FieldErr msg={eA} />
                                </td>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={{ ...mini, ...(eS ? errBorder : null) }} type="text" placeholder="Signal name"
                                    value={x.signal} aria-label={`Signal for ${x.address}`}
                                    onChange={e => setInput(x.i, "signal", e.target.value)} />
                                  <FieldErr msg={eS} />
                                </td>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={mini} type="text" placeholder="Optional note" value={x.note} aria-label={`Note for ${x.address}`}
                                    onChange={e => setInput(x.i, "note", e.target.value)} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Analog inputs */}
                  <div style={{ marginTop: 16, padding: 16, borderRadius: 8, border: "2px solid #8b5cf6", background: "#faf5ff" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>Analog Inputs</span>
                      <span style={{ fontSize: 11, color: "#64748b" }}>— FX5-4AD torque channels</span>
                    </div>
                    <div className="mc-scroll">
                      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: "0 7px", minWidth: 560, marginTop: -7 }}>
                        <thead>
                          <tr>
                            {["Channel", "Signal", "Range / Scale"].map((h, i) => (
                              <th key={h} style={{ fontSize: 10, fontWeight: 700, color: "#475569", textTransform: "uppercase",
                                letterSpacing: ".06em", textAlign: "left", padding: "0 4px", width: [150, undefined, "38%"][i] }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {analog.map(x => {
                            const eA = showErr(`in.${x.i}.address`);
                            const eS = showErr(`in.${x.i}.signal`);
                            return (
                              <tr key={x.i}>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={{ ...mini, fontWeight: 600, ...(eA ? errBorder : null) }}
                                    type="text" placeholder="FX5-4AD CH1" value={x.address} aria-label={`Analog channel ${x.i}`}
                                    onChange={e => setInput(x.i, "address", e.target.value)} />
                                  <FieldErr msg={eA} />
                                </td>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={{ ...mini, ...(eS ? errBorder : null) }} type="text" placeholder="Signal name"
                                    value={x.signal} aria-label={`Signal for ${x.address}`}
                                    onChange={e => setInput(x.i, "signal", e.target.value)} />
                                  <FieldErr msg={eS} />
                                </td>
                                <td style={{ padding: "0 4px", verticalAlign: "top" }}>
                                  <input style={mini} type="text" placeholder="e.g. ±10 V = ±30 Nm" value={x.note} aria-label={`Range for ${x.address}`}
                                    onChange={e => setInput(x.i, "note", e.target.value)} />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Summary badges (MES style) */}
                  <div style={{ display: "flex", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
                    <span style={{ padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600,
                      background: "#dbeafe", color: "#1d4ed8", border: "1px solid #93c5fd" }}>
                      ◈ {form.monitor_registers.filter(r => str(r.register).trim()).length} data register(s)
                    </span>
                    <span style={{ padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600,
                      background: "#f1f5f9", color: "#334155", border: "1px solid #cbd5e1" }}>
                      ● {digital.length} digital input(s)
                    </span>
                    <span style={{ padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 600,
                      background: "#ede9fe", color: "#6d28d9", border: "1px solid #c4b5fd" }}>
                      ⊞ {analog.length} analog channel(s)
                    </span>
                  </div>

                  {actionBar}
                </Card>
              </div>
            )}

            {/* ── Sub-page 3: live collector data ── */}
            {subPage === 3 && <CollectorLive />}
          </>
        )}
      </div>

      {/* Reset confirmation (MES Modal style) */}
      <Modal open={resetOpen} onClose={closeReset} title="Reset to defaults">
        <p style={{ fontSize: 13, color: "#334155", margin: 0, lineHeight: 1.55 }}>
          Every PLC field, data register and input returns to the demo defaults (PLC IP 192.168.30.10).
        </p>
        <p style={{ fontSize: 12, color: "#64748b", margin: "10px 0 0" }}>
          Nothing is stored until you press <b>Save</b>.
        </p>
        <ModalActions>
          <Btn onClick={closeReset}>Cancel</Btn>
          <Btn variant="danger" onClick={doReset}>Reset to defaults</Btn>
        </ModalActions>
      </Modal>

      {toastEl}
    </div>
  );
}
