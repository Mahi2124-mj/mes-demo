#!/usr/bin/env python3
"""MES demo clone — standalone server (Python standard library + optional ffmpeg).

Serves the built frontend from ./dist and a small /api that mimics the MES
endpoints the demo pages use. It never talks to the live MES (no database,
no calls to ports 8080/5555/5656/5700).

Two data sources:
  * Recorded (SUPERVISOR, MANAGEMENT): data/cycles.json — YCA-SS 2026-10-08 shift A,
    cycles #1600-#1700 that have a clip, with clips/<machine>/cycle_<seq>.mp4.
  * Live (MANAGEMENT-2, line id LIVE_LINE_ID): the demo machine's own PLC and camera.
    collector.py reads the FX5U over SLMP (read only) into data/live/, camera.py records
    the camera and cuts clips/live/cycle_<seq>.mp4 per cycle (needs ffmpeg).

Data:
  data/machine.json, data/camera.json — saved by the config pages (PLC / camera settings)
  data/comments.json — cycle comments / remarks typed in the demo
  data/live/ — live cycles and status timeline, one JSON-lines file per shift

Run:  python3 server.py [port]        (default 5000)
"""
import atexit
import datetime as dt
import json
import os
import random
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from camera import Camera
from collector import OFFLINE, Collector, LiveStore, ShiftClock
from demo_plc import DemoPlc, collector_settings, demo_cycle_times, signal_map

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
    "ideal_cycle_time": 10.0, "max_allowed_cycle": 40.0, "ok_ng_pulse_min_gap": 0.5,
    "ct_register": "D103", "ct_register_scale": 0.1,     # PLC-measured cycle time (blank = time between signals)
    "nf2_camera_id": "CAM-01", "machine_seq": 0,
    # Same lists the Machine Config page starts from; the collector reads these too.
    "monitor_registers": [
        {"register": r, "content": c, "unit": u, "example": e} for r, c, u, e in (
            ("D103", "Last cycle time", "0.1 s", "245 → 24.5 s"),
            ("D104", "Direction", "1 = A→B, 2 = B→A", "1 → A→B"),
            ("D105", "NG reason code", "Code", "Raw code"),
            ("D106", "Cycle sequence", "Count", "1287"),
            ("D107", "Target cycle time", "0.1 s", "200 → 20.0 s"),
            ("D109", "Final torque", "0.01 Nm", "1350 → 13.50 Nm"),
            ("D110", "Breakaway torque", "0.01 Nm", "1420 → 14.20 Nm"),
            ("D111", "Torque low limit", "0.01 Nm", "Default 1200 → 12.00 Nm"),
            ("D112", "Torque high limit", "0.01 Nm", "Default 1500 → 15.00 Nm"),
            ("D114", "Torque flags", "Bitmask", "One flag per bit"),
            ("D118", "Torque sequence handshake", "Counter", "Changes on each tightening"))],
    "inputs": [{"type": "digital", "address": a, "signal": sg, "note": n} for a, sg, n in (
        ("X0", "Gun in stand", "M18 inductive sensor"), ("X1", "Nut seated A", ""), ("X2", "Nut seated B", ""),
        ("X3", "Torque OK", ""), ("X4", "Torque NG", ""), ("X5", "Gun running", ""), ("X6", "Reset", ""),
        ("X7", "E-stop healthy", ""), ("X10", "Calibration mode", ""))] + [
        {"type": "analog", "address": "FX5-4AD CH1", "signal": "Torque A", "note": "±10 V = ±30 Nm"},
        {"type": "analog", "address": "FX5-4AD CH2", "signal": "Torque B", "note": "±10 V = ±30 Nm"}],
}
CAMERA_DEFAULTS = {
    "camera_id": "CAM-01", "name": "Station camera", "ip": "192.168.30.20", "port": 554,
    "rtsp_path": "/h264/ch1/main/av_stream", "username": "admin", "password": "",
    "assigned_machine": "Nut-Runner Demo Station", "recording_enabled": True,
    "codec": "H.264 Main", "resolution": "1920 × 1080", "fps": 25, "bitrate_kbps": 2000,
    "iframe_interval": 25, "video_save_path": os.path.join(HERE, "clips"),
    "retention_days": 30, "pre_roll_s": 0, "post_roll_s": 0,     # 0/0: clip length = cycle time
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


# ---------- live data (MANAGEMENT-2) ----------
# The live dashboard uses its own line id, so every /api/lines/<id>/... call it makes is
# answered from the PLC collector instead of the recorded shift.  Line rules (shifts,
# hourly slots, status codes) still come from data/mgmt/line.json.
LIVE_LINE_ID = 99


def machine_cfg():
    return {**MACHINE_DEFAULTS, **_load("machine.json", {})}


def camera_cfg():
    return {**CAMERA_DEFAULTS, **_load("camera.json", {})}


STORE = LiveStore(os.path.join(DATA, "live"))
CLOCK = ShiftClock(_line_cfg)
CAMERA = Camera(camera_cfg, CLIPS, HERE)
COLLECTOR = Collector(STORE, CLOCK, machine_cfg, _line_cfg, on_cycle=CAMERA.on_cycle)


def _live_ideal():
    return float(machine_cfg().get("ideal_cycle_time") or 20.0)


def _live_pick(q):
    """(record_date, shift) the live page asks for; default = the current production shift."""
    d, sh = (q.get("date") or [""])[0], (q.get("shift") or [""])[0]
    if d and sh and CLOCK.shift_row(sh):
        try:
            dt.date.fromisoformat(d)
            return d, sh
        except ValueError:
            pass
    rd, sh, _ = CLOCK.at(dt.datetime.now())
    return rd, sh


def _live_loss_types():
    out = {r["status_name"]: r.get("loss_type") for r in _line_cfg().get("status_map", [])}
    return out or {"BREAKDOWN": "breakdown", "QUALITY_ISSUE": "quality", "MODEL_SETUP": "setup",
                   "MATERIAL_WAIT": "material", "OTHER_LOSS": "others", "CHANGE_OVER": "change_over", "BREAK": "break"}


def _live_segments(rd, sh, t_from, t_to):
    """[(start, end, status)] from the shift's status log, clipped to [t_from, t_to]."""
    log = sorted(STORE.status_log(rd, sh), key=lambda e: e["ts"])
    segs = []
    for i, e in enumerate(log):
        s = dt.datetime.fromtimestamp(e["ts"] / 1000)
        n = dt.datetime.fromtimestamp(log[i + 1]["ts"] / 1000) if i + 1 < len(log) else t_to
        s, n = max(s, t_from), min(n, t_to)
        if n > s:
            segs.append((s, n, e["status"]))
    return segs


def _live_window(rd, sh):
    """Shift start/end, 'now' capped at the shift end, and when live data starts in this shift
    (first cycle or first PLC contact — time before the collector ran is not counted)."""
    row = CLOCK.shift_row(sh) or CLOCK.production_shifts()[0]
    t0, t1 = CLOCK.bounds(dt.date.fromisoformat(rd), row)
    now = min(dt.datetime.now(), t1)
    starts = [dt.datetime.fromtimestamp(e["ts"] / 1000) for e in STORE.status_log(rd, sh) if e.get("status") != OFFLINE]
    cyc = STORE.cycles(rd, sh)
    if cyc:
        starts.append(dt.datetime.fromisoformat(cyc[0]["ts"]) - dt.timedelta(seconds=cyc[0]["ct"]))
    w0 = max(t0, min(starts)) if starts else None
    return row, t0, t1, now, w0


def _live_slots(rd, sh):
    return [x for x in _line_cfg().get("hourly_slots", [])
            if x.get("shift_name") == sh and not str(x.get("db_column_prefix", "")).endswith("_ot")]


def _live_slot_bounds(rd, sh, sl):
    s0 = CLOCK.at_time(rd, sh, sl["start_time"])
    s1 = CLOCK.at_time(rd, sh, sl["end_time"])
    if s1 <= s0:
        s1 += dt.timedelta(days=1)
    return s0, s1


def live_realtime(q):
    rd, sh = _live_pick(q)
    ideal = _live_ideal()
    cfg = machine_cfg()
    row, t0, t1, now, w0 = _live_window(rd, sh)
    cyc = STORE.cycles(rd, sh)
    ok = sum(1 for c in cyc if not c["is_ng"])
    ng = len(cyc) - ok
    run_s = sum(c["ct"] for c in cyc)
    segs = _live_segments(rd, sh, w0, now) if w0 else []
    loss_types = _live_loss_types()
    loss, offline_s = {}, 0.0
    for s, e, st in segs:
        lt = loss_types.get(st)
        if lt:
            loss[lt] = loss.get(lt, 0.0) + (e - s).total_seconds()
        elif st == OFFLINE:
            offline_s += (e - s).total_seconds()
    # Breaks and time without PLC data (collector not connected) are not counted against availability.
    window_s = max(1.0, ((now - w0).total_seconds() if w0 else 0.0) - loss.get("break", 0.0) - offline_s)
    # Net speed loss: a slow cycle adds (CT - ideal), a fast one takes it back, so it can go negative.
    speed_loss = sum(c["ct"] - ideal for c in cyc)
    avail = min(100.0, 100.0 * run_s / window_s) if w0 else 0.0
    perf = min(100.0, 100.0 * (run_s - speed_loss) / run_s) if run_s else 0.0
    qual = 100.0 * ok / len(cyc) if cyc else 0.0
    oee = avail * perf * qual / 10000.0
    grade = ("EXCELLENT" if oee >= 85 else "GOOD" if oee >= 75 else "AVERAGE" if oee >= 65 else "POOR")
    working_min = float(row.get("working_minutes") or ((t1 - t0).total_seconds() / 60))
    shift_plan = int(working_min * 60 // ideal)
    current = CLOCK.at(dt.datetime.now())[:2] == (rd, sh)
    rt = {
        "record_date": rd, "shift_name": sh, "line_name": LINE["line_name"],
        "shift_start_time": row.get("start_time"), "shift_end_time": row.get("end_time"),
        "operating_status": COLLECTOR.current_status() if current else "IDLE",
        "current_model_number": None, "current_model_name": None,
        "machine_name": cfg.get("machine_name"),
        "ok_count": ok, "ng_count": ng, "shift_plan": shift_plan,
        "cycle_time_plan": ideal, "cycle_time_actual": round(run_s / len(cyc), 2) if cyc else None,
        "availability": round(avail, 2), "performance": round(perf, 2), "quality_oee": round(qual, 2),
        "overall_oee": round(oee, 2), "oee_grade": grade, "is_shift_completed": dt.datetime.now() >= t1,
        "is_gap_time": False,
        "loss_breakdown_seconds": round(loss.get("breakdown", 0)), "loss_quality_seconds": round(loss.get("quality", 0)),
        "loss_setup_seconds": round(loss.get("setup", 0)), "loss_material_seconds": round(loss.get("material", 0)),
        "loss_others_seconds": round(loss.get("others", 0)), "loss_change_over_seconds": round(loss.get("change_over", 0)),
        "loss_speed_seconds": round(speed_loss),
        "min_ct": min((c["ct"] for c in cyc), default=None), "max_ct": max((c["ct"] for c in cyc), default=None),
        "collector_status": "running" if COLLECTOR.snapshot().get("state") == "connected" else "stopped",
        "ot_active_shift": None, "ot_plan": None,
        "takt_seconds": ideal, "working_minutes": working_min,
        "planned_takt_seconds": ideal, "energy_per_part": None, "andon_calls": 0,
    }
    newest = [c["ct"] for c in reversed(cyc)][:20]
    for i, v in enumerate(newest):
        rt[f"ct{i + 1}"] = v
    rt["ct_avg_20"] = round(sum(newest) / len(newest), 2) if newest else None
    plan_done = 0
    offline = [(s, e) for s, e, st in segs if st == OFFLINE]
    for sl in _live_slots(rd, sh):
        s0, s1 = _live_slot_bounds(rd, sh, sl)
        inside = [c for c in cyc if s0 <= dt.datetime.fromisoformat(c["ts"]) < s1]
        full = float(sl.get("working_minutes") or (s1 - s0).total_seconds() / 60) * 60 / ideal
        lo, hi = max(s0, w0) if w0 else s1, min(s1, now)
        # plan accrues only while there is PLC data (same rule as availability)
        no_data = sum(max(0.0, (min(e, hi) - max(s, lo)).total_seconds()) for s, e in offline)
        plan = int(full * max(0.0, (hi - lo).total_seconds() - no_data) / (s1 - s0).total_seconds())
        plan_done += plan
        sok = sum(1 for c in inside if not c["is_ng"])
        pre = sl["db_column_prefix"]
        rt.update({f"{pre}_plan": plan, f"{pre}_ok": sok, f"{pre}_ng": len(inside) - sok,
                   f"{pre}_actual": len(inside), f"{pre}_variance": len(inside) - plan})
    rt["shift_plan_completed"] = plan_done
    rt["shift_plan_remaining"] = max(0, shift_plan - plan_done)
    return rt


def live_hourly_loss_breakdown(q):
    rd, sh = _live_pick(q)
    ideal = _live_ideal()
    _, _, _, now, w0 = _live_window(rd, sh)
    cyc = STORE.cycles(rd, sh)
    loss_types = _live_loss_types()
    keys = ("loss_breakdown", "loss_quality", "loss_material", "loss_setup", "loss_change_over", "loss_speed", "loss_others")
    slots, tot = [], dict.fromkeys(keys + ("total_loss",), 0)
    for sl in _live_slots(rd, sh):
        s0, s1 = _live_slot_bounds(rd, sh, sl)
        row = {"slot_label": sl["slot_label"], "start": sl["start_time"][:5], "end": sl["end_time"][:5],
               **dict.fromkeys(keys, 0)}
        row["loss_speed"] = round(sum(c["ct"] - ideal for c in cyc
                                      if s0 <= dt.datetime.fromisoformat(c["ts"]) < s1))
        if w0:
            for s, e, st in _live_segments(rd, sh, max(s0, w0), min(s1, now)):
                lt = loss_types.get(st)
                if lt and f"loss_{lt}" in row:
                    row[f"loss_{lt}"] += round((e - s).total_seconds())
        row["total_loss"] = sum(row[k] for k in keys)
        for k in keys + ("total_loss",):
            tot[k] += row[k]
        slots.append(row)
    return {"date": rd, "shift_name": sh, "slots": slots, "totals": tot}


def live_ct_history(q):
    rd, sh = _live_pick(q)
    return [{"id": c["cycle_seq"], "ts": c["ts"], "record_date": rd, "shift_name": sh, "ct_value": c["ct"],
             "cycle_seq": c["cycle_seq"], "part_code": c.get("part_code"), "is_ng": c["is_ng"]}
            for c in STORE.cycles(rd, sh)]


def live_cycle_extremes(q):
    rd, sh = _live_pick(q)
    cyc = STORE.cycles(rd, sh)
    if not cyc:
        return {"min": None, "max": None, "shift": sh, "date": rd}
    pick = lambda c: {"ts": c["ts"], "ct_value": c["ct"], "part_code": c.get("part_code"),
                      "is_ng": c["is_ng"], "cycle_seq": c["cycle_seq"], "shift_name": sh}
    return {"min": pick(min(cyc, key=lambda c: c["ct"])), "max": pick(max(cyc, key=lambda c: c["ct"])),
            "shift": sh, "date": rd}


def live_status_log(q):
    rd, sh = _live_pick(q)
    return [{"ts": e["ts"], "nowMinFrac": e["nowMinFrac"], "status": e["status"], "shift": sh}
            for e in STORE.status_log(rd, sh)]


def live_production_history():
    ideal = _live_ideal()
    by_day = {}
    for d, sh, _ in STORE.shift_files():
        cyc = STORE.cycles(d, sh)
        row = CLOCK.shift_row(sh) or {}
        e = by_day.setdefault(d, {"record_date": d, "total_actual": 0, "total_plan": 0})
        e["total_actual"] += sum(1 for c in cyc if not c["is_ng"])
        e["total_plan"] += int(float(row.get("working_minutes") or 0) * 60 // ideal)
    return [by_day[k] for k in sorted(by_day)]


def live_ng_list(q):
    d = (q.get("date") or [""])[0] or _live_pick({})[0]
    label = (q.get("slot_label") or [""])[0]
    lo, hi = (label.split("-") + [""])[:2] if label and label != "00:00-23:59" else ("", "")
    rows = []
    for rd, sh, _ in STORE.shift_files():
        if rd != d:
            continue
        for c in STORE.cycles(rd, sh):
            hm = c["ts"][11:16]
            if c["is_ng"] and (not lo or (lo <= hm < hi if lo < hi else hm >= lo or hm < hi)):
                rows.append({"ts": c["ts"], "part_code": c.get("part_code"), "cycle_seq": c["cycle_seq"],
                             "ct_value": c["ct"], "shift_name": sh, "leader_remark": ""})
    return {"line_id": LIVE_LINE_ID, "date": d, "slot_label": label, "count": len(rows), "rows": rows}


def live_line():
    cfg = machine_cfg()
    line = _load("mgmt/line.json", {"id": LINE_ID, **LINE})
    ideal = _live_ideal()
    return {**line, "id": LIVE_LINE_ID, "ideal_cycle_time": ideal, "planned_takt_time": ideal,
            "collector_status": "running" if COLLECTOR.snapshot().get("state") == "connected" else "stopped",
            "plc_config": {"id": 1, "line_id": LIVE_LINE_ID, "machine_name": cfg.get("machine_name"),
                           "machine_seq": None, "parent_plc_id": None, "ideal_cycle_time": ideal,
                           "max_allowed_cycle": cfg.get("max_allowed_cycle")}}


class DemoRun:
    """'Run demo' on the Collector panel: wipe the live data, then let the demo PLC play N cycles
    (ideal CT ± a mix) through the normal collector -> camera -> dashboard path."""

    def __init__(self):
        self.lock = threading.Lock()
        self.plc = None
        self.info = {"state": "idle", "total": 0, "done": 0, "ng": 0, "last_ct": None, "camera": None, "error": None}

    def snapshot(self):
        with self.lock:
            return dict(self.info)

    def _set(self, **kw):
        with self.lock:
            self.info.update(kw)

    def start(self, n):
        with self.lock:
            if self.info["state"] in ("starting", "running", "finishing"):
                return False
            self.info = {"state": "starting", "total": n, "done": 0, "ng": 0, "last_ct": None, "camera": None, "error": None}
        threading.Thread(target=self._run, args=(n,), name="demo-run", daemon=True).start()
        return True

    def stop(self):
        if self.plc:
            self.plc.stop()

    def _wait(self, cond, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if cond():
                return True
            if self.plc and self.plc.stopped.is_set():
                return False
            time.sleep(0.2)
        return False

    def _run(self, n):
        ideal = _live_ideal()
        self.plc = DemoPlc()
        try:
            port = self.plc.start()
            # Real camera if it is streaming, else a generated test picture (needs ffmpeg either way).
            cam_mode = "camera" if CAMERA.snapshot().get("state") == "streaming" else "synthetic"
            if not CAMERA.ffmpeg:
                cam_mode = None
            saved = machine_cfg()                  # the OK/NG/status/CT addresses saved on PLC Config
            COLLECTOR.set_override(collector_settings(saved, port))
            COLLECTOR.reset_data()
            CAMERA.reset_clips()
            if cam_mode:
                CAMERA.set_demo(cam_mode)
            self._set(camera=cam_mode or "none (ffmpeg not found)")
            if not self._wait(lambda: COLLECTOR.snapshot().get("state") == "connected", 15):
                raise RuntimeError("the collector did not connect to the demo PLC")
            if cam_mode:
                if not self._wait(lambda: CAMERA.snapshot().get("recording"), 30):
                    raise RuntimeError(CAMERA.snapshot().get("last_error") or "the camera recording did not start")
                time.sleep(5)            # recording must cover the first cycle's start and pre-roll
            self._set(state="running")
            cts = demo_cycle_times(n, ideal)
            ng = set(random.sample(range(2, n + 1), 2)) if n >= 5 else set()   # 2 NG to show the NG signal too

            def counted(i, ct, is_ng):
                with self.lock:
                    self.info.update(done=i, last_ct=ct, ng=self.info["ng"] + int(is_ng))
            finished = self.plc.play(cts, ideal, signal_map(saved), ng_cycles=ng, on_cycle=counted)
            self._set(state="finishing")
            if finished:
                post = float(camera_cfg().get("post_roll_s") or 0)
                time.sleep(post + 6)     # let the last clip be cut before the camera goes back
            self._set(state="done" if finished else "stopped")
        except Exception as e:  # noqa: BLE001
            if self.plc.stopped.is_set():
                self._set(state="stopped")
            else:
                self._set(state="error", error=str(e))
        finally:
            COLLECTOR.set_override(None)
            CAMERA.set_demo(None)
            self.plc.stop()


DEMO = DemoRun()


def cycle_videos_view(q):
    """Cycle Videos page: per cycle its cycle time next to the length of its saved clip."""
    rd, sh = _live_pick(q)
    cam = camera_cfg()
    pre, post = float(cam.get("pre_roll_s") or 0), float(cam.get("post_roll_s") or 0)
    rows = []
    for c in reversed(STORE.cycles(rd, sh)):
        info = CAMERA.clip_info(c["cycle_seq"])
        expected = round(c["ct"] + pre + post, 2)
        video = info.get("duration") if info else None
        rows.append({"cycle_seq": c["cycle_seq"], "ts": c["ts"], "ct": c["ct"], "is_ng": c["is_ng"],
                     "part_code": c.get("part_code"), "capped": c.get("capped"), "clip": info is not None,
                     "video_s": video, "expected_s": expected,
                     "diff_s": None if video is None else round(video - expected, 2)})
    shifts = [{"record_date": d, "shift_name": s_} for d, s_, _ in reversed(STORE.shift_files())]
    if not any(x["record_date"] == rd and x["shift_name"] == sh for x in shifts):
        shifts.insert(0, {"record_date": rd, "shift_name": sh})
    return {"record_date": rd, "shift_name": sh, "ideal_ct": _live_ideal(), "pre_roll_s": pre, "post_roll_s": post,
            "shifts": shifts, "rows": rows}


def collector_view():
    """Everything the 'Collector data' panels show, in one poll."""
    rd, sh, in_gap = CLOCK.at(dt.datetime.now())
    cyc = STORE.cycles(rd, sh)
    cam = CAMERA.snapshot()
    cfg = machine_cfg()
    recent = []
    for c in reversed(cyc[-25:]):
        recent.append({**c, "clip": CAMERA.clip_path(c["cycle_seq"]) is not None})
    cfg = {**cfg, **(COLLECTOR.override or {})}      # demo run: show the demo PLC's address
    return {
        "plc": {**COLLECTOR.snapshot(), "plc_ip": cfg.get("plc_ip"), "plc_port": cfg.get("plc_port"),
                "protocol": cfg.get("protocol"), "count_mode": cfg.get("count_mode"),
                "machine_name": cfg.get("machine_name"), "status": COLLECTOR.current_status(),
                "ideal_cycle_time": _live_ideal(), "ct_register": cfg.get("ct_register"),
                "demo_plc": COLLECTOR.override is not None},
        "shift": {"record_date": rd, "shift_name": sh, "in_gap": in_gap,
                  "ok": sum(1 for c in cyc if not c["is_ng"]), "ng": sum(1 for c in cyc if c["is_ng"]),
                  "total": len(cyc)},
        "recent_cycles": recent,
        "camera": {**cam, "ip": camera_cfg().get("ip"), "name": camera_cfg().get("name"),
                   "recording_enabled": bool(camera_cfg().get("recording_enabled"))},
        "demo": DEMO.snapshot(),
        "server_time": dt.datetime.now().isoformat(timespec="seconds"),
    }


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
            if (q.get("source") or [""])[0] == "live":
                return self._json({**LINE, "line_id": LIVE_LINE_ID})
            return self._json(LINE)
        if (p.startswith("/api/lines/") and len(parts) >= 4 and not parts[3].isdigit()) or \
           (p.startswith("/api/poka-yoke/") and len(parts) >= 5 and not parts[4].isdigit()):
            return self._json({"detail": "line id must be an integer"}, 422)
        if p.startswith("/api/demo/"):
            return self._demo_get(p, q)
        live = str(LIVE_LINE_ID)
        if (len(parts) >= 4 and parts[2] == "lines" and parts[3] == live) or \
           (len(parts) >= 5 and parts[2] == "poka-yoke" and parts[4] == live) or p == f"/api/pm-status/line/{live}":
            return self._live_get(p, parts, q)
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
        return self._json({})                     # any other MES GET: harmless empty answer, never 401

    do_HEAD = do_GET

    def _demo_get(self, p, q):
        if p == "/api/demo/machine":
            return self._json(machine_cfg())
        if p == "/api/demo/camera":
            cam = camera_cfg()
            cam["password_set"] = bool(cam.get("password"))
            cam["password"] = ""                  # never send the stored password back
            return self._json(cam)
        if p == "/api/demo/camera/sample-clip":
            full = os.path.join(CLIPS, "sample.mp4")
            return self._file(full) if os.path.isfile(full) else self._json({"detail": "No sample clip"}, 404)
        if p == "/api/demo/collector":
            return self._json(collector_view())
        if p == "/api/demo/cycle-videos":
            return self._json(cycle_videos_view(q))
        if p == "/api/demo/camera/live.mjpg":
            return self._mjpeg()
        if p == "/api/demo/camera/snapshot.jpg":
            return self._snapshot()
        return self._json({"detail": "Not found"}, 404)

    def _live_get(self, p, parts, q):
        if p == f"/api/lines/{LIVE_LINE_ID}":
            return self._json(live_line())
        if p.startswith("/api/pm-status/"):
            return self._json({"line_id": LIVE_LINE_ID, "line_name": LINE["line_name"], "as_of": dt.date.today().isoformat(),
                               "counts": {"overdue": 0, "due": 0, "ok": 0, "no_plan": 0}, "machines": []})
        if p.startswith("/api/poka-yoke/sensor-health/") or p.startswith("/api/poka-yoke/sensor-sweep/"):
            return self._json({"line_id": LIVE_LINE_ID, "health": "NO_PY",
                               "counts": {"total": 0, "alive": 0, "stuck": 0, "unknown": 0}, "checks": []})
        if p.startswith("/api/poka-yoke/bypass-episodes/"):
            rd, sh = _live_pick(q)
            return self._json({"line_id": LIVE_LINE_ID, "date": rd, "shift": sh, "episodes": [], "by_slot": {},
                               "slot_summary": {}, "merge_gap_sec": 60})
        if p.startswith("/api/poka-yoke/"):
            return self._json([])
        tail = "/".join(parts[4:])
        if tail == "realtime":
            return self._json(live_realtime(q))
        if tail == "ct-history":
            return self._json(live_ct_history(q))
        if tail == "cycle-extremes":
            return self._json(live_cycle_extremes(q))
        if tail == "status-log":
            return self._json(live_status_log(q))
        if tail == "hourly-loss-breakdown":
            return self._json(live_hourly_loss_breakdown(q))
        if tail == "ct-histogram":             # kept as before: the line's recorded 30-day distribution
            return self._json(_load("mgmt/ct-histogram.json", {"total_cycles": 0, "buckets": []}))
        if tail == "production_history":
            return self._json(live_production_history())
        if tail == "ng-list":
            return self._json(live_ng_list(q))
        if tail == "machines":
            return self._json([{"id": 1, "machine_name": machine_cfg().get("machine_name"),
                                "machine_seq": None, "parent_plc_id": None}])
        if tail in ("cycle-video", "archive-video"):
            try:
                seq = int((q.get("cycle_seq") or [""])[0])
            except ValueError:
                return self._json({"detail": "cycle_seq required"}, 400)
            full = CAMERA.clip_path(seq)
            if not full:
                return self._json({"detail": "No clip for this cycle"}, 404)
            return self._file(full, cache="private, max-age=86400", extra={"X-Clip-Source": "archive", "X-Video-Offset": "0"})
        if tail == "comments-history":
            return self._json(comments_history())
        if tail == "clip-prewarm":
            return self._json({"ok": True, "queued": 0})
        if len(parts) >= 7 and parts[4] == "cycles" and parts[6] == "comments":
            pc, shift = unquote(parts[5]), (q.get("shift") or [""])[0]
            store = _load("comments.json", {"comments": [], "remarks": []})
            return self._json({"comments": [c for c in store["comments"]
                                            if c["part_code"] == pc and (not shift or c.get("shift") == shift)]})
        if len(parts) >= 6 and parts[4] == "ng-process-remarks":
            pc = unquote(parts[5])
            store = _load("comments.json", {"comments": [], "remarks": []})
            return self._json({"remarks": [r for r in store["remarks"] if r["part_code"] == pc]})
        return self._json({})

    def _mjpeg(self):
        """Live camera preview as multipart JPEG (an <img> plays it directly)."""
        CAMERA.add_viewer()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            if self.command == "HEAD":
                return
            no, idle = -1, 0.0
            while idle < 60:                      # give up after a minute without a frame
                jpeg, no2 = CAMERA.wait_frame(no, 5.0)
                if jpeg is None:
                    idle += 5
                    continue
                idle, no = 0.0, no2
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpeg)
                                 + jpeg + b"\r\n")
                self.wfile.flush()
        except OSError:
            pass                                  # viewer closed the preview
        finally:
            CAMERA.remove_viewer()

    def _snapshot(self):
        CAMERA.add_viewer()
        try:
            jpeg, _ = CAMERA.wait_frame(-1, 10.0)
        finally:
            CAMERA.remove_viewer()
        if not jpeg:
            return self._json({"detail": CAMERA.snapshot().get("last_error") or "No picture from the camera"}, 503)
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(jpeg)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(jpeg)

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
        if p == "/api/demo/run-demo":
            if body.get("stop"):
                DEMO.stop()
                return self._json(DEMO.snapshot())
            try:
                n = max(1, min(200, int(body.get("cycles") or 30)))
            except (TypeError, ValueError):
                return self._json({"detail": "cycles must be a number"}, 400)
            if not DEMO.start(n):
                return self._json({"detail": "A demo is already running"}, 409)
            return self._json(DEMO.snapshot())
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
            COLLECTOR.reload()                    # reconnect with the new PLC settings
            return self._json(obj)
        if p == "/api/demo/camera":
            with LOCK:
                stored = {**CAMERA_DEFAULTS, **_load("camera.json", {})}
                obj = {**stored, **body}
                if body.get("password") in (None, ""):
                    obj["password"] = stored.get("password", "")   # blank = keep the stored password
                obj.pop("password_set", None)
                _save("camera.json", obj)
            CAMERA.reload()                       # restart the stream with the new camera settings
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
    print(f"MES demo clone on http://0.0.0.0:{PORT}  (recorded data: {RECORD_DATE} shift {SHIFT}, "
          f"{len(CYCLES['machines'])} machines)", flush=True)
    m, c = machine_cfg(), camera_cfg()
    print(f"Live data (MANAGEMENT-2): PLC {m.get('plc_ip')}:{m.get('plc_port')}, camera {c.get('ip')}, "
          f"ffmpeg: {CAMERA.ffmpeg or 'NOT FOUND (no clips, snapshot preview only)'}", flush=True)
    atexit.register(CAMERA.stop)              # never leave ffmpeg running after the server
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))   # stop.sh: exit through atexit
    COLLECTOR.start()
    CAMERA.start()
    try:
        Server(("0.0.0.0", PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        pass
