import ctypes
from pathlib import Path

import numpy as np
import pytest
import pyxtf
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "client" / "src" / "images_sonar"
WRECK_STRIP = SAMPLES / "EB_Allen_06.png"                                      # AI4Shipwrecks strip (1728 x 1929)
SMALL_IMAGE = SAMPLES / "000023_jpg.rf.cd067115ac89eb3aede0164bae2c2f17.jpg"   # 640 x 640 web sonar image


@pytest.fixture(scope="session")
def client():
    from app.main import app

    with TestClient(app) as c:
        yield c


def make_xtf(n_pings: int = 400, samples: int = 512, slant_range: float = 50.0, lat0: float = 13.08,
             lon0: float = 80.38, step_m: float = 0.1, latlon: bool = True) -> bytes:
    """Synthetic 2-channel side-scan XTF: speckled seabed with one bright object and its acoustic shadow
    on the starboard side, vehicle heading due north."""
    rng = np.random.default_rng(0)
    fh = pyxtf.XTFFileHeader()
    fh.NavUnits = 3 if latlon else 0
    fh.NumberOfSonarChannels = 2
    fh.SonarName = b"SynthSSS"
    for i, t in enumerate((1, 2)):  # port, starboard
        fh.ChanInfo[i].TypeOfChannel = t
        fh.ChanInfo[i].BytesPerSample = 2
        fh.ChanInfo[i].SubChannelNumber = i
    out = bytearray(bytes(fh))
    deg_per_m = 1 / 111_320
    for k in range(n_pings):
        p = pyxtf.XTFPingHeader()
        p.Year, p.Month, p.Day, p.Hour = 2026, 9, 29, 10
        p.Minute, p.Second, p.HSeconds = (k // 10) // 60, (k // 10) % 60, (k % 10) * 10
        p.PingNumber = k
        p.SensorYcoordinate = lat0 + k * step_m * deg_per_m if latlon else 0.0
        p.SensorXcoordinate = lon0 if latlon else 0.0
        p.SensorHeading = 0.0
        p.SensorPrimaryAltitude = 5.0
        p.NumChansToFollow = 2
        p.ping_chan_headers, p.data = [], []
        for c in range(2):
            pc = pyxtf.XTFPingChanHeader()
            pc.ChannelNumber, pc.NumSamples, pc.SlantRange, pc.Frequency = c, samples, slant_range, 450
            seabed = rng.gamma(4, 250, samples)
            if c == 1 and 180 <= k < 240:                 # object 200-260 samples out on starboard
                seabed[200:260] = 9000
                seabed[260:330] = 30                       # acoustic shadow behind it
            if c == 0:
                seabed[-40:] = 5                           # port water column near nadir
            else:
                seabed[:40] = 5                            # starboard water column near nadir
            p.ping_chan_headers.append(pc)
            p.data.append(np.clip(seabed, 0, 65535).astype(np.uint16))
        p.NumBytesThisRecord = (ctypes.sizeof(pyxtf.XTFPingHeader) + 2 * ctypes.sizeof(pyxtf.XTFPingChanHeader)
                                + 2 * samples * 2)
        out += p.to_bytes()
    return bytes(out)
