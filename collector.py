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

    def all_cycles(self, since_date=None):
        rows = []
        for d, s, path in self.shift_files():
            if since_date is None or d >= since_date:
                rows.extend(self._rows(path))
        return rows


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

    # ----- public -----
    def start(self):
        self._log_downtime_since_heartbeat()
        threading.Thread(target=self._run, name="collector", daemon=True).start()
        threading.Thread(target=self._heartbeat, name="collector-hb", daemon=True).start()

    def reload(self):
        self.cfg_version += 1

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

    def _log_status(self, name, code=None):
        with self.slock:
            when = _now()
            rd, sh, _ = self.clock.at(when)
            key = (rd, sh)
            if name == self.status and key == self.status_key:
                return
            self.status, self.status_code, self.status_key = name, code, key
            self.store.add_status(rd, sh, {"ts": int(when.timestamp() * 1000), "nowMinFrac": min_frac(when),
                                           "status": name, "code": code, "shift": sh})

    def _heartbeat(self):
        while True:
            time.sleep(HEARTBEAT_S)
            try:
                with self.store.lock:
                    self.store.state["heartbeat"] = time.time()
                    self.store.save_state()
                # Shift changed with no status change: open the new shift's timeline.
                if self.status:
                    self._log_status(self.status, self.status_code)
            except OSError:
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
            cfg = self.get_machine_cfg()
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
                self._set(state="connected", last_error=None, connected_since=_now().isoformat(timespec="seconds"))
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
                    self._cycle(cfg, is_ng=bool(cur[1] and not prev[1]))
                prev = cur
            else:
                vals = self._read_words(client, [ok_reg, ng_reg])
                cur = (vals[ok_reg], vals[ng_reg])
                if prev is not None:
                    for i, is_ng in ((0, False), (1, True)):
                        d = cur[i] - prev[i]
                        if 0 < d <= 5:   # bigger jumps = counter preset / resync, not cycles
                            for _ in range(d):
                                self._cycle(cfg, is_ng=is_ng)
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
                words = [a for a in (ok_reg, ng_reg, st_reg) if a] + [a for a, _ in regs]
                wv, werr = self._read_words_safe(client, words)
                bv, berr = self._read_bits_safe(client, [a for a, _ in inputs] + ([] if mode == "bit" else [ok_bit, ng_bit]))
                if mode == "register":
                    values["ok_signal"]["value"], values["ng_signal"]["value"] = bv.get(ok_bit), bv.get(ng_bit)
                if ok_reg:
                    values["ok_count"] = {"address": format_address(*ok_reg), "value": wv.get(ok_reg)}
                if ng_reg:
                    values["ng_count"] = {"address": format_address(*ng_reg), "value": wv.get(ng_reg)}
                code = wv.get(st_reg) if st_reg else None
                if code is not None and code in status_map:
                    name = status_map[code][0]
                else:   # status word missing/unknown: derive it from the cycle signals
                    recent = self.last_cycle_at and (_now() - self.last_cycle_at).total_seconds() <= float(cfg.get("max_allowed_cycle") or 40)
                    name = "RUNNING" if recent else "IDLE"
                if st_reg:
                    values["status"] = {"address": format_address(*st_reg), "value": code, "name": name}
                self._log_status(name, code)
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

    def _cycle(self, cfg, is_ng):
        now = _now()
        rd, sh, _ = self.clock.at(now)
        max_ct = float(cfg.get("max_allowed_cycle") or 40.0)
        gap = None
        if self.last_cycle_at is not None and self.last_cycle_key == (rd, sh):
            gap = (now - self.last_cycle_at).total_seconds()
        # First cycle of a shift, or after a stop: the real cycle time is unknown —
        # count it at the max allowed cycle time instead of the whole stop.
        ct = round(gap, 2) if gap is not None and gap <= max_ct else max_ct
        self.last_cycle_at, self.last_cycle_key = now, (rd, sh)
        seq = self.store.next_seq()
        row = {"cycle_seq": seq, "ts": now.isoformat(timespec="microseconds"), "ct": ct, "is_ng": is_ng,
               "part_code": f"{now:%Y%m%d}-{seq:06d}", "gap": None if gap is None else round(gap, 2),
               "capped": gap is None or gap > max_ct}
        self.store.add_cycle(rd, sh, row)
        with self.lock:
            self.info["events"] = self.info.get("events", 0) + 1
        if self.on_cycle:
            try:
                self.on_cycle(seq, now - dt.timedelta(seconds=ct), now)
            except Exception:                # a camera problem must never stop counting
                pass
