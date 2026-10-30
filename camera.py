"""Camera side of the live demo: recording, per-cycle clips and live preview.

One ffmpeg process reads the camera's RTSP stream (default path
/h264/ch1/main/av_stream, set on the Camera page) and writes two things at once:
  * 4-second MPEG-TS segments (stream copy, no re-encode) into <clips>/live/seg/
  * a 5 fps, 960 px wide JPEG stream on stdout for the live preview
For every cycle the collector reports, exactly that cycle (plus the optional
pre/post roll) is cut out of the segments and re-encoded to H.264 into
<clips>/live/cycle_<seq>.mp4, so the clip is as long as the cycle time.

When recording is OFF, the preview still works: ffmpeg is started only while
someone is watching.  Without ffmpeg installed, the preview falls back to the
camera's HTTP snapshot (SNAPSHOT_PATHS) and no clips are recorded.
"""
import base64
import bisect
import datetime as dt
import hashlib
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.parse
import urllib.request

SEGMENT_S = 4
MAX_CLIP_S = 600            # a longer cycle gets a clip of its last 10 minutes
KEEP_SEGMENTS_S = MAX_CLIP_S + 120   # segments are only needed until the cycle's clip is cut
PREVIEW_IDLE_S = 20         # stop a preview-only ffmpeg this long after the last viewer leaves
STALL_S = 15                # no frame for this long -> restart ffmpeg
LATENCY_S = 0.5             # an IP camera's picture reaches us about this long after the moment it shows
SNAPSHOT_PATHS = ("/ISAPI/Streaming/channels/101/picture", "/cgi-bin/camera?resolution=640",
                  "/SnapshotJPEG?Resolution=640x480")
NO_WINDOW = 0x08000000 if os.name == "nt" else 0       # CREATE_NO_WINDOW
# Every clip piece is encoded with exactly these settings, so pieces can be joined without re-encoding.
# (No B-frames: each piece starts and ends cleanly.)
VCODEC = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", "-bf", "0",
          "-vf", "scale='min(1280,iw)':-2"]


def find_ffmpeg(here):
    env = os.environ.get("MES_FFMPEG")
    if env and os.path.isfile(env):
        return env
    for name in ("ffmpeg.exe", "ffmpeg"):
        local = os.path.join(here, "ffmpeg", "bin", name)
        if os.path.isfile(local):
            return local
        local = os.path.join(here, name)
        if os.path.isfile(local):
            return local
    return shutil.which("ffmpeg")


def rtsp_url(cfg, hide_password=False):
    user = str(cfg.get("username") or "").strip()
    pw = "****" if hide_password and cfg.get("password") else str(cfg.get("password") or "")
    auth = ""
    if user:
        auth = urllib.parse.quote(user, safe="")
        if pw:
            auth += ":" + (pw if hide_password else urllib.parse.quote(pw, safe=""))
        auth += "@"
    path = str(cfg.get("rtsp_path") or "").strip()
    if path and not path.startswith("/"):
        path = "/" + path
    return f"rtsp://{auth}{str(cfg.get('ip') or '').strip()}:{int(cfg.get('port') or 554)}{path}"


def rtsp_describe(cfg, timeout=4.0):
    """Ask the camera for the configured stream once (RTSP DESCRIBE, Basic or Digest auth)
    and return its status line, e.g. "200 OK" or "454 Session Not Found"."""
    ip, port = str(cfg.get("ip") or "").strip(), int(cfg.get("port") or 554)
    path = str(cfg.get("rtsp_path") or "").strip() or "/"
    url = f"rtsp://{ip}:{port}{path if path.startswith('/') else '/' + path}"
    user, pw = str(cfg.get("username") or ""), str(cfg.get("password") or "")

    def ask(cseq, auth=None):              # a fresh connection per request: some cameras hang up after a 401
        with socket.create_connection((ip, port), timeout=timeout) as s:
            s.settimeout(timeout)
            msg = f"DESCRIBE {url} RTSP/1.0\r\nCSeq: {cseq}\r\nAccept: application/sdp\r\nUser-Agent: mes-demo\r\n"
            s.sendall((msg + (f"Authorization: {auth}\r\n" if auth else "") + "\r\n").encode())
            buf = b""
            while b"\r\n\r\n" not in buf and len(buf) < 65536:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
        lines = buf.split(b"\r\n\r\n")[0].decode("latin-1").split("\r\n")
        status = lines[0].split(" ", 1)[1] if " " in lines[0] else lines[0] or "no answer"
        return status, [l.split(":", 1)[1].strip() for l in lines[1:] if l.lower().startswith("www-authenticate:")]

    status, challenges = ask(1)
    if status.startswith("401") and user:
        digest = next((c for c in challenges if c.lower().startswith("digest")), None)
        if digest:
            p = {k: a or b for k, a, b in re.findall(r'(\w+)=(?:"([^"]*)"|([^,\s]*))', digest[6:])}
            md5 = lambda x: hashlib.md5(x.encode()).hexdigest()  # noqa: E731
            realm, nonce = p.get("realm", ""), p.get("nonce", "")
            ha1, ha2 = md5(user + ":" + realm + ":" + pw), md5("DESCRIBE:" + url)
            auth = f'Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{url}"'
            if "auth" in p.get("qop", ""):
                cnonce = os.urandom(8).hex()
                resp = md5(":".join((ha1, nonce, "00000001", cnonce, "auth", ha2)))
                auth += f', qop=auth, nc=00000001, cnonce="{cnonce}", response="{resp}"'
            else:
                auth += f', response="{md5(ha1 + ":" + nonce + ":" + ha2)}"'
        else:
            auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
        status, _ = ask(2, auth)
    return status


RTSP_HINTS = (
    ("401", "wrong username or password (Camera page)"),
    ("403", "the camera does not allow this user to view the stream"),
    ("404", "the camera has no stream at this RTSP Path — check the path"),
    ("453", "the camera has no free stream session (an NVR/recorder is using them all)"),
    ("454", "the camera rejected the session — check the RTSP Path"),
    ("461", "the camera does not accept RTSP over TCP"),
)


def explain_rtsp(status, path):
    hint = next((h for code, h in RTSP_HINTS if status.startswith(code)), "check the RTSP Path and the camera's stream settings")
    return f"Camera answered RTSP {status} for {path or '/'}: {hint}"


def explain_ffmpeg(line, cfg):
    """ffmpeg's network errors in plain words."""
    where = f"{cfg.get('ip')}:{cfg.get('port') or 554}"
    low = line.lower()
    if "connection refused" in low or "actively refused" in low:
        return f"Nothing listens on {where} (wrong RTSP port?)"
    if "no route to host" in low or "unreachable" in low:
        return f"The camera at {where} is not reachable from this PC (network/IP)"
    if "timed out" in low or "did not properly respond" in low:
        return f"No answer from the camera at {where} (IP not reachable from this PC?)"
    if "401" in line:
        return explain_rtsp("401 Unauthorized", cfg.get("rtsp_path"))
    if "404" in line:
        return explain_rtsp("404 Not Found", cfg.get("rtsp_path"))
    return line


class Camera:
    def __init__(self, get_cfg, default_clips_dir, here):
        self.get_cfg = get_cfg
        self.default_clips_dir = default_clips_dir
        self.ffmpeg = find_ffmpeg(here)
        self.cfg_version = 0
        self.lock = threading.Lock()
        self.cond = threading.Condition()
        self.frame, self.frame_at, self.frame_no = None, 0.0, 0
        self.viewers, self.last_viewer = 0, 0.0
        self.proc = None
        self.proc_kind = None                # "record" | "preview"
        self._started = 0.0
        self.clips = queue.Queue()
        self.seg_seen = {}                   # segment file -> wall time it appeared (its first frame's arrival)
        self.launches = []                   # wall times the recording ffmpeg was (re)started
        self.demo = None                     # None | "camera" (record the real camera) | "synthetic" (test pattern)
        self.rtsp_diag = {}                  # cfg_version -> plain-words RTSP answer for ffmpeg's "4XX" errors
        self.run_codec = {}                  # recording run -> video codec the camera sends (h264, hevc, ...)
        self.need_duration = set()           # clips without a cycle_<seq>.json yet
        self.clip_window = {}                # clip -> its start/end, kept while its length can't be read
        self.clip_states = {}                # seq -> {"state": queued | cutting | failed, "reason", "start"} until saved
        self.first_seq = None                # first cycle the collector reported since this server start
        self.seg_pts = {}                    # segment file -> its first timestamp (continuous within a recording run)
        self.info = {"state": "starting", "last_error": None, "recording": False, "preview": False,
                     "ffmpeg": self.ffmpeg, "clips_cut": 0, "clips_failed": 0, "last_clip": None,
                     "last_clip_error": None, "source": None, "camera_codec": None}

    # ----- paths -----
    def clips_root(self):
        p = str(self.get_cfg().get("video_save_path") or "").strip()
        usable = p and os.path.isabs(p) and (os.name != "nt" or os.path.splitdrive(p)[0])
        return p if usable else self.default_clips_dir

    def live_dir(self):
        return os.path.join(self.clips_root(), "live")

    def seg_dir(self):
        return os.path.join(self.live_dir(), "seg")

    def clip_path(self, seq):
        for root in (self.clips_root(), self.default_clips_dir):
            p = os.path.join(root, "live", f"cycle_{int(seq)}.mp4")
            if os.path.isfile(p):
                return p
        return None

    def clip_info(self, seq):
        """{"duration": seconds or None, "start", "end"} for a saved clip, None if there is no clip.
        The length is measured once per clip and kept next to it in cycle_<seq>.json."""
        path = self.clip_path(seq)
        if not path:
            return None
        info = self._read_info(path)
        if info is None or info.get("duration") is None:
            self.need_duration.add(path)     # not measured yet (older clip, or the file was busy)
        return info or {"duration": None}

    @staticmethod
    def _read_info(path):
        try:
            with open(path[:-4] + ".json", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def _duration_of(self, path):
        """Clip length in seconds from ffmpeg's "Duration: 00:00:09.36" line."""
        if not self.ffmpeg:
            return None
        try:
            r = subprocess.run([self.ffmpeg, "-hide_banner", "-nostdin", "-i", path], stdin=subprocess.DEVNULL,
                               capture_output=True, timeout=20, creationflags=NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            return None
        m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", r.stderr.decode("utf-8", "replace"))
        return round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 2) if m else None

    def _write_info(self, path, **info):
        """Store the clip's measured length (plus `info`) in cycle_<seq>.json. If ffmpeg could not read
        the clip yet (e.g. an antivirus scan holding the new file), nothing is stored and it is retried."""
        info["duration"] = self._duration_of(path)
        if info["duration"] is None:
            self.clip_window[path] = {k: v for k, v in info.items() if k != "duration"}
            self.need_duration.add(path)
            return
        try:
            with open(path[:-4] + ".json", "w", encoding="utf-8") as f:
                json.dump(info, f)
        except OSError:
            self.need_duration.add(path)

    def _measure_old_clips(self):
        tried = {}                           # path -> last attempt; retry a failing clip every 10 s
        while True:
            time.sleep(1)
            for path in list(self.need_duration):
                if time.time() - tried.get(path, 0) < 10:
                    continue
                self.need_duration.discard(path)
                tried[path] = time.time()
                known = self._read_info(path) or {}
                if os.path.isfile(path) and known.get("duration") is None:
                    known.pop("duration", None)
                    self._write_info(path, **{**known, **self.clip_window.pop(path, {})})

    # ----- public -----
    def start(self):
        # two clip workers: a long cycle being re-encoded does not hold up the next clips
        for target, name in ((self._supervise, "cam-supervisor"), (self._clipper, "cam-clipper-1"),
                             (self._clipper, "cam-clipper-2"), (self._encode_chunks, "cam-chunks"),
                             (self._janitor, "cam-janitor"), (self._snapshots, "cam-snapshot"),
                             (self._watch_segments, "cam-segments"), (self._measure_old_clips, "cam-durations")):
            threading.Thread(target=target, name=name, daemon=True).start()

    def reload(self):
        self.cfg_version += 1

    def set_demo(self, mode):
        """Demo run: always record; mode "synthetic" records a generated test picture instead of the
        camera (used when the real camera is not streaming). None = back to the saved settings.
        Only a switch to/from the test picture restarts ffmpeg; "record" vs "preview" follows by itself."""
        switch = (self.demo == "synthetic") != (mode == "synthetic")
        self.demo = mode
        if switch:
            self.reload()

    def recording_since(self):
        """Wall time the current recording run wrote its first segment, or None (nothing on disk yet)."""
        if not self.launches or not self.info.get("recording"):
            return None
        mine = [t for t in self.seg_seen.values() if t >= self.launches[-1]]
        return min(mine) if mine else None

    def clip_status(self, seq):
        """Why a cycle has no clip yet: {"state": "queued" | "cutting" | "failed" | "none", "reason"}."""
        seq = int(seq)
        with self.lock:
            st = self.clip_states.get(seq)
        st = st or self._read_noclip(seq)
        if st:
            return {"state": st["state"], "reason": st["reason"]}
        if not self.ffmpeg:
            reason = "ffmpeg is not installed on the server PC"
        elif self.first_seq is None or seq < self.first_seq:
            reason = "the server was stopped or restarted before this clip was saved"
        else:
            reason = "the clip file is no longer on the server PC"
        return {"state": "none", "reason": reason}

    # Why a cycle got no clip is kept on disk (cycle_<seq>.noclip.json), so it is still known after a restart.
    def _noclip_path(self, seq, root=None):
        return os.path.join(root or self.clips_root(), "live", f"cycle_{int(seq)}.noclip.json")

    def _read_noclip(self, seq):
        for root in (self.clips_root(), self.default_clips_dir):
            try:
                with open(self._noclip_path(seq, root), encoding="utf-8") as f:
                    st = json.load(f)
            except (OSError, ValueError):
                continue
            if isinstance(st, dict) and st.get("state"):
                return st
        return None

    def requeue(self, cycles):
        """After a server start: cut the clips of recent cycles that were still waiting when the server
        stopped, while their recording is on disk. `cycles` = [(seq, start, end)]."""
        if not self._wants_recording():
            return 0
        horizon = dt.datetime.now() - dt.timedelta(seconds=KEEP_SEGMENTS_S - 60)
        n = 0
        for seq, start, end in cycles:
            if end >= horizon and not self.clip_path(seq) and not self._read_noclip(seq):
                self._queue(seq, start, end)
                n += 1
        return n

    def reset_clips(self):
        """Drop queued clips and delete every live cycle clip (cycle numbers restart)."""
        while True:
            try:
                self.clips.get_nowait()
            except queue.Empty:
                break
        with self.lock:
            self.clip_states.clear()
        self.first_seq = None
        for root in {self.clips_root(), self.default_clips_dir}:
            d = os.path.join(root, "live")
            try:
                names = os.listdir(d)
            except OSError:
                continue
            for n in names:
                if n.endswith(".mp4") or (n.startswith("cycle_") and n.endswith(".json")):
                    try:
                        os.remove(os.path.join(d, n))
                    except OSError:
                        pass
        self._set(clips_cut=0, clips_failed=0, last_clip=None, last_clip_error=None)

    def stop(self):
        self._kill()

    def snapshot(self):
        with self.lock:
            out = dict(self.info)
        out["viewers"] = self.viewers
        out["last_frame_age_s"] = round(time.time() - self.frame_at, 1) if self.frame_at else None
        out["rtsp_url"] = "demo test picture" if self.demo == "synthetic" else rtsp_url(self.get_cfg(), hide_password=True)
        out["demo"] = self.demo
        out["clips_dir"] = self.live_dir()
        cfg = self.get_cfg()
        pre, post = float(cfg.get("pre_roll_s") or 0), float(cfg.get("post_roll_s") or 0)
        out["pre_post"] = f"{pre:g} s before / {post:g} s after" if pre or post else ""
        return out

    def add_viewer(self):
        with self.cond:
            self.viewers += 1
            self.last_viewer = time.time()

    def remove_viewer(self):
        with self.cond:
            self.viewers = max(0, self.viewers - 1)
            self.last_viewer = time.time()

    def wait_frame(self, after_no, timeout):
        """Block until a frame newer than `after_no` arrives -> (jpeg, frame_no) or (None, after_no)."""
        with self.cond:
            self.last_viewer = time.time()
            self.cond.wait_for(lambda: self.frame_no != after_no and self.frame is not None, timeout=timeout)
            if self.frame_no != after_no and self.frame is not None:
                return self.frame, self.frame_no
            return None, after_no

    def on_cycle(self, seq, start, end):
        """Collector hook: queue the clip for this cycle (cut once its last second is on disk). Queued
        whenever recording is on, also while ffmpeg is reconnecting: the cut uses what was recorded."""
        if self.first_seq is None:
            self.first_seq = seq
        if not (self.info.get("recording") or self._wants_recording()):
            # remember why, as it was at the cycle (the settings may change later)
            self._clip_state(seq, "none", reason="ffmpeg is not installed on the server PC" if not self.ffmpeg
                             else "Camera Recording was OFF (Camera page)")
            return
        self._queue(seq, start, end)

    def _queue(self, seq, start, end):
        cfg = self.get_cfg()
        pre, post = float(cfg.get("pre_roll_s") or 0), float(cfg.get("post_roll_s") or 0)
        start = max(start, end - dt.timedelta(seconds=MAX_CLIP_S)) - dt.timedelta(seconds=pre)
        self._clip_state(seq, "queued", start=start)
        self.clips.put((seq, start, end + dt.timedelta(seconds=post), 0, 0.0))

    def _wants_recording(self):
        cfg = self.get_cfg()
        ip = "demo" if self.demo == "synthetic" else str(cfg.get("ip") or "").strip()
        return (bool(cfg.get("recording_enabled")) or bool(self.demo)) and bool(ip) and bool(self.ffmpeg)

    def _clip_state(self, seq, state, reason=None, start=None):
        with self.lock:
            if state is None:
                self.clip_states.pop(seq, None)
            else:
                start = start or (self.clip_states.get(seq) or {}).get("start")
                self.clip_states[seq] = {"state": state, "reason": reason, "start": start}
                while len(self.clip_states) > 500:            # keep the newest cycles only
                    self.clip_states.pop(next(iter(self.clip_states)))
        path = self._noclip_path(seq)
        try:
            if state in ("none", "failed"):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    json.dump({"state": state, "reason": reason}, f)
            elif os.path.exists(path):
                os.remove(path)
        except OSError:
            pass

    def _count(self, key):
        with self.lock:
            self.info[key] = self.info.get(key, 0) + 1

    # ----- internals -----
    def _set(self, **kw):
        with self.lock:
            self.info.update(kw)

    def _push_frame(self, jpeg):
        with self.cond:
            self.frame, self.frame_at = jpeg, time.time()
            self.frame_no += 1
            self.cond.notify_all()

    def _want_preview(self):
        return self.viewers > 0 or time.time() - self.last_viewer < PREVIEW_IDLE_S

    def _kill(self):
        p, self.proc = self.proc, None
        if p and p.poll() is None:
            try:
                p.terminate()
                p.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    p.kill()
                except OSError:
                    pass

    def _supervise(self):
        while True:
            try:
                self._supervise_loop()
            except Exception as e:  # noqa: BLE001 - e.g. a bad port value: report it, keep the thread alive
                self._set(state="error", last_error=f"{e.__class__.__name__}: {e}")
                self._kill()
                time.sleep(5)

    def _supervise_loop(self):
        version, backoff = None, 1.0
        while True:
            cfg = self.get_cfg()
            ip = "demo" if self.demo == "synthetic" else str(cfg.get("ip") or "").strip()
            record = self._wants_recording()
            want = "record" if record else ("preview" if ip and self.ffmpeg and self._want_preview() else None)
            running = self.proc is not None and self.proc.poll() is None

            if running and (want != self.proc_kind or version != self.cfg_version
                            or (self.frame_at and time.time() - self.frame_at > STALL_S and time.time() - self._started > STALL_S)
                            or (not self.frame_at and time.time() - self._started > 2 * STALL_S)):
                if self.frame_at and time.time() - self.frame_at > STALL_S and want == self.proc_kind:
                    self._set(last_error="No video from the camera for 15 s; reconnecting")
                self._kill()
                running = False
            if not ip:
                self._set(state="not_configured", recording=False, preview=False, source=None,
                          last_error="Camera IP is not set (Camera page)")
            elif not self.ffmpeg:
                self._set(state="no_ffmpeg", recording=False, preview=self._want_preview(), source="snapshot")
            elif want is None:
                self._set(state="idle", recording=False, preview=False, source=None)
            elif not running:
                if self.proc is not None:            # it died: keep its error, back off
                    self.proc = None
                    time.sleep(backoff)
                    backoff = min(backoff * 2, 15.0)
                    continue
                version = self.cfg_version
                self._launch(cfg, want)
            elif self.frame_at and time.time() - self.frame_at < 3:
                backoff = 1.0
                self._set(state="streaming", recording=want == "record", preview=True, last_error=None)
            time.sleep(0.5)

    def _launch(self, cfg, kind):
        synthetic = self.demo == "synthetic"
        cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin"]
        if synthetic:     # generated 1280x720 test picture with a running clock, encoded like a camera
            cmd += ["-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25"]
            vcodec = ["-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "25", "-pix_fmt", "yuv420p"]
        else:
            cmd += ["-rtsp_transport", "tcp", "-timeout", "10000000", "-i", rtsp_url(cfg)]
            vcodec = ["-c:v", "copy"]
        if kind == "record":
            os.makedirs(self.seg_dir(), exist_ok=True)
            cmd += ["-map", "0:v:0", *vcodec, "-an", "-f", "segment", "-segment_time", str(SEGMENT_S),
                    "-segment_format", "mpegts", "-strftime", "1",
                    os.path.join(self.seg_dir(), "%Y%m%d_%H%M%S.ts")]
        cmd += ["-map", "0:v:0", "-an", "-vf", "fps=5,scale=960:-2", "-c:v", "mjpeg", "-q:v", "7",
                "-f", "image2pipe", "pipe:1"]
        self._set(state="connecting", source="demo" if synthetic else "rtsp", recording=False)
        self._started = time.time()
        if kind == "record":
            self.launches = self.launches[-50:] + [self._started]
        self.frame_at = 0.0
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, creationflags=NO_WINDOW)
        except OSError as e:
            self._set(state="error", last_error=f"Could not start ffmpeg: {e}")
            self.proc = None
            time.sleep(5)
            return
        self.proc_kind = kind
        proc = self.proc
        threading.Thread(target=self._read_frames, args=(proc,), daemon=True).start()
        threading.Thread(target=self._read_errors, args=(proc,), daemon=True).start()

    def _read_frames(self, proc):
        buf = b""
        while True:
            chunk = proc.stdout.read1(1 << 16) if hasattr(proc.stdout, "read1") else proc.stdout.read(1 << 16)
            if not chunk:
                break
            buf += chunk
            while True:
                s = buf.find(b"\xff\xd8")
                e = buf.find(b"\xff\xd9", s + 2) if s >= 0 else -1
                if s < 0 or e < 0:
                    if s > 0:
                        buf = buf[s:]
                    break
                self._push_frame(buf[s:e + 2])
                buf = buf[e + 2:]
            if len(buf) > 8 << 20:           # garbage, resync
                buf = b""

    def _read_errors(self, proc):
        for raw in proc.stderr:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                cfg = self.get_cfg()
                # Never show the camera password from the URL in the UI.
                pw = str(cfg.get("password") or "")
                if pw:
                    line = line.replace(urllib.parse.quote(pw, safe=""), "****").replace(pw, "****")
                if self.demo != "synthetic":
                    if "Server returned 4XX" in line or "Server returned 5XX" in line:
                        line = self._diagnose(cfg) or line
                    else:
                        line = explain_ffmpeg(line, cfg)
                self._set(last_error=line[:300], state="error" if self.frame_at == 0 else self.info["state"])

    def _diagnose(self, cfg):
        """ffmpeg only says "4XX Client Error": ask the camera ourselves for the exact RTSP answer
        (once per settings version, in the background)."""
        version = self.cfg_version
        if version in self.rtsp_diag:
            return self.rtsp_diag[version]
        self.rtsp_diag[version] = None

        def probe():
            try:
                msg = explain_rtsp(rtsp_describe(cfg), cfg.get("rtsp_path"))
            except OSError as e:
                msg = explain_ffmpeg(str(e), cfg)
            self.rtsp_diag[version] = msg
            self._set(last_error=msg)
        threading.Thread(target=probe, daemon=True).start()
        return None

    def _snapshots(self):
        """No ffmpeg: poll the camera's HTTP snapshot while someone is watching."""
        while True:
            cfg = self.get_cfg()
            ip = str(cfg.get("ip") or "").strip()
            if self.ffmpeg or not ip or not self._want_preview():
                time.sleep(0.5)
                continue
            jpeg, err = None, None
            for path in SNAPSHOT_PATHS:
                try:
                    jpeg = http_get(f"http://{ip}{path}", cfg.get("username"), cfg.get("password"))
                    if jpeg[:2] == b"\xff\xd8":
                        break
                    jpeg, err = None, f"{path}: not a JPEG"
                except Exception as e:  # noqa: BLE001 - any network/auth problem is shown in the UI
                    err = f"Snapshot {path}: {e}"
            if jpeg:
                self._push_frame(jpeg)
                self._set(last_error="ffmpeg not found: live preview uses camera snapshots, cycle clips are not recorded")
            else:
                self._set(last_error=err)
                time.sleep(2)
            time.sleep(0.5)

    def _seg_names(self):
        try:
            return [n for n in os.listdir(self.seg_dir()) if n.endswith(".ts")]
        except OSError:
            return []

    def _watch_segments(self):
        """Note when each segment file appears. ffmpeg's strftime name only has whole seconds;
        the moment the file shows up is when its first frame arrived, to ~0.1 s."""
        old = set(self._seg_names())         # from before this server start: keep their name times
        while True:
            names = set(self._seg_names())
            now = time.time()
            for n in names - old - self.seg_seen.keys():
                self.seg_seen[n] = now
            for n in list(self.seg_seen):
                if n not in names:
                    del self.seg_seen[n]
            time.sleep(0.1)

    def _segments(self):
        out = []
        for n in self._seg_names():
            seen = self.seg_seen.get(n)
            if seen:
                out.append((dt.datetime.fromtimestamp(seen), n))
                continue
            try:
                out.append((dt.datetime.strptime(n[:-3], "%Y%m%d_%H%M%S"), n))
            except ValueError:
                pass
        out.sort()
        return out

    def _clipper(self):
        while True:
            seq, start, end, attempt, not_before = self.clips.get()
            wait = max((end - dt.datetime.now()).total_seconds() + LATENCY_S + 1.5, not_before - time.time())
            if wait > 0:
                time.sleep(wait)
            self._clip_state(seq, "cutting")
            try:
                self._cut(seq, start, end)
                self._clip_state(seq, None)
                self._count("clips_cut")
                self._set(last_clip=seq, last_clip_error=None)
            except Exception as e:  # noqa: BLE001
                if attempt == 0:                     # e.g. the camera was reconnecting: try once more
                    self._clip_state(seq, "queued", reason=f"retrying: {e}")
                    self.clips.put((seq, start, end, 1, time.time() + 5))
                    continue
                self._clip_state(seq, "failed", reason=str(e))
                self._count("clips_failed")
                self._set(last_clip_error=f"cycle {seq}: {e}")
                print(f"[camera] no clip for cycle {seq}: {e}", flush=True)

    # ----- clips: pre-encoded chunks -----
    # While recording, every finished segment is converted to an H.264 chunk in the background. A clip is
    # then its first and last few seconds (encoded at the exact frame) joined to the chunks in between
    # without re-encoding, so it is ready a few seconds after the cycle however long the cycle was.
    def chunk_dir(self):
        return os.path.join(self.seg_dir(), "enc")

    def _chunk_of(self, seg_name):
        """The finished chunk for a segment, or None (missing, or older than the segment file)."""
        p = os.path.join(self.chunk_dir(), seg_name + ".mp4")
        try:
            return p if os.path.getmtime(p) >= os.path.getmtime(os.path.join(self.seg_dir(), seg_name)) else None
        except OSError:
            return None

    def _encode_piece(self, seg_name, ss, t, out, errors=None):
        """Encode a segment (or [ss, ss + t] of it) to `out` with VCODEC; None if it holds no video
        (an ffmpeg error message is added to `errors`)."""
        os.makedirs(os.path.dirname(out), exist_ok=True)
        tmp = f"{out}.{threading.get_ident()}.tmp.mp4"     # the chunker and a clip may encode the same chunk
        cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", seg_name]
        if ss:      # after -i: decode from the segment's first frame (a keyframe), drop frames up to ss
            cmd += ["-ss", f"{ss:.3f}"]
        if t is not None:
            cmd += ["-t", f"{max(t, 0.04):.3f}"]
        cmd += ["-map", "0:v:0", "-an", *VCODEC, "-f", "mp4", tmp]
        r = subprocess.run(cmd, cwd=self.seg_dir(), stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=120, creationflags=NO_WINDOW)
        if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 1024:
            try:
                os.remove(tmp)
            except OSError:
                pass
            if r.returncode != 0 and errors is not None:
                errors.append((r.stderr.decode("utf-8", "replace").strip().splitlines() or ["ffmpeg failed"])[-1][:200])
            return None
        os.replace(tmp, out)
        return out

    def _pts(self, seg_name):
        """First timestamp of a segment (seconds), cached; None if it can't be read."""
        if seg_name in self.seg_pts:
            return self.seg_pts[seg_name]
        try:                                 # ffmpeg's "Duration: 00:00:04.00, start: 17.680000," line
            r = subprocess.run([self.ffmpeg, "-hide_banner", "-nostdin", "-i", seg_name], cwd=self.seg_dir(),
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=10, creationflags=NO_WINDOW)
            v = float(re.search(r"start: (-?[\d.]+)", r.stderr.decode("utf-8", "replace")).group(1))
        except (OSError, AttributeError, ValueError, subprocess.TimeoutExpired):
            return None
        if len(self.seg_pts) > 2000:
            self.seg_pts.clear()
        self.seg_pts[seg_name] = v
        return v

    def _encode_chunks(self):
        while True:
            time.sleep(0.5)
            if not self.ffmpeg:
                continue
            try:
                segs = self._segments()
                horizon = dt.datetime.now() - dt.timedelta(seconds=MAX_CLIP_S + 60)
                for (t0, name), _ in zip(segs, segs[1:]):      # the newest segment is still being written
                    if t0 >= horizon and not self._chunk_of(name):
                        self._encode_piece(name, None, None, os.path.join(self.chunk_dir(), name + ".mp4"))
                    if t0 >= horizon:
                        self._pts(name)                          # warm the cache the cut reads
            except Exception:  # noqa: BLE001 - a bad segment must not stop the chunks
                pass

    def _cut(self, seq, start, end):
        # Segment times are arrival times, so look for the picture where it arrived.
        start += dt.timedelta(seconds=LATENCY_S)
        end += dt.timedelta(seconds=LATENCY_S)
        segs = self._segments()
        # segments that overlap [start, end] by arrival time, plus one more on each side (arrival times jitter)
        idx = [i for i, (t0, _) in enumerate(segs)
               if t0 <= end and (segs[i + 1][0] if i + 1 < len(segs) else dt.datetime.now()) >= start]
        if not idx:
            raise RuntimeError("no recorded video for this time")
        cand = segs[max(0, idx[0] - 1): idx[-1] + 2]
        # Each ffmpeg run restarts its timestamps: only join segments of the run that holds the end.
        run = bisect.bisect_right(self.launches, segs[idx[-1]][0].timestamp())
        cand = [c for c in cand if bisect.bisect_right(self.launches, c[0].timestamp()) == run]
        # Place them on the run's media timeline: wall = timestamp + offset. A segment can only arrive late,
        # never early, so the offset is the smallest (arrival - timestamp) of the nearby segments.
        run_segs = [x for x in segs if bisect.bisect_right(self.launches, x[0].timestamp()) == run]
        k = next((i for i, x in enumerate(run_segs) if x[1] == cand[0][1]), 0)
        offs = []
        for t0, name in run_segs[max(0, k - 10): k + len(cand)]:
            p = self._pts(name)
            if p is not None and name in self.seg_seen:      # (a name time has whole seconds only)
                offs.append(t0.timestamp() - p)
        offs.sort()
        mid = offs[len(offs) // 2] if offs else None
        offs = [o for o in offs if mid is not None and abs(o - mid) < 10]   # not across a timestamp wrap
        offset = offs[0] if offs else None
        placed = []
        for t0, name in cand:
            p = self._pts(name)
            ok = offset is not None and p is not None and abs(t0.timestamp() - p - offset) < 10
            placed.append((dt.datetime.fromtimestamp(p + offset) if ok else t0, name))
        use = []
        for i, (t0, name) in enumerate(placed):
            t1 = placed[i + 1][0] if i + 1 < len(placed) else dt.datetime.now() + dt.timedelta(seconds=60)
            if t0 <= end and t1 > start:
                use.append((t0, t1, name))
        if not use:
            raise RuntimeError("no recorded video for this time")
        if run not in self.run_codec:
            self.run_codec[run] = self._codec_of(use[0][2])
            self._set(camera_codec=self.run_codec[run])
        # Encoded to H.264 at the exact first and last frame (a stream copy could only start on a camera
        # keyframe, 1-4 s off), and H.265 cameras become H.264, the only codec every browser plays.
        work = os.path.join(self.chunk_dir(), f".clip_{seq}")
        shutil.rmtree(work, ignore_errors=True)
        pieces, errors = [], []
        try:
            for i, (t0, t1, name) in enumerate(use):
                a = max(0.0, (start - t0).total_seconds())                 # from here in this segment ...
                last = i == len(use) - 1 or end < t1
                b = (end - t0).total_seconds() if last else None            # ... to here (None: to its end)
                if a < 0.02 and b is None:                                  # all of it: the ready chunk
                    piece = self._chunk_of(name) or self._encode_piece(
                        name, None, None, os.path.join(self.chunk_dir(), name + ".mp4"), errors)
                else:
                    if b is not None and b - a < 0.04:
                        continue
                    out = os.path.join(work, f"{i}.mp4")
                    piece = self._encode_piece(name, a, None if b is None else b - a, out, errors)
                    # The last piece may not be on disk in full yet (the camera's picture arrives late):
                    # wait for it, up to 6 s.
                    for _ in range(6 if last and b is not None else 0):
                        got = self._duration_of(piece) if piece else 0.0
                        if got is not None and got >= (b - a) - 0.06:
                            break
                        time.sleep(1.0)
                        piece = self._encode_piece(name, a, b - a, out, errors)
                if piece:
                    pieces.append(os.path.relpath(piece, self.chunk_dir()).replace(os.sep, "/"))
            if not pieces:
                raise RuntimeError(errors[0] if errors else "no recorded video for this time")
            os.makedirs(work, exist_ok=True)
            listing = os.path.join(work, "pieces.txt")
            with open(listing, "w", encoding="utf-8") as f:
                f.writelines(f"file '../{p}'\n" for p in pieces)
            out_dir = self.live_dir()
            tmp = os.path.join(out_dir, f".cycle_{seq}.tmp.mp4")
            cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0",
                   "-i", listing, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp]
            r = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=120, creationflags=NO_WINDOW)
            if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 1024:
                try:
                    os.remove(tmp)
                except OSError:
                    pass
                raise RuntimeError((r.stderr.decode("utf-8", "replace").strip().splitlines() or ["ffmpeg failed"])[-1][:200])
            final = os.path.join(out_dir, f"cycle_{seq}.mp4")
            os.replace(tmp, final)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        self._write_info(final, start=start.isoformat(timespec="milliseconds"), end=end.isoformat(timespec="milliseconds"))

    def _codec_of(self, seg_name):
        """Video codec in a recorded segment ("h264", "hevc", ...), read from ffmpeg's stream info."""
        try:
            r = subprocess.run([self.ffmpeg, "-hide_banner", "-nostdin", "-i", seg_name], cwd=self.seg_dir(),
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=20, creationflags=NO_WINDOW)
        except (OSError, subprocess.TimeoutExpired):
            return None
        m = re.search(r"Video: (\w+)", r.stderr.decode("utf-8", "replace"))
        return m.group(1) if m else None

    def _janitor(self):
        while True:
            time.sleep(30)
            try:
                self._clean()
            except Exception:  # noqa: BLE001 - cleanup must never stop
                pass

    def _clean(self):
        now = dt.datetime.now()
        with self.lock:                      # segments a queued clip still needs are kept
            pending = [st["start"] for st in self.clip_states.values() if st["state"] in ("queued", "cutting") and st["start"]]
        keep_from = min(pending) - dt.timedelta(seconds=60) if pending else now
        for t0, name in self._segments()[:-2]:
            if (now - t0).total_seconds() > KEEP_SEGMENTS_S and t0 < keep_from:
                try:
                    os.remove(os.path.join(self.seg_dir(), name))
                except OSError:
                    pass
        try:                                 # chunks whose segment is gone
            names = set(self._seg_names())
            for n in os.listdir(self.chunk_dir()):
                p = os.path.join(self.chunk_dir(), n)
                if n.endswith(".tmp.mp4"):
                    if time.time() - os.path.getmtime(p) > 600:   # left over from a crash
                        os.remove(p)
                elif n.endswith(".mp4") and n[:-4] not in names:
                    os.remove(p)
        except OSError:
            pass
        days = float(self.get_cfg().get("retention_days") or 30)
        cutoff = time.time() - days * 86400
        try:
            for n in os.listdir(self.live_dir()):
                p = os.path.join(self.live_dir(), n)
                if (n.endswith(".mp4") or (n.startswith("cycle_") and n.endswith(".json"))) and os.path.getmtime(p) < cutoff:
                    os.remove(p)
        except OSError:
            pass


def http_get(url, user, password, timeout=4):
    mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
    if user:
        mgr.add_password(None, url, str(user), str(password or ""))
    opener = urllib.request.build_opener(urllib.request.HTTPDigestAuthHandler(mgr),
                                         urllib.request.HTTPBasicAuthHandler(mgr))
    with opener.open(url, timeout=timeout) as r:
        return r.read(4 << 20)
