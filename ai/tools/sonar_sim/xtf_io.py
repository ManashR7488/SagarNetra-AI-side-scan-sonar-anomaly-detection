"""XTF writer: file header, notes, per-ping attitude (MRU), 1 Hz raw GPS and sonar ping packets.

Field conventions follow what common acquisition software writes:
  * NavUnits = 3 (latitude / longitude), Sensor* coordinates = towfish (after layback), Ship* = GPS antenna
  * SoundVelocity = half the sound speed (one-way convention, e.g. 750 for 1500 m/s); ComputedSoundVelocity = full value
  * SensorSpeed / ShipSpeed / SpeedLog in knots, SensorDepth = towfish depth below the surface,
    SensorPrimaryAltitude = height above the seabed (water depth = SensorDepth + SensorPrimaryAltitude)
  * port samples are stored far -> near, starboard near -> far
"""

import ctypes

import numpy as np
import pyxtf

KNOT = 0.514444


def _chars(dst, text: str):
    """Write ASCII text into a ctypes char/ubyte array field."""
    data = text.encode("ascii", "ignore")[: len(dst)]
    for i, b in enumerate(data):
        dst[i] = b


def write_xtf(path, prof, line, nav, rec_latlon, rec_ship_latlon, channels_data, area, gain_codes):
    """channels_data: list of (Channel, port_near_far uint16 [P, n], stbd_near_far uint16 [P, n])."""
    P = nav["P"]
    fh = pyxtf.XTFFileHeader()
    fh.SystemType = 1
    fh.RecordingProgramName = b"SonarSim"
    fh.RecordingProgramVersion = b"2.0"
    fh.SonarName = prof.name.encode()[:16]
    fh.SonarType = 0
    fh.NoteString = f"SYNTHETIC DATA - SonarScan simulator - {area['name']}".encode()[:63]
    fh.ThisFileName = f"{line.id}.xtf".encode()[:63]
    fh.NavUnits = 3
    fh.NumberOfSonarChannels = 2 * len(channels_data)
    fh.NavigationLatency = 20
    fh.NavOffsetY, fh.NavOffsetX, fh.NavOffsetZ = 0.0, 1.2, -2.5      # GPS antenna offsets
    fh.MRUOffsetY, fh.MRUOffsetX, fh.MRUOffsetZ = 0.3, 0.0, 0.1
    _chars(fh.ProjectionType, "LATLON")
    _chars(fh.SpheriodType, "WGS84")
    for k, (ch, _, _) in enumerate(channels_data):
        for j, (ctype, name) in enumerate(((1, "Port"), (2, "Starboard"))):
            ci = fh.ChanInfo[2 * k + j]
            ci.TypeOfChannel = ctype
            ci.SubChannelNumber = 2 * k + j
            ci.CorrectionFlags = 1                    # slant-range data
            ci.UniPolar = 1
            ci.BytesPerSample = 2
            ci.SampleFormat = 3                       # uint16
            ci.ChannelName = f"{name} {ch.freq_khz}kHz".encode()[:16]
            ci.VoltScale = 5.0
            ci.Frequency = float(ch.freq_khz)
            ci.HorizBeamAngle = float(ch.beam_h_deg)
            ci.TiltAngle = float(ch.tilt_deg)
            ci.BeamWidth = float(ch.beam_v_deg)
            ci.OffsetY = 0.35 * (1 if ctype == 2 else -1)
            ci.BeamsPerArray = 1

    lat, lon = rec_latlon
    slat, slon = rec_ship_latlon
    t0 = nav["times"][0]
    rate = nav["rate"]
    chan_hdr = ctypes.sizeof(pyxtf.XTFPingChanHeader)
    record = ctypes.sizeof(pyxtf.XTFPingHeader) + sum(2 * (chan_hdr + 2 * ch.samples) for ch, _, _ in channels_data)
    kp0 = area.get("kp_offset_km", 0.0)

    with open(path, "wb") as f:
        f.write(bytes(fh))
        note = pyxtf.XTFNotesHeader()
        note.NumBytesThisRecord = ctypes.sizeof(note)
        note.Year, note.Month, note.Day = t0.year, t0.month, t0.day
        note.Hour, note.Minute, note.Second = t0.hour, t0.minute, t0.second
        note.NotesText = (f"LINE {line.id} | {area['name']} | course {line.course_deg:.0f} deg | "
                          f"{prof.description} | SYNTHETIC").encode()[:199]
        f.write(bytes(note))

        last_fix = -1
        for i in range(P):
            t = nav["times"][i]
            ms = t.microsecond // 1000
            # MRU attitude packet for every ping
            a = pyxtf.XTFAttitudeData()
            a.NumBytesThisRecord = ctypes.sizeof(a)
            a.Pitch, a.Roll = float(nav["pitch"][i]), float(nav["roll"][i])
            a.Heave, a.Heading = float(nav["heave"][i]), float(nav["heading"][i])
            a.Yaw = float(nav["heading"][i])
            a.TimeTag = int(nav["t"][i] * 1000)
            a.Year, a.Month, a.Day, a.Hour, a.Minute, a.Second = t.year, t.month, t.day, t.hour, t.minute, t.second
            a.Millisecond = ms
            f.write(bytes(a))
            # raw GPS fix once per second
            fix_second = int(nav["t"][i])
            if fix_second != last_fix:
                last_fix = fix_second
                g = pyxtf.XTFPosRawNavigation()
                g.NumBytesThisRecord = ctypes.sizeof(g)
                g.Year, g.Month, g.Day, g.Hour, g.Minute, g.Second = t.year, t.month, t.day, t.hour, t.minute, t.second
                g.Microsecond = ms * 10
                g.RawYcoordinate, g.RawXcoordinate = float(slat[i]), float(slon[i])
                g.RawAltitude = 2.5
                g.Heading = float(nav["ship_heading"][i])
                f.write(bytes(g))

            p = pyxtf.XTFPingHeader()
            p.Year, p.Month, p.Day = t.year, t.month, t.day
            p.Hour, p.Minute, p.Second, p.HSeconds = t.hour, t.minute, t.second, t.microsecond // 10000
            p.JulianDay = t.timetuple().tm_yday
            p.EventNumber = 1 + int(nav["t"][i] // 60)
            p.PingNumber = 100000 + i
            c = float(nav["sound_speed"][i])
            p.SoundVelocity = c / 2
            p.ComputedSoundVelocity = c
            p.OceanTide = float(nav["tide"][i])
            p.WaterTemperature = float(nav["temp"][i])
            p.Conductivity = float(42.914 * nav["salinity"][i] / 35 * (1 + 0.0212 * (nav["temp"][i] - 15)))
            p.Pressure = float(nav["fish_depth"][i] * 1.02)            # dbar
            p.SpeedLog = float(nav["speed"][i] / KNOT)
            p.ShipSpeed = float(nav["speed"][i] / KNOT)
            p.ShipGyro = float(nav["ship_heading"][i])
            p.ShipYcoordinate, p.ShipXcoordinate = float(slat[i]), float(slon[i])
            p.FixTimeHour, p.FixTimeMinute, p.FixTimeSecond = t.hour, t.minute, t.second
            p.NavFixMilliseconds = ms
            p.SensorSpeed = float(nav["speed"][i] / KNOT)
            p.KP = float(kp0 + nav["s"][i] / 1000)
            p.SensorYcoordinate, p.SensorXcoordinate = float(lat[i]), float(lon[i])
            if prof.platform == "towed":
                p.RangeToFish = int(round(np.hypot(nav["layback"][i], nav["fish_depth"][i])))
                p.BearingToFish = int(round((nav["ship_heading"][i] + 180) % 360))
                p.CableOut = int(nav["cable"][i])
                p.CableOutHundredths = int(round((nav["cable"][i] % 1) * 100))
                p.Layback = float(nav["layback"][i])
                p.CableTension = float(180 + 4 * nav["cable"][i])
            p.SensorDepth = float(nav["fish_depth"][i])
            p.SensorPrimaryAltitude = float(nav["altitude"][i] + np.random.default_rng(i).normal(0, 0.03))
            p.SensorPitch, p.SensorRoll = float(nav["pitch"][i]), float(nav["roll"][i])
            p.SensorHeading = float(nav["heading"][i])
            p.Heave = float(nav["heave"][i])
            p.Yaw = float(nav["heading"][i])
            p.AttitudeTimeTag = int(nav["t"][i] * 1000)
            p.ComputerClockHour, p.ComputerClockMinute, p.ComputerClockSecond = t.hour, t.minute, t.second
            p.ComputerClockHsec = t.microsecond // 10000
            p.NumChansToFollow = 2 * len(channels_data)
            p.NumBytesThisRecord = record
            p.ping_chan_headers, p.data = [], []
            for k, (ch, port, stbd) in enumerate(channels_data):
                for j, samples in enumerate((port[i, ::-1], stbd[i])):
                    pc = pyxtf.XTFPingChanHeader()
                    pc.ChannelNumber = 2 * k + j
                    pc.NumSamples = ch.samples
                    pc.SlantRange = float(ch.range_m)
                    pc.GroundRange = float(np.sqrt(max(ch.range_m ** 2 - nav["altitude"][i] ** 2, 0)))
                    pc.TimeDelay = 0.0
                    pc.TimeDuration = float(2 * ch.range_m / c)
                    pc.SecondsPerPing = float(1 / rate)
                    pc.Frequency = int(ch.freq_khz)
                    pc.InitialGainCode = int(gain_codes[0])
                    pc.GainCode = int(gain_codes[i])
                    pc.BandWidth = int(ch.bandwidth_khz)
                    pc.Weight = 0
                    p.ping_chan_headers.append(pc)
                    p.data.append(np.ascontiguousarray(samples, dtype=np.uint16))
            f.write(p.to_bytes())
