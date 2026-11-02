"""Put the hand-picked 50-cycle demo set on MANAGEMENT-2 (live line 99), in the current shift.

The set lives in clips/demo_set/ (set_01.mp4 .. set_50.mp4 + manifest.json, in play order:
10 OK, 1 NG, 10 OK, 1 NG, ...). Each run:
- moves every live cycle/status file to data/live/backup_<time>/ (nothing is deleted),
- writes the 50 cycles back to back, ending just before now, into the current shift's files,
  skipping scheduled breaks (the shift must have run for about 12 minutes), with the clips copied to clips/live/cycle_<seq>.mp4 (new cycle numbers),
- sets the target (ideal) cycle time on Machine Config to the manifest's target_ct.
The server must be stopped (it keeps the cycle number and heartbeat in memory): demo_set.bat does that.

    python demo_set.py [port]
"""
import datetime as dt
import json
import os
import shutil
import socket
import sys

from collector import ShiftClock, min_frac

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
LIVE = os.path.join(DATA, "live")
SET_DIR = os.path.join(HERE, "clips", "demo_set")
STAGED = os.path.join(SET_DIR, "staged.json")      # cycle numbers of the last run's clip copies
END_MARGIN_S = 30                                     # the last cycle ends this long before now


def load(path, default):
    """`default` only when the file does not exist; a file that cannot be read stops the run."""
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"Cannot read {path} ({e}): nothing was changed.")


def save(path, obj, indent=None):
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=indent)
    os.replace(path + ".tmp", path)


def server_running(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def clips_live_dir():
    p = str(load(os.path.join(DATA, "camera.json"), {}).get("video_save_path") or "").strip()
    usable = p and os.path.isabs(p) and (os.name != "nt" or os.path.splitdrive(p)[0])
    return os.path.join(p if usable else os.path.join(HERE, "clips"), "live")


def breaks_of(line, clock, rd, sh):
    out = []
    for b in line.get("breaks") or []:
        if sh in str(b.get("applies_to_shifts", "")).split(","):
            b0 = clock.at_time(rd, sh, b["start_time"])
            b1 = clock.at_time(rd, sh, b["end_time"])
            out.append((b0, b1 if b1 > b0 else b1 + dt.timedelta(days=1)))
    return out


def timeline(cts, end, breaks):
    """Back-to-back cycles ending at `end`, none inside a break. -> [(start, end)] in play order."""
    def overlaps(t0, t1):
        return next((b for b in breaks if t0 < b[1] and b[0] < t1), None)

    spans, t = [], end
    for ct in reversed(cts):
        while (b := overlaps(t - dt.timedelta(seconds=ct), t)):
            t = b[0]
        spans.append((t - dt.timedelta(seconds=ct), t))
        t = spans[-1][0]
    spans.reverse()
    return spans


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    if server_running(port):
        sys.exit(f"The server is running on port {port}: stop it first (stop.bat), or use demo_set.bat.")
    manifest = load(os.path.join(SET_DIR, "manifest.json"), None)
    if not manifest:
        sys.exit(f"No demo set: {SET_DIR}\\manifest.json is missing.")
    cycles = manifest["cycles"]
    for c in cycles:
        if not os.path.isfile(os.path.join(SET_DIR, c["file"])):
            sys.exit(f"Missing clip: {SET_DIR}\\{c['file']}")

    line = load(os.path.join(DATA, "mgmt", "line.json"), {})
    clock = ShiftClock(lambda: line)
    now = dt.datetime.now().replace(microsecond=0)
    rd, sh, in_gap = clock.at(now)
    s0, s1 = clock.bounds(dt.date.fromisoformat(rd), clock.shift_row(sh))
    end = min(now, s1) - dt.timedelta(seconds=END_MARGIN_S)
    spans = timeline([c["ct"] for c in cycles], end, breaks_of(line, clock, rd, sh))
    if spans[0][0] < s0:
        # Never put cycles in the future: the collector would time the next real cycle from them.
        ready = now + (s0 - spans[0][0]) + dt.timedelta(minutes=1)
        sys.exit(f"Shift {sh} started at {s0:%H:%M}: the set needs about {(end - spans[0][0]).seconds // 60 + 1} "
                 f"minutes of it. Run this again after {ready:%H:%M}. Nothing was changed.")
    machine_path = os.path.join(DATA, "machine.json")
    machine = load(machine_path, {})

    # 1. Move every stored cycle/status file out of the way (the CT distribution reads the last 30 days).
    backup = os.path.join(LIVE, "backup_" + now.strftime("%Y%m%d_%H%M%S"))
    for sub in ("cycles", "status"):
        src = os.path.join(LIVE, sub)
        os.makedirs(src, exist_ok=True)
        for name in os.listdir(src):
            os.makedirs(os.path.join(backup, sub), exist_ok=True)
            shutil.move(os.path.join(src, name), os.path.join(backup, sub, name))
    state = load(os.path.join(LIVE, "state.json"), {"last_seq": 0})
    os.makedirs(backup, exist_ok=True)
    save(os.path.join(backup, "state.json"), state)
    if machine:
        save(os.path.join(backup, "machine.json"), machine, indent=1)

    # 2. Clips: drop the previous run's copies (only files that are still those copies: after a
    #    cycle-number reset a real clip can have the same number), copy the set under new numbers.
    live = clips_live_dir()
    os.makedirs(live, exist_ok=True)
    for old in load(STAGED, []):
        mp4 = os.path.join(live, f"cycle_{old['seq']}.mp4")
        if os.path.isfile(mp4) and os.path.getsize(mp4) == old["size"]:
            for ext in (".mp4", ".json", ".noclip.json"):
                try:
                    os.remove(os.path.join(live, f"cycle_{old['seq']}{ext}"))
                except OSError:
                    pass
    first = int(state.get("last_seq") or 0) + 1
    pre, post = manifest.get("pre_roll_s", 0), manifest.get("post_roll_s", 0)
    rows, seqs = [], []
    for i, (c, (t0, t1)) in enumerate(zip(cycles, spans)):
        seq = first + i
        dst = os.path.join(live, f"cycle_{seq}")
        shutil.copyfile(os.path.join(SET_DIR, c["file"]), dst + ".mp4")     # fresh mtime: kept by retention
        save(dst + ".json", {"start": (t0 - dt.timedelta(seconds=pre)).isoformat(timespec="milliseconds"),
                             "end": (t1 + dt.timedelta(seconds=post)).isoformat(timespec="milliseconds"),
                             "duration": c["duration"]})
        try:
            os.remove(dst + ".noclip.json")
        except OSError:
            pass
        rows.append({"cycle_seq": seq, "ts": t1.isoformat(timespec="microseconds"), "ct": c["ct"],
                     "is_ng": c["is_ng"], "part_code": f"{t1:%Y%m%d}-{seq:06d}",
                     "gap": c["ct"], "excluded": 0.0, "ct_source": "measured"})
        seqs.append(seq)
    save(STAGED, [{"seq": s, "size": os.path.getsize(os.path.join(live, f"cycle_{s}.mp4"))} for s in seqs])

    # 3. The shift's cycles and status timeline (RUNNING from the first cycle on). The server logs
    #    PLC OFFLINE at the heartbeat (= the last cycle's end) when it starts without a PLC.
    key = f"{rd}_{sh}.jsonl"
    with open(os.path.join(LIVE, "cycles", key), "w", encoding="utf-8") as f:
        f.writelines(json.dumps(r) + "\n" for r in rows)
    t0 = spans[0][0]
    with open(os.path.join(LIVE, "status", key), "w", encoding="utf-8") as f:
        f.write(json.dumps({"ts": int(t0.timestamp() * 1000), "nowMinFrac": min_frac(t0),
                            "status": "RUNNING", "code": 1, "shift": sh}) + "\n")
    save(os.path.join(LIVE, "state.json"), {"last_seq": seqs[-1], "heartbeat": spans[-1][1].timestamp()})

    # 4. Target cycle time.
    machine["ideal_cycle_time"] = manifest["target_ct"]
    save(machine_path, machine, indent=1)

    ok = [c["ct"] for c in cycles if not c["is_ng"]]
    print(f"Demo set staged: {len(rows)} cycles ({len(ok)} OK, {len(rows) - len(ok)} NG) in shift {sh} of {rd}, "
          f"{spans[0][0]:%H:%M:%S}-{spans[-1][1]:%H:%M:%S}, cycle numbers {seqs[0]}-{seqs[-1]}.")
    print(f"OK cycle time {min(ok)}-{max(ok)} s (average {sum(ok) / len(ok):.2f} s), target {manifest['target_ct']} s.")
    print(f"Previous live data moved to {backup}")


if __name__ == "__main__":
    main()
