"""Prepare a dummy shift for MANAGEMENT-2 (e.g. tomorrow's shift A, shown as at 10:00).

The OK and NG clips come from two folders (default: "..\\ok video" and "..\\ng video" next to this folder).
Each run:
- copies them to clips/dummy_set/ (ok_01.mp4 .., ng_01.mp4 .., moov moved to the front for the browser),
- fills the shift from its start up to --at with back-to-back cycles in the pattern 6 OK, 1 NG, 5 OK, 1 NG
  (repeated; the OK clips are shuffled every round, the NG clips take turns), skipping scheduled breaks;
  the last 30 cycles are 17 OK, 1 NG, 12 OK; a clip named "ng..." is NG in either folder;
  a cycle's time is its clip's length -0.4..+0.2 s (an OK cycle stays under 15 s),
- writes them to data/dummy/ (its own store: the live PLC data in data/live/ is not touched), with the clips
  linked as clips/dummy/cycle_<seq>.mp4,
- sets the target (ideal) cycle time on Machine Config, and switches dummy mode on: MANAGEMENT-2 then
  shows this shift with its clock held at --at (with --hold). Without --hold the server instead runs a live dummy
  line on the real clock from the same clips (1 NG in every 30 cycles). dummy_off.bat switches back to the PLC data.
The server can keep running (it reads the dummy files on every request).

    python dummy_set.py [--date 2026-11-03] [--shift A] [--at 10:00] [--target 15.4] [--ok DIR] [--ng DIR]
"""
import argparse
import datetime as dt
import json
import os
import random
import re
import shutil
import subprocess
import sys

from camera import find_ffmpeg
from collector import ShiftClock, min_frac
from demo_set import breaks_of, load, save

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
DUMMY = os.path.join(DATA, "dummy")
SET_DIR = os.path.join(HERE, "clips", "dummy_set")
CLIP_DIR = os.path.join(HERE, "clips", "dummy")
PATTERN = (("ok", 6), ("ng", 1), ("ok", 5), ("ng", 1))
JITTER_S = (-0.4, 0.2)                               # a little under the clip length, so the average stays under target
NG_ROLL_S = 4.0                                       # an NG clip holds 2 s before and after the cycle
OK_MAX_S = 15.0                                       # OK cycle times stay under this
TAIL = (("ok", 17), ("ng", 1), ("ok", 12))   # the last 30 cycles: only 1 NG
LIVE_PATTERN = (("ok", 17), ("ng", 1), ("ok", 12))   # live dummy line: 1 NG in every 30 cycles
TAIL_N = sum(n for _, n in TAIL)


def duration(ffmpeg, path):
    r = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-i", path], capture_output=True, stdin=subprocess.DEVNULL)
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr.decode("utf-8", "replace"))
    if not m:
        sys.exit(f"Cannot read the length of {path}: nothing was changed.")
    return round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 2)


def import_clips(ffmpeg, folders):
    """-> (ok, ng). A clip whose name starts with "ng" is an NG clip, whichever folder it is in."""
    found = {"ok": [], "ng": []}
    for kind, folder in folders:
        for n in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
            if n.lower().endswith(".mp4"):
                found["ng" if n.lower().startswith("ng") else kind].append(os.path.join(folder, n))
    for kind, paths in found.items():
        if not paths:
            sys.exit(f"No {kind.upper()} .mp4 clips in {' or '.join(f for _, f in folders)}: nothing was changed.")
    out = {}
    for kind, paths in found.items():
        out[kind] = []
        for i, src in enumerate(paths, 1):
            dst = os.path.join(SET_DIR, f"{kind}_{i:02d}.mp4")
            r = subprocess.run([ffmpeg, "-v", "error", "-y", "-i", src, "-c", "copy", "-an",
                                "-movflags", "+faststart", dst], capture_output=True, stdin=subprocess.DEVNULL)
            if r.returncode:
                sys.exit(f"Cannot copy {src}: {r.stderr.decode('utf-8', 'replace').strip()}")
            out[kind].append({"file": os.path.basename(dst), "duration": duration(ffmpeg, dst),
                              "source": os.path.basename(src)})
    return out["ok"], out["ng"]


def kinds(tail_from):
    """'ok'/'ng' per cycle: the pattern up to cycle `tail_from`, then TAIL, then all OK."""
    i = 0
    while True:
        for kind, n in PATTERN:
            for _ in range(n):
                if i >= tail_from:
                    break
                yield kind
                i += 1
        if i >= tail_from:
            break
    for kind, n in TAIL:
        yield from [kind] * n
    while True:
        yield "ok"


def plan(ok, ng, t, until, breaks, seed):
    """[(clip, ct, is_ng, end)] back to back from t, the last one ending by `until`; the last cycles follow
    TAIL (the dashboard's recent-cycles view)."""
    tail_from = 0
    for _ in range(20):                           # fewer NG at the end fit more cycles: settle where the tail starts
        rows = _plan(ok, ng, t, until, breaks, random.Random(seed), tail_from)
        if len(rows) - tail_from == TAIL_N:
            break
        tail_from = max(0, len(rows) - TAIL_N)
    return rows


def plan_live(ok, ng, t, until, breaks, seed):
    """The whole shift for the live dummy line (the server shows the cycles that have ended by now): LIVE_PATTERN
    repeated, so any 30 cycles in a row hold exactly one NG."""
    def forever():
        while True:
            for kind, n in LIVE_PATTERN:
                yield from [kind] * n
    return _plan(ok, ng, t, until, breaks, random.Random(seed), 0, forever())


def _plan(ok, ng, t, until, breaks, rng, tail_from, kind_iter=None):
    rows, deck, last, ng_i = [], [], None, 0
    for kind in kind_iter or kinds(tail_from):
        if kind == "ok":
            if not deck:
                deck = rng.sample(ok, len(ok))
                if len(deck) > 1 and deck[-1] is last:      # the same clip twice in a row looks fake
                    deck[0], deck[-1] = deck[-1], deck[0]
            clip = last = deck.pop()
        else:
            clip, ng_i = ng[ng_i % len(ng)], ng_i + 1
        ct = round(clip["duration"] - (NG_ROLL_S if kind == "ng" else 0) + rng.uniform(*JITTER_S), 2)
        if kind == "ok" and ct >= OK_MAX_S:      # a long OK clip still reads as a good cycle (only NG show red)
            ct = round(rng.uniform(OK_MAX_S - 1.2, OK_MAX_S - 0.1), 2)
        end = t + dt.timedelta(seconds=ct)
        for b0, b1 in breaks:
            if t < b1 and b0 < end:
                t, end = b1, b1 + dt.timedelta(seconds=ct)
        if end > until:
            return rows
        rows.append((clip, ct, kind == "ng", end))
        t = end


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=(dt.date.today() + dt.timedelta(days=1)).isoformat())
    ap.add_argument("--shift", default="A")
    ap.add_argument("--at", default="10:00")
    ap.add_argument("--hold", action="store_true",
                    help="show the prepared shift with the clock held at --at (default: live dummy line on the real clock)")
    ap.add_argument("--target", type=float, default=15.4)
    ap.add_argument("--ok", default=os.path.join(HERE, "..", "ok video"))
    ap.add_argument("--ng", default=os.path.join(HERE, "..", "ng video"))
    a = ap.parse_args()

    ffmpeg = find_ffmpeg(HERE)
    if not ffmpeg:
        sys.exit("ffmpeg not found: nothing was changed.")
    line = load(os.path.join(DATA, "mgmt", "line.json"), {})
    clock = ShiftClock(lambda: line)
    row = clock.shift_row(a.shift)
    if not row:
        sys.exit(f"No shift {a.shift} in line.json.")
    s0, s1 = clock.bounds(dt.date.fromisoformat(a.date), row)
    at = clock.at_time(a.date, a.shift, a.at + ":00" if a.at.count(":") == 1 else a.at)
    if at < s0:
        at += dt.timedelta(days=1)                # a night shift's time after midnight
    if not s0 < at <= s1:
        sys.exit(f"{a.at} is not inside shift {a.shift} ({s0:%H:%M}-{s1:%H:%M}).")

    shutil.rmtree(SET_DIR, ignore_errors=True)
    os.makedirs(SET_DIR)
    ok, ng = import_clips(ffmpeg, (("ok", a.ok), ("ng", a.ng)))
    rows = plan(ok, ng, s0, at, breaks_of(line, clock, a.date, a.shift), a.date + a.shift)
    if not rows:
        sys.exit("No cycle fits before that time.")

    # Data: its own store, rebuilt from scratch.
    for sub in ("cycles", "status"):
        shutil.rmtree(os.path.join(DUMMY, sub), ignore_errors=True)
        os.makedirs(os.path.join(DUMMY, sub))
    shutil.rmtree(CLIP_DIR, ignore_errors=True)
    os.makedirs(CLIP_DIR)
    key = f"{a.date}_{a.shift}.jsonl"
    with open(os.path.join(DUMMY, "cycles", key), "w", encoding="utf-8") as f:
        for seq, (clip, ct, is_ng, end) in enumerate(rows, 1):
            src, dst = os.path.join(SET_DIR, clip["file"]), os.path.join(CLIP_DIR, f"cycle_{seq}.mp4")
            try:
                os.link(src, dst)                 # same drive: no extra space
            except OSError:
                shutil.copyfile(src, dst)
            f.write(json.dumps({"cycle_seq": seq, "ts": end.isoformat(timespec="microseconds"), "ct": ct,
                                "is_ng": is_ng, "part_code": f"{end:%Y%m%d}-{seq:06d}", "gap": ct,
                                "excluded": 0.0, "ct_source": "measured"}) + "\n")
    with open(os.path.join(DUMMY, "status", key), "w", encoding="utf-8") as f:
        f.write(json.dumps({"ts": int(s0.timestamp() * 1000), "nowMinFrac": min_frac(s0),
                            "status": "RUNNING", "code": 1, "shift": a.shift}) + "\n")
    save(os.path.join(DUMMY, "state.json"), {"last_seq": len(rows)})
    save(os.path.join(SET_DIR, "manifest.json"), {"ok": ok, "ng": ng}, indent=1)

    machine_path = os.path.join(DATA, "machine.json")
    machine = load(machine_path, {})
    machine["ideal_cycle_time"] = a.target
    save(machine_path, machine, indent=1)
    save(os.path.join(DUMMY, "dummy.json"), {"enabled": True, "now": at.isoformat(timespec="seconds")} if a.hold
         else {"enabled": True, "live": True})

    oks = [ct for _, ct, is_ng, _ in rows if not is_ng]
    print(f"Dummy shift {a.shift} of {a.date}: {len(rows)} cycles ({len(oks)} OK, {len(rows) - len(oks)} NG), "
          f"{s0:%H:%M:%S}-{rows[-1][3]:%H:%M:%S}, clock held at {at:%H:%M}.")
    print(f"Clips: {len(ok)} OK ({', '.join(str(c['duration']) for c in ok)} s), "
          f"{len(ng)} NG ({', '.join(str(c['duration']) for c in ng)} s). Target {a.target} s.")
    print("MANAGEMENT-2 / SUPERVISOR now show " + ("this shift, clock held." if a.hold else
          "the live dummy line: these clips, on the real clock, in every shift.")
          + " dummy_off.bat goes back to the PLC data.")


if __name__ == "__main__":
    main()
