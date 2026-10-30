# MES demo clone (port 5000)

A standalone, no-login copy of MES screens for demos. It has **no link to the live MES**:
no database, no calls to the MES ports. The live MES was only read once, to copy the demo data.

Two kinds of data:
- **Recorded** (SUPERVISOR, MANAGEMENT): one recorded YCA-SS shift, replayed.
- **Live** (MANAGEMENT-2): the demo machine's own PLC and camera, read by this server
  (see [Live data](#live-data-management-2)).

| Page | URL |
|---|---|
| Supervisor Dashboard | `http://<server>:5000/YCA-SS/SUPERVISOR` |
| Management Dashboard (Final Inspection, recorded) | `http://<server>:5000/YCA-SS/MANAGEMENT` |
| Management Dashboard 2 (**live** PLC + camera) | `http://<server>:5000/YCA-SS/MANAGEMENT-2` |
| Machine Config (one FX5U machine) + ④ Collector Data | `http://<server>:5000/machine-config` |
| Camera Setting (one camera) + live preview | `http://<server>:5000/camera` |
| Cycle Videos (cycle time vs clip length, play each clip) | `http://<server>:5000/cycle-videos` |

## Data
- `data/cycles.json` — YCA-SS (line 12) Final Inspection, 2026-10-08 shift A, cycles #1600-#1699.
  80 of them have a clip in the MES archive; those 80 plus #1683 are shown (81 cycles).
  **Demo edit (user request, 9-Oct):** cycle times are staged — only #1662, #1669 and #1683 are over
  target (17.84 / 19.26 / 21.07 s); every other cycle is 13.0-14.8 s. The real values are kept in
  `ct_real`. #1683 was added on request; it has no clip, so its popup says "this recorded cycle has no clip".
- `clips/main/cycle_<seq>.mp4` — the matching recorded clips (H.264, copied read-only). **Not in git**
  (`clips/` is ignored, 144 MB): copy the `clips\main` folder from the PC where the demo was first set up.
  Without it the SUPERVISOR / MANAGEMENT video popups say "the recorded clips are not on the server PC".
- `data/mgmt/` — YCA-SS line config (no PLC addresses), production history, 30-day CT histogram, PM status.
- `data/machine.json`, `data/camera.json` — what the config pages save.
- `data/comments.json` — comments typed on cycle videos.
- `data/live/` — live cycles and status timeline from the PLC, one JSON-lines file per shift.
- `clips/live/cycle_<seq>.mp4` — one clip per live cycle (`clips/live/seg/` holds the last 3 minutes of raw recording).

## Run
Linux:

    ./start.sh        # builds the frontend if needed, starts on port 5000
    ./stop.sh

Windows (PowerShell, in the repo folder):

    .\start.bat      # first run: npm install + ffmpeg download into .\ffmpeg; then build + python server.py
                      # stop with Ctrl+C

Other PCs on the LAN open `http://<this PC's IP>:5000/...` (the server prints the links at start).
No CORS setting is involved: pages and API come from the same server. Windows Firewall must allow
TCP 5000 — `start.bat` adds that rule once when run as Administrator.

Rebuild after a frontend change: `npx vite build`, then reload the page.
Needs Python 3.8+ (standard library only) and, for live cycle clips, **ffmpeg**
(Windows: unzip a build into the repo so that `ffmpeg\bin\ffmpeg.exe` exists — no PATH needed:

    [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip -OutFile ffmpeg.zip
    Expand-Archive ffmpeg.zip -DestinationPath ffmpeg-tmp
    Move-Item (Get-ChildItem ffmpeg-tmp)[0].FullName ffmpeg
    Remove-Item ffmpeg.zip, ffmpeg-tmp -Recurse

or install it system-wide). The server prints whether it found ffmpeg when it starts.

## Live data (MANAGEMENT-2)
MANAGEMENT-2 uses its own line id (99), so every `/api/lines/99/...` call is answered from
the live collector instead of the recorded shift. MANAGEMENT stays on the recorded data.
The server PC must be on the machine network (192.168.30.x).

**PLC — `collector.py` + `slmp.py`** (settings: Machine Config page)
- Mitsubishi FX5U, SLMP binary 3E (or 4E) over TCP, default `192.168.30.10:5000`.
  In GX Works3 the built-in Ethernet port needs an *SLMP connection* (TCP, port 5000, binary).
- **Read only** — nothing is ever written to the PLC.
- Cycles: count mode *bit* = a rising edge on the OK bit (L108) or NG bit (L109), ignoring
  edges closer than "OK/NG pulse min gap"; mode *register* = the OK/NG counters (D101/D102) going up.
- CT = the PLC's own "cycle time register" (default D103, 0.1 s units), read on each OK/NG signal.
  If it is blank or 0: the real time since the previous OK/NG signal (no cap), minus scheduled breaks,
  PLC OFFLINE time and loss statuses inside that time. The first cycle of a shift is timed from the shift
  start (+ start-up delay) or from when the collector reached the PLC, whichever is later. After a server
  restart the next cycle is still timed from the last stored signal.
- The clip is exactly the cycle time (cycles longer than 10 minutes get a clip of their last 10 minutes).
  The CT graph's axis follows the data (2x to 6x the ideal CT).
- Ideal CT (Machine Config) defaults to **10 s**. Speed loss is **net**: Σ(CT − ideal), so a 14 s cycle
  adds 4 s and a 9 s cycle takes 1 s back; it can go negative (shown green).
- **Andon (loss) registers** (Machine Config → PLC Config): one D register per loss, a value other
  than 0 = that loss is on. Defaults: D100 Maintenance (timeline BREAKDOWN), D200 Quality, D300 Material,
  D400 Setup, D500 Change over, D600 Other losses. The loss shows on the shift timeline (with the andon
  name in its tooltip), in the loss distribution and the hourly loss table, and its time is left out of
  the cycle time. Two calls at once: the first in that list counts.
- Without an andon call: an optional status word (0 idle, 1 running, 2+ loss codes) if one is set and is
  not an andon register; otherwise RUNNING while cycles keep coming (up to the max allowed cycle, 3x ideal
  or 1.5x the last CT), IDLE after that. `PLC OFFLINE` is logged while the PLC can't be reached.
- Shifts and hourly slots come from `data/mgmt/line.json`. Cycles made in a gap after a shift (OT) count
  for that shift. Plan = working time so far ÷ the machine's ideal CT (Machine Config). Time without PLC
  data (`PLC OFFLINE`) counts neither for plan nor against availability.
- CT distribution = the live cycles of the last 30 days (0.1 s buckets); its axis follows the data.
- Cycle signals, counters and the digital inputs from "Monitor Config" are read every second and shown
  in **Collector Data** (Machine Config tab ④, and the 📡 COLLECTOR button on MANAGEMENT-2).

**Demo PLC run — `demo_plc.py`** (Collector Data → ▶ Run demo)
- Deletes all live data (cycles, timeline, clips), then a built-in demo PLC plays N cycles (default 30)
  over the same SLMP path: CT written to D103, OK pulse on L108. Cycle times are mixed around the ideal
  (e.g. 9, 10, 14 s for 10 s), so speed loss goes + and −. Halfway it makes one 15 s andon call on the
  first andon register (Maintenance), so a loss shows on the timeline. Takes about N × ideal + 15 seconds.
- The real PLC is not read during the demo; the collector switches back to it afterwards.
- Video: the real camera if it is streaming, otherwise a generated test picture (needs ffmpeg).

**Camera — `camera.py`** (settings: Camera page)
- RTSP, default `rtsp://admin:<password>@192.168.30.20:554/h264/ch1/main/av_stream` (main stream).
  The password is entered on the Camera page (never shown again, never sent to the browser).
  H.264 or H.265 both work (clips are always saved as H.264).
- One ffmpeg process keeps one RTSP session: it records 4 s segments (stream copy, no re-encode)
  and feeds the live preview (5 fps JPEG). For each cycle, exactly that cycle (+ pre/post roll, default
  0 s) is saved as H.264 in `clips/live/cycle_<seq>.mp4`, so the clip is as long as the cycle time;
  MANAGEMENT-2 plays it like the recorded clips.
- Fast clips: while recording, each finished segment is encoded to H.264 in the background
  (`clips/live/seg/enc/`). At the OK/NG signal only the first and last few seconds are encoded (at the
  exact frame) and joined to those chunks without re-encoding: a clip is ready about 3-4 s after the
  signal, however long the cycle was. This keeps one CPU core partly busy while recording.
- Recording OFF: no clips; the preview opens the stream only while someone is watching.
- Every cycle gets a clip while recording is on, also when the camera is reconnecting at that moment
  (the clip then has what was recorded). A failed cut is retried once; two clips can be cut at a time.
  No clip yet: the popup says why (still being saved — it opens by itself, failed + reason, Recording was
  OFF, or the server was stopped before the clip was saved) instead of a "can't decode" message. The reason
  is kept next to the clips (`cycle_<seq>.noclip.json`), so it is still shown after a restart.
- Server restart: clips of the last cycles that were still waiting (up to ~10 minutes back) are cut after
  the start from the recording on disk.
- Without ffmpeg: the preview falls back to the camera's HTTP snapshot (`/ISAPI/.../picture` or `/cgi-bin/camera`), no clips.
- Live preview: Camera page → Preview → Live, or the 📷 CAMERA button on MANAGEMENT-2.

## Layout (MANAGEMENT-2)
⚙ LAYOUT in the header opens a panel; every change shows at once and is saved on the server
(`data/dashboard_layout.json`), so every screen shows the same (other screens pick it up within 30 s).
- CT graph seconds (both layouts): from / to (e.g. 0-70 s or 0-90 s; Auto = follows the data), and where
  the CT distribution axis ends. Cycles above the end are drawn at the top with a white ring.
- Box sizes, separately for portrait and landscape: − / + for the KPI band, CT graph + CT distribution,
  CT graph width, hourly table, shift timeline, documents, loss distribution and poka-yoke / sensor.
  "Auto" puts a size back to its automatic value; "Reset box sizes" / "Reset CT seconds" restore all.
- Poka-yoke shows five demo checks (PY-01..PY-05). OK state: all pass, ✓ ALL SET OK, and the popup (tap)
  shows zero failures. Hold the box for 3 s to switch to the NG state: NUT SEATED A (X1) and TORQUE OK (X3)
  fail (⚠ 2 FAILED); the popup shows them ongoing in the current slot plus a 4 min failure of each in the two
  slots before. Hold again for OK. Saved the same way, for every screen.
- Sensor Health shows four demo sensors on the station's inputs: X4 Gun, X6, X7, X10 (names from Machine
  Config's digital inputs). Each toggles ON / OFF on its own period (3 / 5 / 7 / 11 s); the panel refreshes
  every 2 s.

## Documents (MANAGEMENT-2)
The line's sheets open in a popup: 📄 DOCUMENTS button in the MANAGEMENT-2 header (any layout), or
tap a sheet in the Documents card (portrait layout: Track Record upright on the left, the four
landscape sheets in a 2×2 grid on the right).
- Track Record Sheet (YNC / YHB / YRA / YSD), 4M Change Control Sheet (4 sheets), Operator
  Visualization Sheet, Annual Safety Chart, Defect Recording Sheet.
- Popup: document tabs, sheet tabs, ‹ › or ← → to page through every sheet, click the sheet for 100 %
  zoom, the red ✕ on the sheet's top-right corner (or Esc) closes, "⬇ PDF / Print" opens the PDF.
- Files: `public/docs/<doc>-<n>.png` (one image per sheet), `<doc>-<n>.thumb.png`, `<doc>.pdf`,
  made from the Excel files. To change a sheet, replace its PNG/PDF with the same name and rebuild.

## Management dashboard (recorded)
Replays the same recorded shift: the page clock is pinned to 2026-10-08 16:49 (shift A), so plan,
timeline and hourly slots match the recorded Final Inspection cycles (realtime is computed from them).
Static extras live in `data/mgmt/` (line config without PLC addresses, PY list, PM status, 30-day CT histogram).

## Video start time
Clips start in about 0.15-0.2 s on the LAN. Closed clips stop downloading, a failed load retries after
0.3-0.6 s (was 5 s), and the server sends clips in 1 MB slices so no browser connection stays blocked.

## Note
The MES scripts `start_everything.sh` / `stop_everything.sh` free port 5000
(`fuser -k 5000/tcp`) — a full MES restart also stops this demo. Run `./start.sh` again afterwards.
