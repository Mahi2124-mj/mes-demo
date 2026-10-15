# MES demo clone (port 5000)

A standalone, no-login copy of three MES screens for demos. It has **no link to the
live MES**: no database, no PLC, no camera, no calls to the MES ports. The live MES
was only read once, to copy the demo data.

| Page | URL |
|---|---|
| Supervisor Dashboard | `http://<server>:5000/YCA-SS/SUPERVISOR` |
| Management Dashboard (Final Inspection) | `http://<server>:5000/YCA-SS/MANAGEMENT` |
| Machine Config (one FX5U machine) | `http://<server>:5000/machine-config` |
| Camera Setting (one camera) | `http://<server>:5000/camera` |

## Data
- `data/cycles.json` — YCA-SS (line 12) Final Inspection, 2026-10-08 shift A, cycles #1600-#1699.
  80 of them have a clip in the MES archive; those 80 plus #1683 are shown (81 cycles).
  **Demo edit (user request, 9-Oct):** cycle times are staged — only #1662, #1669 and #1683 are over
  target (17.84 / 19.26 / 21.07 s); every other cycle is 13.0-14.8 s. The real values are kept in
  `ct_real`. #1683 was added on request; it has no clip, so it shows "No video available".
- `clips/main/cycle_<seq>.mp4` — the matching recorded clips (H.264, copied read-only).
- `data/mgmt/` — YCA-SS line config (no PLC addresses), production history, 30-day CT histogram, PM status.
- `data/machine.json`, `data/camera.json` — what the config pages save.
- `data/comments.json` — comments typed on cycle videos.

## Run
    ./start.sh        # builds the frontend if needed, starts on port 5000
    ./stop.sh

Rebuild after a frontend change: `npx vite build`, then reload the page.

## Management dashboard
Replays the same recorded shift: the page clock is pinned to 2026-10-08 16:49 (shift A), so plan,
timeline and hourly slots match the recorded Final Inspection cycles (realtime is computed from them).
Static extras live in `data/mgmt/` (line config without PLC addresses, PY list, PM status, 30-day CT histogram).

## Video start time
Clips start in about 0.15-0.2 s on the LAN. Closed clips stop downloading, a failed load retries after
0.3-0.6 s (was 5 s), and the server sends clips in 1 MB slices so no browser connection stays blocked.

## Note
The MES scripts `start_everything.sh` / `stop_everything.sh` free port 5000
(`fuser -k 5000/tcp`) — a full MES restart also stops this demo. Run `./start.sh` again afterwards.
