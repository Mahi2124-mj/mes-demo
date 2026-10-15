"""Camera side of the live demo: recording, per-cycle clips and live preview.

One ffmpeg process reads the camera's RTSP stream (Panasonic default path
/MediaInput/h264) and writes two things at once:
  * 4-second MPEG-TS segments (stream copy, no re-encode) into <clips>/live/seg/
  * a 5 fps, 960 px wide JPEG stream on stdout for the live preview
For every cycle the collector reports, the matching seconds are cut out of the
segments (stream copy again) into <clips>/live/cycle_<seq>.mp4.

When recording is OFF, the preview still works: ffmpeg is started only while
someone is watching.  Without ffmpeg installed, the preview falls back to the
camera's HTTP snapshot (Panasonic /cgi-bin/camera) and no clips are recorded.
"""
import bisect
import datetime as dt
import os
import queue
import shutil
import subprocess
import threading
import time
import urllib.parse
import urllib.request

SEGMENT_S = 4
KEEP_SEGMENTS_S = 180       # segments are only needed until the cycle's clip is cut
PREVIEW_IDLE_S = 20         # stop a preview-only ffmpeg this long after the last viewer leaves
STALL_S = 15                # no frame for this long -> restart ffmpeg
SEEK_MARGIN_S = 1.5         # stream-copy cuts begin on a keyframe; seek earlier so a clip never starts late
LATENCY_S = 0.5             # an IP camera's picture reaches us about this long after the moment it shows
SNAPSHOT_PATHS = ("/cgi-bin/camera?resolution=640", "/SnapshotJPEG?Resolution=640x480")
NO_WINDOW = 0x08000000 if os.name == "nt" else 0       # CREATE_NO_WINDOW


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
        self.info = {"state": "starting", "last_error": None, "recording": False, "preview": False,
                     "ffmpeg": self.ffmpeg, "clips_cut": 0, "clips_failed": 0, "last_clip": None,
                     "last_clip_error": None, "source": None}

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

    # ----- public -----
    def start(self):
        for target, name in ((self._supervise, "cam-supervisor"), (self._clipper, "cam-clipper"),
                             (self._janitor, "cam-janitor"), (self._snapshots, "cam-snapshot"),
                             (self._watch_segments, "cam-segments")):
            threading.Thread(target=target, name=name, daemon=True).start()

    def reload(self):
        self.cfg_version += 1

    def set_demo(self, mode):
        """Demo run: always record; mode "synthetic" records a generated test picture instead of the
        camera (used when the real camera is not streaming). None = back to the saved settings."""
        self.demo = mode
        self.reload()

    def reset_clips(self):
        """Drop queued clips and delete every live cycle clip (cycle numbers restart)."""
        while True:
            try:
                self.clips.get_nowait()
            except queue.Empty:
                break
        for root in {self.clips_root(), self.default_clips_dir}:
            d = os.path.join(root, "live")
            try:
                names = os.listdir(d)
            except OSError:
                continue
            for n in names:
                if n.endswith(".mp4"):
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
        """Collector hook: queue the clip for this cycle (cut once its last second is on disk)."""
        if self.info.get("recording"):
            cfg = self.get_cfg()
            pre, post = float(cfg.get("pre_roll_s") or 0), float(cfg.get("post_roll_s") or 0)
            self.clips.put((seq, start - dt.timedelta(seconds=pre), end + dt.timedelta(seconds=post)))

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
            record = (bool(cfg.get("recording_enabled")) or bool(self.demo)) and bool(ip) and bool(self.ffmpeg)
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
                # Never show the camera password from the URL in the UI.
                pw = str(self.get_cfg().get("password") or "")
                if pw:
                    line = line.replace(urllib.parse.quote(pw, safe=""), "****").replace(pw, "****")
                self._set(last_error=line[:300], state="error" if self.frame_at == 0 else self.info["state"])

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
            seq, start, end = self.clips.get()
            wait = (end - dt.datetime.now()).total_seconds() + LATENCY_S + 1.5
            if wait > 0:
                time.sleep(wait)
            try:
                self._cut(seq, start, end)
                self._set(clips_cut=self.info["clips_cut"] + 1, last_clip=seq, last_clip_error=None)
            except Exception as e:  # noqa: BLE001
                self._set(clips_failed=self.info["clips_failed"] + 1, last_clip_error=f"cycle {seq}: {e}")
                print(f"[camera] no clip for cycle {seq}: {e}", flush=True)

    def _cut(self, seq, start, end):
        # Segment times are arrival times, so look for the picture where it arrived.
        start += dt.timedelta(seconds=LATENCY_S)
        end += dt.timedelta(seconds=LATENCY_S)
        seek = start - dt.timedelta(seconds=SEEK_MARGIN_S)
        segs = self._segments()
        # segments that overlap [seek, end]: a segment runs until the next one starts
        use = []
        for i, (t0, name) in enumerate(segs):
            t1 = segs[i + 1][0] if i + 1 < len(segs) else dt.datetime.now()
            if t0 <= end and t1 >= seek:
                if use and (t0 - use[-1][0]).total_seconds() > 2.5 * SEGMENT_S:
                    use = []                 # ffmpeg restarted in between: timestamps restart, keep the later run
                use.append((t0, name))
        if not use:
            raise RuntimeError("no recorded video for this time")
        # Each ffmpeg run restarts its timestamps: only join segments of the run that holds the end.
        run = bisect.bisect_right(self.launches, use[-1][0].timestamp())
        use = [u for u in use if bisect.bisect_right(self.launches, u[0].timestamp()) == run]
        offset = max(0.0, (seek - use[0][0]).total_seconds())
        dur = (end - use[0][0]).total_seconds() - offset
        out_dir = self.live_dir()
        os.makedirs(out_dir, exist_ok=True)
        tmp = os.path.join(out_dir, f".cycle_{seq}.tmp.mp4")
        cmd = [self.ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-ss", f"{offset:.2f}", "-i", "concat:" + "|".join(n for _, n in use),
               "-t", f"{dur:.2f}", "-map", "0:v:0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp]
        r = subprocess.run(cmd, cwd=self.seg_dir(), stdin=subprocess.DEVNULL, capture_output=True,
                           timeout=60, creationflags=NO_WINDOW)
        if r.returncode != 0 or not os.path.isfile(tmp) or os.path.getsize(tmp) < 1024:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise RuntimeError((r.stderr.decode("utf-8", "replace").strip().splitlines() or ["ffmpeg failed"])[-1][:200])
        os.replace(tmp, os.path.join(out_dir, f"cycle_{seq}.mp4"))

    def _janitor(self):
        while True:
            time.sleep(30)
            try:
                self._clean()
            except Exception:  # noqa: BLE001 - cleanup must never stop
                pass

    def _clean(self):
        now = dt.datetime.now()
        for t0, name in self._segments()[:-2]:
            if (now - t0).total_seconds() > KEEP_SEGMENTS_S:
                try:
                    os.remove(os.path.join(self.seg_dir(), name))
                except OSError:
                    pass
        days = float(self.get_cfg().get("retention_days") or 30)
        cutoff = time.time() - days * 86400
        try:
            for n in os.listdir(self.live_dir()):
                p = os.path.join(self.live_dir(), n)
                if n.endswith(".mp4") and os.path.getmtime(p) < cutoff:
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
