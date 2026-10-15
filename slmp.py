"""Minimal SLMP (MC protocol) client for Mitsubishi FX5U — read only.

Supports the binary 3E and 4E frames over TCP (the FX5U built-in Ethernet
"SLMP" port, binary code).  Only two commands are used:
  0x0401 sub 0x0000  batch read, word units  (D, W, R, SD, ZR ...)
  0x0401 sub 0x0001  batch read, bit units   (X, Y, M, L, B, F, SM)
Nothing is ever written to the PLC.

Device numbers: X and Y are octal on the FX5 (X10 = 8th input), B and W are
hexadecimal, everything else is decimal.
"""
import re
import socket
import struct

# Binary device codes (MELSEC-Q/L compatible 1-byte codes, accepted by the FX5U).
DEVICE_CODES = {
    "X": 0x9C, "Y": 0x9D, "M": 0x90, "L": 0x92, "F": 0x93, "B": 0xA0, "SM": 0x91,
    "D": 0xA8, "W": 0xB4, "R": 0xAF, "SD": 0xA9, "ZR": 0xB0,
}
BIT_DEVICES = {"X", "Y", "M", "L", "F", "B", "SM"}
WORD_DEVICES = {"D", "W", "R", "SD", "ZR"}
_ADDR_RE = re.compile(r"^(SM|SD|ZR|X|Y|M|L|B|F|D|W|R)([0-9A-F]+)$")


class SlmpError(Exception):
    pass


def parse_address(addr):
    """'D100' -> ('D', 100); 'X10' -> ('X', 8) (octal); 'W1A' -> ('W', 26) (hex)."""
    m = _ADDR_RE.match(str(addr or "").strip().upper())
    if not m:
        raise ValueError(f"bad device address {addr!r}")
    dev, num = m.groups()
    if dev in ("X", "Y"):
        n = int(num, 8)
    elif dev in ("B", "W"):
        n = int(num, 16)
    else:
        n = int(num, 10)
    return dev, n


def format_address(dev, n):
    if dev in ("X", "Y"):
        return f"{dev}{n:o}"
    if dev in ("B", "W"):
        return f"{dev}{n:X}"
    return f"{dev}{n}"


class SlmpClient:
    def __init__(self, host, port=5000, frame="3E", timeout=3.0):
        self.host, self.port, self.timeout = host, int(port), timeout
        self.frame = "4E" if str(frame).upper() == "4E" else "3E"
        self.sock = None
        self._serial = 0

    def connect(self):
        self.close()
        s = socket.create_connection((self.host, self.port), timeout=self.timeout)
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        s.settimeout(self.timeout)
        self.sock = s

    def close(self):
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("PLC closed the connection")
            buf += chunk
        return buf

    def _request(self, command, subcommand, payload):
        if self.sock is None:
            self.connect()
        # monitoring timer (x250 ms) + command + subcommand + request data
        body = struct.pack("<HHH", 4, command, subcommand) + payload
        route = struct.pack("<BBHB", 0x00, 0xFF, 0x03FF, 0x00)   # network, PC, module I/O, station
        if self.frame == "4E":
            self._serial = (self._serial + 1) & 0xFFFF
            head = struct.pack("<HHH", 0x0054, self._serial, 0)
        else:
            head = struct.pack("<H", 0x0050)
        self.sock.sendall(head + route + struct.pack("<H", len(body)) + body)

        hdr_len = 13 if self.frame == "4E" else 9
        hdr = self._recv_exact(hdr_len)
        sub = struct.unpack_from("<H", hdr, 0)[0]
        if sub != (0x00D4 if self.frame == "4E" else 0x00D0):
            raise SlmpError(f"unexpected response header 0x{sub:04X} (check the PLC's SLMP frame type)")
        if self.frame == "4E" and struct.unpack_from("<H", hdr, 2)[0] != self._serial:
            raise SlmpError("response serial number mismatch")
        length = struct.unpack_from("<H", hdr, hdr_len - 2)[0]
        data = self._recv_exact(length)
        end_code = struct.unpack_from("<H", data, 0)[0]
        if end_code != 0:
            raise SlmpError(f"PLC end code 0x{end_code:04X}")
        return data[2:]

    @staticmethod
    def _device_payload(dev, n, points):
        return struct.pack("<I", n)[:3] + bytes([DEVICE_CODES[dev]]) + struct.pack("<H", points)

    def read_words(self, dev, n, points):
        """Batch read `points` 16-bit words starting at device dev/n."""
        data = self._request(0x0401, 0x0000, self._device_payload(dev, n, points))
        if len(data) < points * 2:
            raise SlmpError("short word response")
        return list(struct.unpack_from(f"<{points}H", data, 0))

    def read_bits(self, dev, n, points):
        """Batch read `points` bits (0/1) starting at bit device dev/n."""
        data = self._request(0x0401, 0x0001, self._device_payload(dev, n, points))
        out = []
        for i in range(points):
            b = data[i // 2]
            out.append((b >> 4) & 1 if i % 2 == 0 else b & 1)
        return out


def to_signed(v):
    return v - 0x10000 if v & 0x8000 else v
