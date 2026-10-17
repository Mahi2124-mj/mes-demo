"""Demo PLC: a small stand-in for the FX5U for demos without the machine.

It answers the same SLMP requests as the real PLC (binary 3E/4E, batch read of
words and bits) on 127.0.0.1 and plays a list of cycle times on the addresses
saved on Machine Config (PLC Config): for each cycle it writes the cycle time
register, counts the OK or NG counter and pulses the OK or NG bit, like the
machine program does.  The collector reads it exactly like the real PLC, so demo
cycles take the normal path (signals -> cycles -> clips -> dashboard).
Nothing here talks to the real PLC.
"""
import random
import socket
import struct
import threading
import time

from collector import ANDON
from slmp import parse_address

CODES = {0x9C: "X", 0x9D: "Y", 0x90: "M", 0x92: "L", 0x93: "F", 0xA0: "B", 0x91: "SM",
         0xA8: "D", 0xB4: "W", 0xAF: "R", 0xA9: "SD", 0xB0: "ZR"}
BIT_DEVS = {"X", "Y", "M", "L", "F", "B", "SM"}
PULSE_S = 0.6            # how long the OK bit stays ON (the collector ignores edges < 0.5 s apart)
ANDON_S = 15             # the demo's one andon call (first andon register, e.g. Maintenance) lasts this long


def collector_settings(saved, port):
    """What the collector uses during the demo: only the connection changes; every signal
    address (OK/NG bits, counters, status, cycle time register) stays as saved."""
    proto = str(saved.get("protocol") or "")
    return {"plc_ip": "127.0.0.1", "plc_port": port,
            "protocol": proto if "BINARY" in proto.upper() else "SLMP 3E (binary)"}


def signal_map(saved):
    """Saved Machine Config addresses -> (device, number); None when blank or invalid."""
    def addr(key, default=None):
        v = str(saved.get(key) or default or "").strip()
        try:
            return parse_address(v) if v else None
        except ValueError:
            return None
    andon = [a for a in (addr(key, default) for key, _, _, default in ANDON) if a]
    status = addr("status_address")
    return {"ok_bit": addr("ok_bit_address", "L108"), "ng_bit": addr("ng_bit_address", "L109"),
            "ok_count": addr("ok_data_register"), "ng_count": addr("ng_data_register"),
            "status": None if status in andon else status,      # an andon register is not a status word
            "ct": addr("ct_register"), "andon": andon,
            "ct_scale": float(saved.get("ct_register_scale") or 0.1)}


def demo_cycle_times(n, ideal):
    """n cycle times around `ideal`: faster, on target and slower ones mixed (rounded to 0.1 s),
    always including ideal x0.9, x1.0 and x1.4 (e.g. 9, 10 and 14 s for a 10 s ideal)."""
    out = []
    for _ in range(n):
        r = random.random()
        if r < 0.30:
            f = random.uniform(0.85, 0.97)       # faster than ideal  -> speed gain
        elif r < 0.65:
            f = random.uniform(0.98, 1.05)       # about on target
        elif r < 0.90:
            f = random.uniform(1.08, 1.30)       # slower             -> speed loss
        else:
            f = random.uniform(1.35, 1.45)       # much slower
        out.append(round(ideal * f, 1))
    for i, f in zip(random.sample(range(n), min(n, 3)), (0.9, 1.0, 1.4)):
        out[i] = round(ideal * f, 1)
    return out


class DemoPlc:
    def __init__(self):
        self.mem = {}
        self.lock = threading.Lock()
        self.sock = None
        self.port = None
        self.stopped = threading.Event()

    # ----- memory -----
    def get(self, dev, n):
        with self.lock:
            return self.mem.get((dev, n), 0)

    def put(self, dev, n, v):
        with self.lock:
            self.mem[(dev, n)] = v

    # ----- SLMP server -----
    def start(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.port = self.sock.getsockname()[1]
        threading.Thread(target=self._accept, name="demo-plc", daemon=True).start()
        return self.port

    def stop(self):
        self.stopped.set()
        try:
            self.sock.close()
        except OSError:
            pass

    def _accept(self):
        while not self.stopped.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    @staticmethod
    def _recv(conn, n):
        buf = b""
        while len(buf) < n:
            chunk = conn.recv(n - len(buf))
            if not chunk:
                raise ConnectionError
            buf += chunk
        return buf

    def _serve(self, conn):
        try:
            while not self.stopped.is_set():
                sub = self._recv(conn, 2)
                four = sub == b"\x54\x00"
                serial = self._recv(conn, 4)[:2] if four else b""
                route = self._recv(conn, 5)
                body = self._recv(conn, struct.unpack("<H", self._recv(conn, 2))[0])
                _timer, cmd, subcmd = struct.unpack_from("<HHH", body, 0)
                n = int.from_bytes(body[6:9], "little")
                dev = CODES.get(body[9])
                pts = struct.unpack_from("<H", body, 10)[0]
                data, end = b"", 0xC059                      # "command not supported"
                if cmd == 0x0401 and dev:
                    if subcmd == 0x0001:                     # bits, two per byte, first in the high nibble
                        bits = [self.get(dev, n + i) for i in range(pts)] + [0]
                        data, end = bytes((bits[i] << 4) | bits[i + 1] for i in range(0, pts, 2)), 0
                    else:                                    # words (bit devices: 16 bits per word)
                        if dev in BIT_DEVS:
                            words = [sum(self.get(dev, n + 16 * k + i) << i for i in range(16)) for k in range(pts)]
                        else:
                            words = [self.get(dev, n + i) & 0xFFFF for i in range(pts)]
                        data, end = struct.pack(f"<{pts}H", *words), 0
                payload = struct.pack("<H", end) + data
                head = (b"\xd4\x00" + serial + b"\x00\x00") if four else b"\xd0\x00"
                conn.sendall(head + route + struct.pack("<H", len(payload)) + payload)
        except (ConnectionError, OSError):
            pass
        finally:
            conn.close()

    # ----- machine -----
    def play(self, cycle_times, ideal, sig, ng_cycles=(), on_cycle=None):
        """Run the cycles in real time on the addresses in `sig` (see signal_map); cycles whose
        number is in `ng_cycles` end with the NG signal. Returns False if stopped early."""
        signals = {a for a in (sig["ok_bit"], sig["ng_bit"], sig["ok_count"], sig["ng_count"],
                               sig["status"], sig["ct"], *sig["andon"]) if a}
        andon_at = len(cycle_times) // 2 if sig["andon"] and len(cycle_times) >= 4 else None

        def extra(dev, n, v):                 # monitor registers / inputs: never over a saved signal
            if (dev, n) not in signals:
                self.put(dev, n, v)

        extra("D", 107, int(round(ideal * 10)))
        extra("D", 111, 1200)
        extra("D", 112, 1500)
        extra("X", 7, 1)                                     # E-stop healthy
        extra("X", 0, 1)                                     # gun in stand
        if sig["status"]:
            self.put(*sig["status"], 1)                      # RUNNING
        t_next = time.monotonic()
        for i, ct in enumerate(cycle_times, 1):
            is_ng = i in ng_cycles
            t_start, t_next = t_next, t_next + ct
            extra("X", 0, 0)
            extra("X", 5, 1)                                 # gun running for most of the cycle
            if self.stopped.wait(max(0.0, t_start + ct * 0.7 - time.monotonic())):
                return False
            extra("X", 5, 0)
            extra("X", 0, 1)
            if self.stopped.wait(max(0.0, t_next - time.monotonic())):
                return False
            extra("D", 106, i)
            extra("D", 104, 1 if i % 2 else 2)
            extra("D", 105, 3 if is_ng else 0)               # NG reason code
            extra("D", 109, random.randint(1150, 1190) if is_ng else random.randint(1300, 1450))
            extra("D", 110, random.randint(1380, 1480))
            extra("D", 118, (self.get("D", 118) + 1) & 0xFFFF)
            extra("X", 4 if is_ng else 3, 1)                 # torque NG / OK
            if sig["ct"]:
                self.put(*sig["ct"], int(round(ct / sig["ct_scale"])) & 0xFFFF)
            counter = sig["ng_count"] if is_ng else sig["ok_count"]
            if counter:
                self.put(*counter, (self.get(*counter) + 1) & 0xFFFF)
            bit = sig["ng_bit"] if is_ng else sig["ok_bit"]
            if bit:
                self.put(*bit, 1)
            if on_cycle:
                on_cycle(i, ct, is_ng)
            if self.stopped.wait(PULSE_S):
                return False
            if bit:
                self.put(*bit, 0)
            extra("X", 3, 0)
            extra("X", 4, 0)
            if i == andon_at:                                # one andon call halfway: loss on the timeline
                self.put(*sig["andon"][0], 1)
                if self.stopped.wait(ANDON_S):
                    return False
                self.put(*sig["andon"][0], 0)
                t_next = time.monotonic()
        if sig["status"]:
            self.put(*sig["status"], 0)                      # IDLE
        return True
