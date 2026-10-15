#!/usr/bin/env python3
"""MES demo clone — standalone server (Python standard library only).

Serves the built frontend from ./dist and a small /api that mimics the MES
endpoints the three demo pages use. It has NO connection to the live MES:
no database, no PLC, no camera, no calls to ports 8080/5555/5656/5700.

Data:
  data/cycles.json   — the recorded Final Inspection cycles shown by the demo (see its "source");
                       currently YCA-SS 2026-10-08 shift A, cycles #1600-#1700 that have a clip
  clips/<machine>/cycle_<seq>.mp4 — the matching recorded clips (H.264)
  data/machine.json, data/camera.json — saved by the config pages
  data/comments.json — cycle comments / remarks typed in the demo

Run:  python3 server.py [port]        (default 5000)
"""
import datetime as dt
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
CLIPS = os.path.join(HERE, "clips")
DATA = os.path.join(HERE, "data")
LOCK = threading.Lock()

IST = "+05:30"

with open(os.path.join(DATA, "cycles.json")) as f:
    CYCLES = json.load(f)
LINE = dict(CYCLES["line"])                  # {"line_id", "line_name", "line_code"}
LINE_ID = LINE["line_id"]
MODEL = CYCLES.get("model") or {"number": None, "name": "—"}
RECORD_DATE = CYCLES["record_date"]
SHIFT = CYCLES["shift_name"]
BY_SUB = {m["sub_id"]: m for m in CYCLES["machines"]}       # 0 = main (Final Inspection)

MACHINE_DEFAULTS = {
    "machine_name": "Nut-Runner Demo Station", "plc_model": "Mitsubishi FX5U-32MT/ESS",
    "plc_ip": "192.168.30.10", "plc_port": 5000, "protocol": "SLMP 3E (binary)", "count_mode": "bit",
    "ok_bit_address": "L108", "ng_bit_address": "L109", "ok_data_register": "D101",
    "ng_data_register": "D102", "shift_reset_bit": "L110", "status_address": "D100",
    "ideal_cycle_time": 20.0, "max_allowed_cycle": 40.0, "ok_ng_pulse_min_gap": 0.5,
    "nf2_camera_id": "CAM-01", "machine_seq": 0,
}
CAMERA_DEFAULTS = {
    "camera_id": "CAM-01", "name": "Station camera", "ip": "192.168.30.20", "port": 554,
    "rtsp_path": "/Streaming/Channels/101", "username": "admin", "password": "",
    "assigned_machine": "Nut-Runner Demo Station", "recording_enabled": True,
    "codec": "H.264 Main", "resolution": "1920 × 1080", "fps": 25, "bitrate_kbps": 2000,
    "iframe_interval": 25, "video_save_path": os.path.join(HERE, "clips"),
    "retention_days": 30, "pre_roll_s": 2, "post_roll_s": 2,
}


# ---------- small JSON store ----------
def _load(name, default):
    try:
        with open(os.path.join(DATA, name)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save(name, obj):
    path = os.path.join(DATA, name)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def _now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


# ---------- MES-shaped payloads ----------
def _cycle_rows(m):
    rows = []
    for c in m["cycles"]:
        ts = c["ts"]
        if m["sub_id"] != 0 and not ts.endswith(IST):
            ts += IST                          # MES sends sub-machine ts with an offset, main ts naive
        row = {"cycle_seq": c["cycle_seq"], "ts": ts, "ct": c["ct"], "is_ng": c["is_ng"], "shift_name": SHIFT}
        if m["sub_id"] != 0 and c.get("part_code"):
            row["part_code"] = c["part_code"]
        rows.append(row)
    return rows


def _machine_payload(m):
    ideal = m["ideal_ct"]
    out = {"sub_id": m["sub_id"], "machine_name": m["machine_name"], "machine_seq": m["machine_seq"],
           "ideal_ct": ideal, "loss_seconds": round(sum(c["ct"] - ideal for c in m["cycles"]), 2),
           "cycles_counted": len(m["cycles"]), "cycles": _cycle_rows(m)}
    if m["sub_id"] == 0:
        out["is_main"] = True
    return out


def wallboard_cycles():
    main = BY_SUB.get(0)
    return {"shift_name": SHIFT, "record_date": RECORD_DATE,
            "main": _machine_payload(main) if main else None,
            "machines": [_machine_payload(m) for m in CYCLES["machines"] if m["sub_id"] != 0]}


def _line_cfg():
    return _load("mgmt/line.json", {})


def _shift_slots():
    cfg = _line_cfg()
    return [x for x in cfg.get("hourly_slots", [])
            if x.get("shift_name") == SHIFT and not str(x.get("db_column_prefix", "")).endswith("_ot")]


def _ts(c):
    return dt.datetime.fromisoformat(c["ts"][:26])


# The demo "now": 4 s after the last recorded cycle (the Management page pins its clock to the same moment).
def _demo_now():
    cyc = _main_cycles()
    return _ts(cyc[-1]) + dt.timedelta(seconds=4) if cyc else dt.datetime.now()


def realtime():
    """MES /realtime shape, computed from the recorded Final Inspection cycles."""
    cyc = _main_cycles()
    main = BY_SUB.get(0) or {"ideal_ct": 15.0}
    ideal = float(main["ideal_ct"])
    cfg = _line_cfg()
    shift = next((x for x in cfg.get("shifts", []) if x.get("shift_name") == SHIFT), {})
    ok = sum(1 for c in cyc if not c["is_ng"])
    ng = len(cyc) - ok
    run_s = sum(c["ct"] for c in cyc)
    start = _ts(cyc[0]) - dt.timedelta(seconds=cyc[0]["ct"]) if cyc else _demo_now()
    window_s = max(1.0, (_demo_now() - start).total_seconds())
    speed_loss = sum(max(0.0, c["ct"] - ideal) for c in cyc)
    avail = min(100.0, 100.0 * run_s / window_s)
    perf = 100.0 * (run_s - speed_loss) / run_s if run_s else 0.0
    qual = 100.0 * ok / len(cyc) if cyc else 0.0
    oee = avail * perf * qual / 10000.0
    grade = ("EXCELLENT" if oee >= 85 else "GOOD" if oee >= 75 else "AVERAGE" if oee >= 65 else "POOR")
    plan_done = int(window_s // ideal)
    rt = {
        "record_date": RECORD_DATE, "shift_name": SHIFT, "line_name": LINE["line_name"],
        "shift_start_time": shift.get("start_time", "08:30:00"), "shift_end_time": shift.get("end_time", "17:15:00"),
        "operating_status": "RUNNING", "current_model_number": MODEL["number"], "current_model_name": MODEL["name"],
        "ok_count": ok, "ng_count": ng, "shift_plan": shift.get("total_plan", 1860),
        "shift_plan_completed": plan_done, "shift_plan_remaining": max(0, shift.get("total_plan", 1860) - plan_done),
        "cycle_time_plan": ideal, "cycle_time_actual": round(run_s / len(cyc), 2) if cyc else None,
        "availability": round(avail, 2), "performance": round(perf, 2), "quality_oee": round(qual, 2),
        "overall_oee": round(oee, 2), "oee_grade": grade, "is_shift_completed": False, "is_gap_time": False,
        "loss_breakdown_seconds": 0, "loss_quality_seconds": 0, "loss_setup_seconds": 0, "loss_material_seconds": 0,
        "loss_others_seconds": 0, "loss_change_over_seconds": 0, "loss_speed_seconds": round(speed_loss),
        "min_ct": min((c["ct"] for c in cyc), default=None), "max_ct": max((c["ct"] for c in cyc), default=None),
        "collector_status": "running", "ot_active_shift": None, "ot_plan": None,
        "takt_seconds": ideal, "working_minutes": shift.get("working_minutes", 465),
        "planned_takt_seconds": cfg.get("planned_takt_time") or ideal, "energy_per_part": cfg.get("energy_per_part"),
        "andon_calls": 0,
    }
    newest = [c["ct"] for c in reversed(cyc)][:20]
    for i, v in enumerate(newest):
        rt[f"ct{i + 1}"] = v
    rt["ct_avg_20"] = round(sum(newest) / len(newest), 2) if newest else None
    for sl in _shift_slots():
        pre = sl["db_column_prefix"]
        s0 = dt.datetime.combine(dt.date.fromisoformat(RECORD_DATE), dt.time.fromisoformat(sl["start_time"]))
        s1 = dt.datetime.combine(dt.date.fromisoformat(RECORD_DATE), dt.time.fromisoformat(sl["end_time"]))
        inside = [c for c in cyc if s0 <= _ts(c) < s1]
        lo, hi = max(s0, start), min(s1, _demo_now())
        plan = int(max(0.0, (hi - lo).total_seconds()) // ideal) if inside else 0
        sok = sum(1 for c in inside if not c["is_ng"])
        rt.update({f"{pre}_plan": plan, f"{pre}_ok": sok, f"{pre}_ng": len(inside) - sok,
                   f"{pre}_actual": sok, f"{pre}_variance": sok - plan})
    return rt


def hourly_loss_breakdown():
    cyc, ideal = _main_cycles(), float((BY_SUB.get(0) or {"ideal_ct": 15.0})["ideal_ct"])
    keys = ("loss_breakdown", "loss_quality", "loss_material", "loss_setup", "loss_change_over", "loss_speed", "loss_others")
    slots, tot = [], dict.fromkeys(keys, 0)
    for sl in _shift_slots():
        s0 = dt.datetime.combine(dt.date.fromisoformat(RECORD_DATE), dt.time.fromisoformat(sl["start_time"]))
        s1 = dt.datetime.combine(dt.date.fromisoformat(RECORD_DATE), dt.time.fromisoformat(sl["end_time"]))
        sp = round(sum(max(0.0, c["ct"] - ideal) for c in cyc if s0 <= _ts(c) < s1))
        row = {"slot_label": sl["slot_label"], "start": sl["start_time"][:5], "end": sl["end_time"][:5],
               **dict.fromkeys(keys, 0), "loss_speed": sp, "total_loss": sp}
        slots.append(row)
        tot["loss_speed"] += sp
    tot["total_loss"] = tot["loss_speed"]
    return {"date": RECORD_DATE, "shift_name": SHIFT, "slots": slots, "totals": tot}


def wallboard_summary():
    rt = realtime()
    kpi = {k: rt.get(k) for k in ("line_name", "shift_name", "record_date", "operating_status", "shift_plan",
                                  "shift_plan_completed", "ok_count", "ng_count", "current_model_name",
                                  "current_model_number", "overall_oee", "availability", "performance",
                                  "quality_oee", "cycle_time_actual", "cycle_time_plan")}
    kpi.update({"andon_status": False, "andon_calls": 0})
    return {"kpi": kpi, "machines_hourly": []}


def _machine_for(q):
    try:
        return BY_SUB.get(int((q.get("sub_id") or ["0"])[0]))
    except ValueError:
        return None


def over_target_history(q):
    m = _machine_for(q)
    if not m:
        return {"ideal_ct": None, "rows": []}
    ideal, total = m["ideal_ct"], len(m["cycles"])
    over = sum(1 for c in m["cycles"] if c["ct"] > ideal + 0.009)
    return {"ideal_ct": ideal, "rows": [{"date": RECORD_DATE, "shift": SHIFT, "over": over, "total": total,
                                         "pct": round(100.0 * over / total, 1) if total else 0.0}]}


def hourly_avg_ct(q):
    m = _machine_for(q)
    if not m:
        return {"date": RECORD_DATE, "shift": SHIFT, "slots": []}
    ideal, by_hour = m["ideal_ct"], {}
    for c in m["cycles"]:
        by_hour.setdefault(int(c["ts"][11:13]), []).append(c["ct"])
    slots = [{"label": f"{h:02d}:00-{(h + 1) % 24:02d}:00", "cycles": len(v),
              "avg_ct": round(sum(v) / len(v), 2), "min_ct": round(min(v), 2), "max_ct": round(max(v), 2),
              "over": sum(1 for x in v if x > ideal + 0.009), "working_seconds": round(sum(v), 1)}
             for h, v in sorted(by_hour.items())]
    all_ct = [c["ct"] for c in m["cycles"]]
    return {"date": RECORD_DATE, "shift": SHIFT, "ideal_ct": ideal, "slots": slots,
            "avg_ct": round(sum(all_ct) / len(all_ct), 2), "total_cycles": len(all_ct),
            "working_seconds": round(sum(all_ct), 1)}


def _main_cycles():
    main = BY_SUB.get(0)
    return main["cycles"] if main else []


def ct_history():
    """Final Inspection cycles in the MES /ct-history shape (oldest first)."""
    return [{"id": i + 1, "ts": c["ts"], "record_date": RECORD_DATE, "shift_name": SHIFT,
             "ct_value": c["ct"], "cycle_seq": c["cycle_seq"], "part_code": c.get("part_code"),
             "is_ng": c["is_ng"]} for i, c in enumerate(_main_cycles())]


def cycle_extremes():
    cyc = _main_cycles()
    if not cyc:
        return {"min": None, "max": None, "shift": SHIFT, "date": RECORD_DATE}
    pick = lambda c: {"ts": c["ts"], "ct_value": c["ct"], "part_code": c.get("part_code"),
                      "is_ng": c["is_ng"], "cycle_seq": c["cycle_seq"], "shift_name": SHIFT}
    return {"min": pick(min(cyc, key=lambda c: c["ct"])), "max": pick(max(cyc, key=lambda c: c["ct"])),
            "shift": SHIFT, "date": RECORD_DATE}


def ct_histogram():
    buckets = {}
    for c in _main_cycles():
        b = round(c["ct"], 1)
        buckets[b] = buckets.get(b, 0) + 1
    rows = [{"ct": k, "count": v} for k, v in sorted(buckets.items())]
    peak = max(rows, key=lambda r: r["count"]) if rows else {"ct": None, "count": 0}
    return {"total_cycles": sum(buckets.values()), "peak_bucket": peak["ct"], "peak_count": peak["count"],
            "buckets": rows, "window_days": 1}


MGMT_MACHINES = [{"id": (_load("mgmt/line.json", {}).get("plc_config") or {}).get("id") or 1,
                  "machine_name": (BY_SUB.get(0) or {}).get("machine_name", "Final Inspection"),
                  "machine_seq": None, "parent_plc_id": None}]


def status_log():
    """Timeline: line RUNNING from the first demo cycle (12:52:50) onward.
    ts is set near real time only so the page's 16 h freshness filter keeps it; it is never displayed."""
    import time
    cyc = _main_cycles()
    t0 = _ts(cyc[0]) - dt.timedelta(seconds=cyc[0]["ct"]) if cyc else dt.datetime.now()
    nmf = t0.hour * 60 + t0.minute + t0.second / 60 + t0.microsecond / 6e7
    return [{"ts": time.time() * 1000 - 1000, "nowMinFrac": round(nmf, 5), "status": "RUNNING", "shift": SHIFT}]


def comments_history():
    store = _load("comments.json", {"comments": [], "remarks": []})
    rows = [{"part_code": c["part_code"], "shift_name": c.get("shift") or SHIFT, "text": c["comment"],
             "type": "Comment", "date": c.get("record_date") or RECORD_DATE, "created_at": c["created_at"],
             "author": c.get("author"), "machine_name": c.get("machine_name")} for c in store["comments"]]
    rows += [{"part_code": r["part_code"], "shift_name": SHIFT, "text": r["remark_text"], "type": "NG-Remark",
              "date": RECORD_DATE, "created_at": r["updated_at"], "machine_name": r.get("machine_name")}
             for r in store["remarks"]]
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return {"rows": rows}


# ---------- HTTP ----------
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
          ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json",
          ".mp4": "video/mp4", ".ico": "image/x-icon", ".woff2": "font/woff2"}


# Largest body sent for an open-ended "Range: bytes=N-" request.  Chrome's media
# loader asks for bytes=0- and then stops reading once it has ~3 MB buffered, so
# a 4-8 MB clip kept one of the browser's 6 HTTP/1.1 sockets busy until the page
# dropped the <video>.  Answering in bounded slices lets every request finish;
# the browser simply asks for the next slice when it needs it.
RANGE_SLICE = 1 << 20


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MESDemo/1.0"
    # Headers and body go out in two send() calls; with Nagle on, the body waited
    # for the client's delayed ACK (40 ms Linux, up to 200 ms Windows) on every
    # keep-alive request.
    disable_nagle_algorithm = True

    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def _file(self, full, cache="public, max-age=3600", extra=None):
        size = os.path.getsize(full)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes="):
            s, _, e = rng[6:].split(",")[0].strip().partition("-")
            try:
                if s:
                    start = int(s)
                    end = min(int(e), size - 1) if e else min(size - 1, start + RANGE_SLICE - 1)
                else:
                    start = max(0, size - int(e))
                status = 206
            except ValueError:
                start, end, status = 0, size - 1, 200
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", CTYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            f.seek(start)
            left = length
            try:
                while left > 0:
                    chunk = f.read(min(262144, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _clip(self, folder, q):
        try:
            seq = int((q.get("cycle_seq") or [""])[0])
        except ValueError:
            return self._json({"detail": "cycle_seq required"}, 400)
        full = os.path.join(CLIPS, folder, f"cycle_{seq}.mp4")
        if not os.path.isfile(full):
            return self._json({"detail": "No clip for this cycle"}, 404)
        return self._file(full, cache="private, max-age=86400", extra={"X-Clip-Source": "archive", "X-Video-Offset": "0"})

    def do_GET(self):
        u = urlparse(self.path)
        p, q = u.path.rstrip("/") or "/", parse_qs(u.query)
        if not p.startswith("/api/"):
            return self._static(u.path)
        parts = p.split("/")                      # ['', 'api', ...]

        if p.startswith("/api/lines/resolve-ref/"):
            return self._json(LINE)
        if (p.startswith("/api/lines/") and len(parts) >= 4 and not parts[3].isdigit()) or \
           (p.startswith("/api/poka-yoke/") and len(parts) >= 5 and not parts[4].isdigit()):
            return self._json({"detail": "line id must be an integer"}, 422)
        if p == "/api/lines":
            return self._json([{"id": LINE_ID, "line_name": LINE["line_name"], "line_code": LINE["line_code"],
                                "db_table_name": _line_cfg().get("db_table_name", ""), "is_active": True}])
        if p.startswith("/api/lines/") and len(parts) >= 5:
            tail = "/".join(parts[4:])
            if tail == "wallboard-cycles":
                return self._json(wallboard_cycles())
            if tail == "wallboard-summary":
                return self._json(wallboard_summary())
            if tail in ("cycle-video", "archive-video"):
                return self._clip("main", q)
            if tail == "over-target-history":
                return self._json(over_target_history(q))
            if tail == "hourly-avg-ct":
                return self._json(hourly_avg_ct(q))
            if tail == "comments-history":
                return self._json(comments_history())
            if tail == "clip-prewarm":
                return self._json({"ok": True, "queued": 0})
            if tail == "realtime":
                return self._json(realtime())
            if tail == "machines":
                return self._json(MGMT_MACHINES)
            if tail == "ct-history":
                return self._json(ct_history())
            if tail == "cycle-extremes":
                return self._json(cycle_extremes())
            if tail == "ct-histogram":
                return self._json(_load("mgmt/ct-histogram.json", {"total_cycles": 0, "buckets": []}))
            if tail == "status-log":
                return self._json(status_log())
            if tail == "hourly-loss-breakdown":
                return self._json(hourly_loss_breakdown())
            if tail == "production_history":
                data = _load("mgmt/production_history.json", [])
                return self._json(data if isinstance(data, list) else [])
            if tail == "ng-list":
                return self._json({"line_id": LINE_ID, "date": (q.get("date") or [RECORD_DATE])[0],
                                   "slot_label": (q.get("slot_label") or [""])[0], "count": 0, "rows": []})
        if p == f"/api/lines/{LINE_ID}":
            return self._json(_load("mgmt/line.json", {"id": LINE_ID, **LINE}))
        if p == f"/api/pm-status/line/{LINE_ID}":
            return self._json(_load("mgmt/pm-status.json", {}))
        if p.startswith("/api/poka-yoke/live/"):
            return self._json(_load("mgmt/py-live.json", []))
        if p.startswith("/api/poka-yoke/sensor-health/") or p.startswith("/api/poka-yoke/sensor-sweep/"):
            return self._json(_load("mgmt/py-health.json", {"line_id": LINE_ID, "health": "NO_PY", "counts": {"total": 0, "alive": 0, "stuck": 0, "unknown": 0}, "checks": []}))
        if p.startswith("/api/poka-yoke/bypass-episodes/"):
            return self._json({"line_id": LINE_ID, "date": RECORD_DATE, "shift": SHIFT,
                               "shift_start": f"{RECORD_DATE}T08:30:00", "shift_end": f"{RECORD_DATE}T17:15:00",
                               "episodes": [], "by_slot": {}, "slot_summary": {}, "merge_gap_sec": 60})
        if p.startswith("/api/lines/") and len(parts) >= 7 or p.startswith("/api/lines/") and len(parts) >= 6:
            if parts[4] == "cycles" and len(parts) >= 7 and parts[6] == "comments":
                pc, shift = unquote(parts[5]), (q.get("shift") or [""])[0]
                store = _load("comments.json", {"comments": [], "remarks": []})
                return self._json({"comments": [c for c in store["comments"]
                                                if c["part_code"] == pc and (not shift or c.get("shift") == shift)]})
            if parts[4] == "ng-process-remarks" and len(parts) >= 6:
                pc = unquote(parts[5])
                store = _load("comments.json", {"comments": [], "remarks": []})
                return self._json({"remarks": [r for r in store["remarks"] if r["part_code"] == pc]})
        if p.startswith("/api/submachines/") and p.endswith("/cycle-video"):
            try:
                sid = int(parts[3])
            except (ValueError, IndexError):
                return self._json({"detail": "bad sub_id"}, 400)
            return self._clip(f"sub_{sid}", q)
        if p == "/api/leaders/for-line":
            return self._json({"options": [], "default": ""})
        if p == "/api/prod-breakdown-slips/line-pending":
            return self._json({"line_id": LINE_ID, "count": 0, "slips": [], "by_shift": [], "grace_min": 0})
        if p == "/api/push/inbox":
            return self._json({"unread": 0, "items": []})
        if p == "/api/demo/machine":
            return self._json({**MACHINE_DEFAULTS, **_load("machine.json", {})})
        if p == "/api/demo/camera":
            cam = {**CAMERA_DEFAULTS, **_load("camera.json", {})}
            cam["password_set"] = bool(cam.get("password"))
            cam["password"] = ""                  # never send the stored password back
            return self._json(cam)
        if p == "/api/demo/camera/sample-clip":
            full = os.path.join(CLIPS, "sample.mp4")
            return self._file(full) if os.path.isfile(full) else self._json({"detail": "No sample clip"}, 404)
        return self._json({})                     # any other MES GET: harmless empty answer, never 401

    do_HEAD = do_GET

    def _static(self, path):
        rel = unquote(path).lstrip("/") or "index.html"
        full = os.path.normpath(os.path.join(DIST, rel))
        if not full.startswith(DIST + os.sep) or not os.path.isfile(full):
            if rel.startswith("assets/"):
                return self._json({"detail": "Not found"}, 404)
            full = os.path.join(DIST, "index.html")
        if not os.path.isfile(full):
            return self._json({"detail": "Frontend not built. Run: npx vite build"}, 503)
        if full.endswith("index.html"):
            cache = "no-store"
        elif os.sep + "assets" + os.sep in full:
            cache = "public, max-age=31536000, immutable"
        else:
            cache = "public, max-age=3600"
        return self._file(full, cache=cache)

    def do_POST(self):
        p = urlparse(self.path).path.rstrip("/")
        parts, body = p.split("/"), self._body()
        if p.startswith("/api/lines/") and len(parts) >= 7 and parts[4] == "cycles" and parts[6] == "comments":
            text = str(body.get("comment") or "").strip()
            if not text:
                return self._json({"detail": "Comment is empty"}, 400)
            with LOCK:
                store = _load("comments.json", {"comments": [], "remarks": []})
                row = {"id": len(store["comments"]) + 1, "part_code": unquote(parts[5]), "comment": text[:2000],
                       "author": "demo", "leader_name": body.get("leader_name"), "shift": body.get("shift") or SHIFT,
                       "record_date": body.get("record_date") or RECORD_DATE,
                       "machine_name": body.get("machine_name"), "created_at": _now_iso()}
                store["comments"].append(row)
                _save("comments.json", store)
            return self._json(row)
        if p.startswith("/api/lines/") and len(parts) >= 6 and parts[4] == "ng-process-remarks":
            text = str(body.get("remark_text") or "").strip()
            if not text:
                return self._json({"detail": "Remark is empty"}, 400)
            with LOCK:
                store = _load("comments.json", {"comments": [], "remarks": []})
                pc, mid = unquote(parts[5]), body.get("machine_id")
                store["remarks"] = [r for r in store["remarks"] if not (r["part_code"] == pc and r["machine_id"] == mid)]
                row = {"part_code": pc, "machine_id": mid, "machine_name": body.get("machine_name"),
                       "remark_text": text[:2000], "updated_at": _now_iso()}
                store["remarks"].append(row)
                _save("comments.json", store)
            return self._json(row)
        return self._json({"ok": True})           # e.g. /api/ui-timing beacons

    def do_PUT(self):
        p = urlparse(self.path).path.rstrip("/")
        body = self._body()
        if not isinstance(body, dict):
            return self._json({"detail": "JSON object expected"}, 400)
        if p == "/api/demo/machine":
            with LOCK:
                obj = {**MACHINE_DEFAULTS, **_load("machine.json", {}), **body}
                _save("machine.json", obj)
            return self._json(obj)
        if p == "/api/demo/camera":
            with LOCK:
                stored = {**CAMERA_DEFAULTS, **_load("camera.json", {})}
                obj = {**stored, **body}
                if body.get("password") in (None, ""):
                    obj["password"] = stored.get("password", "")   # blank = keep the stored password
                obj.pop("password_set", None)
                _save("camera.json", obj)
            out = {**obj, "password_set": bool(obj.get("password")), "password": ""}
            return self._json(out)
        return self._json({"ok": True})

    do_PATCH = do_PUT

    def do_DELETE(self):
        self._json({"ok": True})


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128

    def handle_error(self, request, client_address):
        # A viewer closing a clip drops its connection mid-transfer or while idle;
        # that is normal traffic, not a server fault, so keep it out of the log.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    print(f"MES demo clone on http://0.0.0.0:{PORT}  (data: {RECORD_DATE} shift {SHIFT}, "
          f"{len(CYCLES['machines'])} machines)", flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()
