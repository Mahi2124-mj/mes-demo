"""Live data collector for the demo machine (FX5U over SLMP) — read only.

Polls the PLC configured on the Machine Config page and turns its OK/NG
signals into cycles, the status word into a status timeline, and keeps the
latest raw values for the "Collector data" view.  Everything is stored under
data/live/ (one JSON-lines file per shift), and each cycle is handed to the
camera recorder so it can cut that cycle's clip.

Shift rules come from data/mgmt/line.json.  Cycles made in a GAP shift
(overtime) belong to the production shift that just ended.
"""
import datetime as dt
import json
import os
import threading
import time

from slmp import SlmpClient, SlmpError, parse_address, format_address, to_signed

FAST_POLL_S = 0.1          # OK/NG signals
SLOW_POLL_S = 1.0          # status word, counters, monitor registers, inputs
HEARTBEAT_S = 10.0
OFFLINE = "PLC OFFLINE"

# Andon (loss) registers on Machine Config: a value other than 0 means that loss is on. When more
# than one is on, the first in this list wins. (config key, label, status on the timeline, default)
ANDON = (("andon_maintenance", "Maintenance", "BREAKDOWN", "D100"),
         ("andon_quality", "Quality", "QUALITY_ISSUE", "D200"),
         ("andon_material", "Material", "MATERIAL_WAIT", "D300"),
         ("andon_setup", "Setup", "MODEL_SETUP", "D400"),
         ("andon_change_over", "Change over", "CHANGE_OVER", "D500"),
         ("andon_others", "Other losses", "OTHER_LOSS", "D600"))

DEFAULT_STATUS_MAP = {0: ("IDLE", None), 1: ("RUNNING", None), 2: ("BREAKDOWN", "breakdown"),
                      3: ("QUALITY_ISSUE", "quality"), 4: ("MODEL_SETUP", "setup"),
                      5: ("MATERIAL_WAIT", "material"), 6: ("OTHER_LOSS", "others"),
                      7: ("CHANGE_OVER", "change_over"), 8: ("BREAK", "break")}


def _now():
    return dt.datetime.now()


def min_frac(t):
    return round(t.hour * 60 + t.minute + t.second / 60 + t.microsecond / 6e7, 5)


# ---------- shifts ----------
class ShiftClock:
    """Maps a wall-clock time to (record_date, production shift) using line.json."""

    def __init__(self, get_line_cfg):
        self.get_line_cfg = get_line_cfg

    def production_shifts(self):
        rows = [s for s in self.get_line_cfg().get("shifts", []) if s.get("is_production")]
        return rows or [{"shift_name": "A", "start_time": "08:30:00", "end_time": "17:15:00",
                         "crosses_midnight": False, "working_minutes": 465}]

    def shift_row(self, name):
        return next((s for s in self.production_shifts() if s.get("shift_name") == name), None)

    @staticmethod
    def bounds(day, s):
        t0 = dt.datetime.combine(day, dt.time.fromisoformat(s["start_time"]))
        t1 = dt.datetime.combine(day, dt.time.fromisoformat(s["end_time"]))
        if t1 <= t0:
            t1 += dt.timedelta(days=1)
        return t0, t1

    def at(self, t):
        """-> (record_date 'YYYY-MM-DD', shift_name, in_gap)."""
        best = None
        for back in (0, 1, 2):
            day = t.date() - dt.timedelta(days=back)
            for s in self.production_shifts():
                t0, t1 = self.bounds(day, s)
                if t0 <= t < t1:
                    return day.isoformat(), s["shift_name"], False
                if t1 <= t and (best is None or t1 > best[0]):
                    best = (t1, day, s["shift_name"])
        if best is None:
            return t.date().isoformat(), self.production_shifts()[0]["shift_name"], True
        return best[1].isoformat(), best[2], True

    def at_time(self, record_date, shift_name, hhmmss):
        """Clock time inside a shift -> datetime (handles shifts that cross midnight)."""
        day = dt.date.fromisoformat(record_date)
        s = self.shift_row(shift_name)
        t = dt.datetime.combine(day, dt.time.fromisoformat(hhmmss))
        if s and t < self.bounds(day, s)[0]:
            t += dt.timedelta(days=1)
        return t


# ---------- storage ----------
class LiveStore:
    """data/live/cycles/<date>_<shift>.jsonl, data/live/status/<date>_<shift>.jsonl, data/live/state.json"""

    def __init__(self, root):
        self.root = root
        self.cdir = os.path.join(root, "cycles")
        self.sdir = os.path.join(root, "status")
        os.makedirs(self.cdir, exist_ok=True)
        os.makedirs(self.sdir, exist_ok=True)
        self.lock = threading.RLock()
        self._cache = {}                     # path -> (mtime, size, rows)
        self.state = self._read_json(os.path.join(root, "state.json"), {"last_seq": 0})

    @staticmethod
    def _read_json(path, default):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return default

    def save_state(self):
        path = os.path.join(self.root, "state.json")
        with self.lock:
            try:
                with open(path + ".tmp", "w", encoding="utf-8") as f:
                    json.dump(self.state, f)
                os.replace(path + ".tmp", path)
            except OSError:
                pass                         # e.g. Windows antivirus holding the file: the next save catches up

    def next_seq(self):
        with self.lock:
            self.state["last_seq"] = int(self.state.get("last_seq") or 0) + 1
            self.save_state()
            return self.state["last_seq"]

    def clear(self):
        """Delete every stored cycle and status entry and restart the cycle numbers at 1."""
        with self.lock:
            for d in (self.cdir, self.sdir):
                for n in os.listdir(d):
                    try:
                        os.remove(os.path.join(d, n))
                    except OSError:
                        pass
            self._cache.clear()
            self.state["last_seq"] = 0
            self.save_state()

    @staticmethod
    def key(record_date, shift):
        return f"{record_date}_{shift}.jsonl"

    def _rows(self, path):
        with self.lock:
            try:
                st = os.stat(path)
            except OSError:
                return []
            hit = self._cache.get(path)
            if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
                return hit[2]
            rows = []
            with open(path, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            rows.append(json.loads(line))
                        except ValueError:
                            pass             # a half-written last line after a crash
            self._cache[path] = (st.st_mtime_ns, st.st_size, rows)
            return rows

    def _append(self, path, row):
        with self.lock:
            with open(path, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")

    def add_cycle(self, record_date, shift, row):
        self._append(os.path.join(self.cdir, self.key(record_date, shift)), row)

    def cycles(self, record_date, shift):
        return self._rows(os.path.join(self.cdir, self.key(record_date, shift)))

    def add_status(self, record_date, shift, row):
        self._append(os.path.join(self.sdir, self.key(record_date, shift)), row)

    def status_log(self, record_date, shift):
        return self._rows(os.path.join(self.sdir, self.key(record_date, shift)))

    def shift_files(self):
        """[(record_date, shift, path)] for every stored shift, oldest first."""
        out = []
        for name in sorted(os.listdir(self.cdir)):
            if name.endswith(".jsonl") and "_" in name:
                d, s = name[:-6].split("_", 1)
                out.append((d, s, os.path.join(self.cdir, name)))
        return out


# ---------- collector ----------
def _group(addrs, max_span=64, max_gap=8):
    """Merge (dev, n) pairs into contiguous read blocks: [(dev, start, count)]."""
    blocks = []
    for dev, n in sorted(set(addrs)):
        if blocks and blocks[-1][0] == dev and n - (blocks[-1][1] + blocks[-1][2] - 1) <= max_gap \
                and n - blocks[-1][1] + 1 <= max_span:
            blocks[-1][2] = n - blocks[-1][1] + 1
        else:
            blocks.append([dev, n, 1])
    return blocks


class Collector:
    def __init__(self, store, clock, get_machine_cfg, get_line_cfg, on_cycle=None):
        self.store, self.clock = store, clock
        self.get_machine_cfg, self.get_line_cfg = get_machine_cfg, get_line_cfg
        self.on_cycle = on_cycle
        self.cfg_version = 0                 # bumped by the server when the machine config is saved
        self.lock = threading.Lock()
        self.info = {"state": "starting", "last_error": None, "connected_since": None,
                     "last_poll": None, "poll_ms": None, "values": {}, "registers": [], "inputs": [],
                     "events": 0}
        self.slock = threading.Lock()        # status log writes (collector + heartbeat threads)
        self.status = None                   # current status name
        self.status_code = None
        self.status_key = None               # (record_date, shift) the status was last logged for
        self.last_cycle_at = None            # datetime of the last OK/NG signal
        self.last_cycle_key = None
        self.connected_at = None             # when the current PLC connection came up
        self.last_ct = None                  # CT of the last cycle (how long RUNNING lasts without a signal)
        self.andon = None                    # label of the andon call that set the current status
        self.override = None                 # PLC settings used instead of the saved ones (demo PLC)

    # ----- public -----
    def start(self):
        self._log_downtime_since_heartbeat()
        self._resume_last_cycle()
        threading.Thread(target=self._run, name="collector", daemon=True).start()
        threading.Thread(target=self._heartbeat, name="collector-hb", daemon=True).start()

    def reload(self):
        self.cfg_version += 1

    def set_override(self, cfg):
        """Read another PLC (e.g. the demo PLC) without touching the saved Machine Config; None = back."""
        self.override = cfg
        self.reload()

    def reset_data(self):
        """Forget every live cycle and status entry (and the in-memory cycle/status state)."""
        with self.slock:
            self.store.clear()
            self.status = self.status_code = self.status_key = self.andon = None
            self.last_cycle_at = self.last_cycle_key = self.last_ct = None
        with self.lock:
            self.info["events"] = 0

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.info))

    def current_status(self):
        return self.status or OFFLINE

    # ----- internals -----
    def _set(self, **kw):
        with self.lock:
            self.info.update(kw)

    def _status_map(self):
        rows = self.get_line_cfg().get("status_map") or []
        m = {int(r["status_code"]): (r["status_name"], r.get("loss_type")) for r in rows if "status_code" in r}
        return m or DEFAULT_STATUS_MAP

    def _log_status(self, name, code=None, andon=None):
        with self.slock:
            when = _now()
            rd, sh, _ = self.clock.at(when)
            key = (rd, sh)
            if name == self.status and key == self.status_key and andon == self.andon:
                return
            self.status, self.status_code, self.status_key, self.andon = name, code, key, andon
            row = {"ts": int(when.timestamp() * 1000), "nowMinFrac": min_frac(when),
                   "status": name, "code": code, "shift": sh}
            if andon:
                row["andon"] = andon
            self.store.add_status(rd, sh, row)

    def _heartbeat(self):
        while True:
            time.sleep(HEARTBEAT_S)
            try:
                with self.store.lock:
                    self.store.state["heartbeat"] = time.time()
                    self.store.save_state()
                # Shift changed with no status change: open the new shift's timeline.
                if self.status:
                    self._log_status(self.status, self.status_code, self.andon)
            except OSError:
                pass

    def _resume_last_cycle(self):
        """After a restart the next cycle is still timed from the last stored signal of this shift
        (the time the server was down is logged as PLC OFFLINE and left out of the cycle time)."""
        rd, sh, _ = self.clock.at(_now())
        cyc = self.store.cycles(rd, sh)
        if cyc:
            try:
                self.last_cycle_at, self.last_cycle_key = dt.datetime.fromisoformat(cyc[-1]["ts"]), (rd, sh)
                self.last_ct = cyc[-1].get("ct")
            except (KeyError, ValueError):
                pass

    def _log_downtime_since_heartbeat(self):
        """The server was down: close the open status at the last heartbeat with PLC OFFLINE."""
        hb = self.store.state.get("heartbeat")
        if not hb or time.time() - hb < 3 * HEARTBEAT_S:
            return
        when = dt.datetime.fromtimestamp(hb)
        rd, sh, _ = self.clock.at(when)
        log = self.store.status_log(rd, sh)
        if log and log[-1].get("status") != OFFLINE:
            self.store.add_status(rd, sh, {"ts": int(hb * 1000), "nowMinFrac": min_frac(when),
                                           "status": OFFLINE, "code": None, "shift": sh})

    def _run(self):
        backoff = 1.0
        while True:
            cfg = {**self.get_machine_cfg(), **(self.override or {})}
            version = self.cfg_version
            ip = str(cfg.get("plc_ip") or "").strip()
            proto = str(cfg.get("protocol") or "")
            if not ip:
                self._set(state="not_configured", last_error="PLC IP is not set (Machine Config)")
                self._log_status(OFFLINE)
                time.sleep(1.0)
                continue
            if "ASCII" in proto.upper():
                self._set(state="error", last_error="MC 3E ASCII is not supported here; set the PLC's SLMP port to binary and pick SLMP 3E (binary)")
                self._log_status(OFFLINE)
                time.sleep(2.0)
                continue
            client = SlmpClient(ip, cfg.get("plc_port") or 5000, "4E" if "4E" in proto.upper() else "3E")
            self._set(state="connecting", plc=f"{ip}:{cfg.get('plc_port') or 5000}")
            try:
                client.connect()
                self.connected_at = _now()
                self._set(state="connected", last_error=None, connected_since=self.connected_at.isoformat(timespec="seconds"))
                backoff = 1.0
                self._poll_loop(client, cfg, version)
            except Exception as e:  # noqa: BLE001 - bad config or PLC trouble: report it and retry, never stop
                msg = str(e) or e.__class__.__name__
                if isinstance(e, TimeoutError):
                    msg = f"No reply from {ip}:{cfg.get('plc_port') or 5000} (timeout)"
                elif isinstance(e, ConnectionRefusedError):
                    msg = f"Connection refused by {ip}:{cfg.get('plc_port') or 5000} (is the SLMP port open?)"
                self._set(state="error", last_error=msg)
                self._log_status(OFFLINE)
                time.sleep(backoff)
                backoff = min(backoff * 2, 10.0)
            finally:
                client.close()

    def _poll_loop(self, client, cfg, version):
        mode = "register" if cfg.get("count_mode") == "register" else "bit"
        ok_bit = parse_address(cfg.get("ok_bit_address") or "L108")
        ng_bit = parse_address(cfg.get("ng_bit_address") or "L109")
        ok_reg = parse_address(cfg["ok_data_register"]) if cfg.get("ok_data_register") else None
        ng_reg = parse_address(cfg["ng_data_register"]) if cfg.get("ng_data_register") else None
        st_reg = parse_address(cfg["status_address"]) if cfg.get("status_address") else None
        andon = []
        for key, label, status, _ in ANDON:
            try:
                if str(cfg.get(key) or "").strip():
                    andon.append((parse_address(cfg[key]), key, label, status))
            except ValueError:
                pass
        if st_reg in {a for a, *_ in andon}:
            st_reg = None                # the address is an andon register now, not a status word
        regs = []
        for r in cfg.get("monitor_registers") or []:
            try:
                regs.append((parse_address(r.get("register")), r))
            except ValueError:
                pass
        inputs = []
        for x in cfg.get("inputs") or []:
            if x.get("type") == "digital":
                try:
                    inputs.append((parse_address(x.get("address")), x))
                except ValueError:
                    pass
        min_gap = float(cfg.get("ok_ng_pulse_min_gap") or 0.0)
        status_map = self._status_map()

        prev = None                      # previous (ok, ng) signal values
        last_event = 0.0
        next_slow = 0.0
        polls = 0
        while self.cfg_version == version:
            t_start = time.monotonic()
            # ---- fast: the cycle signals ----
            if mode == "bit":
                vals = self._read_bits(client, [ok_bit, ng_bit])
                cur = (vals[ok_bit], vals[ng_bit])
                rising = prev is not None and ((cur[0] and not prev[0]) or (cur[1] and not prev[1]))
                if rising and time.monotonic() - last_event >= min_gap:
                    last_event = time.monotonic()
                    self._cycle(cfg, is_ng=bool(cur[1] and not prev[1]), client=client)
                prev = cur
            else:
                vals = self._read_words(client, [ok_reg, ng_reg])
                cur = (vals[ok_reg], vals[ng_reg])
                if prev is not None:
                    for i, is_ng in ((0, False), (1, True)):
                        d = cur[i] - prev[i]
                        if 0 < d <= 5:   # bigger jumps = counter preset / resync, not cycles
                            for _ in range(d):
                                self._cycle(cfg, is_ng=is_ng, client=client)
                prev = cur
            polls += 1
            self._set(last_poll=_now().isoformat(timespec="milliseconds"),
                      poll_ms=round((time.monotonic() - t_start) * 1000, 1))

            # ---- slow: status, counters, registers, inputs ----
            if time.monotonic() >= next_slow:
                next_slow = time.monotonic() + SLOW_POLL_S
                values = {"ok_signal": {"address": format_address(*ok_bit), "value": None},
                          "ng_signal": {"address": format_address(*ng_bit), "value": None}}
                if mode == "bit":
                    values["ok_signal"]["value"], values["ng_signal"]["value"] = int(cur[0]), int(cur[1])
                words = [a for a in (ok_reg, ng_reg, st_reg) if a] + [a for a, _ in regs] + [a for a, *_ in andon]
                wv, werr = self._read_words_safe(client, words)
                bv, berr = self._read_bits_safe(client, [a for a, _ in inputs] + ([] if mode == "bit" else [ok_bit, ng_bit]))
                if mode == "register":
                    values["ok_signal"]["value"], values["ng_signal"]["value"] = bv.get(ok_bit), bv.get(ng_bit)
                if ok_reg:
                    values["ok_count"] = {"address": format_address(*ok_reg), "value": wv.get(ok_reg)}
                if ng_reg:
                    values["ng_count"] = {"address": format_address(*ng_reg), "value": wv.get(ng_reg)}
                code = wv.get(st_reg) if st_reg else None
                calls = [(a, label, status) for a, _, label, status in andon if wv.get(a)]
                if calls:                    # an andon call: that loss, whatever the machine does
                    a, label, name = calls[0]
                    code, call = wv[a], f"{label} ({format_address(*a)})"
                else:
                    call = None
                    name = status_map[code][0] if code is not None and code in status_map else None
                    if name in (None, "IDLE"):   # no status word, or "idle": the cycle signals decide
                        name = "RUNNING" if self._recent_cycle(cfg) else "IDLE"
                if st_reg:
                    values["status"] = {"address": format_address(*st_reg), "value": wv.get(st_reg), "name": name}
                values["andon"] = [{"key": key, "label": label, "address": format_address(*a), "status": status,
                                    "value": wv.get(a), "on": bool(wv.get(a))} for a, key, label, status in andon]
                self._log_status(name, code, call)
                self._set(values=values, mode=mode, polls=polls,
                          read_errors=werr + berr or None,
                          registers=[{"register": format_address(*a), "content": r.get("content"), "unit": r.get("unit"),
                                      "value": None if wv.get(a) is None else to_signed(wv[a])} for a, r in regs],
                          inputs=[{"address": format_address(*a), "signal": x.get("signal"), "value": bv.get(a)}
                                  for a, x in inputs])

            time.sleep(max(0.0, FAST_POLL_S - (time.monotonic() - t_start)))

    def _read_bits(self, client, addrs):
        out = {}
        for dev, n, cnt in _group([a for a in addrs if a]):
            for i, v in enumerate(client.read_bits(dev, n, cnt)):
                out[(dev, n + i)] = v
        return out

    def _read_words(self, client, addrs):
        out = {}
        for dev, n, cnt in _group([a for a in addrs if a]):
            for i, v in enumerate(client.read_words(dev, n, cnt)):
                out[(dev, n + i)] = v
        return out

    def _read_bits_safe(self, client, addrs):
        """Like _read_bits, but one bad block (PLC end code) only blanks that block."""
        out, errs = {}, []
        for dev, n, cnt in _group([a for a in addrs if a]):
            try:
                for i, v in enumerate(client.read_bits(dev, n, cnt)):
                    out[(dev, n + i)] = v
            except SlmpError as e:
                errs.append(f"{format_address(dev, n)}..{format_address(dev, n + cnt - 1)}: {e}")
        return out, errs

    def _read_words_safe(self, client, addrs):
        out, errs = {}, []
        for dev, n, cnt in _group([a for a in addrs if a]):
            try:
                for i, v in enumerate(client.read_words(dev, n, cnt)):
                    out[(dev, n + i)] = v
            except SlmpError as e:
                errs.append(f"{format_address(dev, n)}..{format_address(dev, n + cnt - 1)}: {e}")
        return out, errs

    def _recent_cycle(self, cfg):
        """RUNNING while the next signal is still due: up to the max allowed cycle, 3x the ideal CT or
        1.5x the last CT, whichever is longest."""
        if not self.last_cycle_at:
            return False
        window = max(float(cfg.get("max_allowed_cycle") or 40), 3 * float(cfg.get("ideal_cycle_time") or 10),
                     1.5 * (self.last_ct or 0))
        return (_now() - self.last_cycle_at).total_seconds() <= window

    @staticmethod
    def _plc_ct(client, cfg):
        """The cycle time the PLC itself measured (Machine Config "cycle time register", e.g.
        D103 in 0.1 s), read right after the OK/NG signal. None when unset, unreadable or 0."""
        reg = str(cfg.get("ct_register") or "").strip()
        if not reg or client is None:
            return None
        try:
            dev, n = parse_address(reg)
            raw = client.read_words(dev, n, 1)[0]
            ct = raw * float(cfg.get("ct_register_scale") or 0.1)
        except (ValueError, SlmpError):
            return None
        return round(ct, 2) if ct > 0 else None

    def _not_working(self, rd, sh, t0, t1):
        """Seconds of [t0, t1] that are no cycle time: scheduled breaks, PLC OFFLINE and loss statuses
        (breakdown, material, andon calls ...). Overlaps are counted once."""
        spans = []
        line = self.get_line_cfg()
        for b in line.get("breaks") or []:
            if sh not in str(b.get("applies_to_shifts") or sh).replace(" ", "").split(","):
                continue
            try:
                b0 = self.clock.at_time(rd, sh, b["start_time"])
                b1 = self.clock.at_time(rd, sh, b["end_time"])
            except (KeyError, ValueError):
                continue
            if b1 <= b0:
                b1 += dt.timedelta(days=1)
            spans.append((b0, b1))
        losses = {name for name, lt in self._status_map().values() if lt}
        log = sorted(self.store.status_log(rd, sh), key=lambda e: e.get("ts", 0))
        for i, e in enumerate(log):
            if e.get("status") != OFFLINE and e.get("status") not in losses:
                continue
            s0 = dt.datetime.fromtimestamp(e["ts"] / 1000)
            s1 = dt.datetime.fromtimestamp(log[i + 1]["ts"] / 1000) if i + 1 < len(log) else t1
            spans.append((s0, s1))
        total, end = 0.0, t0
        for a, b in sorted((max(a, t0), min(b, t1)) for a, b in spans):
            if b <= a:
                continue
            a = max(a, end)
            if b > a:
                total += (b - a).total_seconds()
                end = b
        return total

    def _cycle(self, cfg, is_ng, client=None):
        now = _now()
        rd, sh, _ = self.clock.at(now)
        if self.last_cycle_at is not None and self.last_cycle_key == (rd, sh):
            start, source = self.last_cycle_at, "measured"
        else:
            # First cycle of the shift: from the shift start (+ start-up delay), or from when the
            # collector got the PLC, whichever is later.
            row = self.clock.shift_row(sh) or {}
            start = now
            if row:
                t0, _ = self.clock.bounds(dt.date.fromisoformat(rd), row)
                start = t0 + dt.timedelta(minutes=float(row.get("startup_delay_min") or 0))
            if self.connected_at and self.connected_at > start:
                start = self.connected_at
            start, source = min(start, now), "first"
        gap = (now - start).total_seconds()
        excluded = self._not_working(rd, sh, start, now)
        plc_ct = self._plc_ct(client, cfg)
        if plc_ct is not None:
            ct, source = plc_ct, "plc"
        else:
            # Time since the previous OK/NG signal, without breaks, PLC OFFLINE and loss time.
            ct = round(max(0.0, gap - excluded), 2)
        self.last_cycle_at, self.last_cycle_key, self.last_ct = now, (rd, sh), ct
        seq = self.store.next_seq()
        row = {"cycle_seq": seq, "ts": now.isoformat(timespec="microseconds"), "ct": ct, "is_ng": is_ng,
               "part_code": f"{now:%Y%m%d}-{seq:06d}", "gap": round(gap, 2), "excluded": round(excluded, 2),
               "ct_source": source}
        self.store.add_cycle(rd, sh, row)
        with self.lock:
            self.info["events"] = self.info.get("events", 0) + 1
        if self.on_cycle:
            try:
                self.on_cycle(seq, now - dt.timedelta(seconds=ct), now)
            except Exception:                # a camera problem must never stop counting
                pass
