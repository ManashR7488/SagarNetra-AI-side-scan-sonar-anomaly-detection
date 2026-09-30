"""Survey campaign: seven areas off the Indian coast, their seabed, objects and lawnmower survey lines."""

from datetime import datetime, timedelta, timezone

import numpy as np

from .sonar import PROFILES, LineSpec
from .world import Prim, SeabedSpec, WorldObject

# detector classes (keep in sync with the AI service)
CLASSES = ["shipwreck", "aircraft_wreck", "mine_like_object", "debris", "human_body", "marine_life"]


# ------------------------------------------------------------------ object builders

class Builder:
    def __init__(self, code, rng):
        self.code, self.rng, self.objects, self.k = code, rng, [], 0

    def _id(self):
        self.k += 1
        return f"{self.code}-OBJ-{self.k:03d}"

    def add(self, kind, label, e, n, L, W, H, az, prims, notes="", **kw):
        o = WorldObject(self._id(), kind, label, float(e), float(n), float(L), float(W), float(H), float(az % 360),
                        prims, notes, **kw)
        self.objects.append(o)
        return o

    def seed(self):
        return int(self.rng.integers(0, 1_000_000))

    # --- wrecks -----------------------------------------------------------
    def shipwreck(self, e, n, length=None, broken=False, kind="shipwreck"):
        r = self.rng
        L = length or r.uniform(25, 70)
        W, H = L * r.uniform(0.14, 0.19), min(0.09 * L + 1.2, 7.0) * r.uniform(0.8, 1.1)
        az = r.uniform(0, 360)
        d = np.array([np.sin(np.radians(az)), np.cos(np.radians(az))])
        prims = []
        if broken:
            gap = r.uniform(4, 12)
            prims.append(Prim("hull", *(np.array([e, n]) + d * 0.25 * L), 0.55 * L, W, H, az, 2.2, self.seed()))
            prims.append(Prim("hull", *(np.array([e, n]) - d * (0.25 * L + gap)), 0.4 * L, W * 0.95, H * 0.8,
                              az + r.uniform(15, 45), 2.2, self.seed()))
        else:
            prims.append(Prim("hull", e, n, L, W, H, az, 2.2, self.seed()))
            hc = np.array([e, n]) - d * 0.12 * L
            prims.append(Prim("box", *hc, 0.18 * L, 0.6 * W, H * 1.45, az, 2.4, self.seed()))
        o = self.add(kind, "shipwreck", e, n, L, W, H, az, prims, "broken in two" if broken else "intact hull")
        for _ in range(int(r.integers(3, 8))):     # scattered wreck debris as separate targets
            rad, ang = r.uniform(0.6, 1.3) * L, r.uniform(0, 2 * np.pi)
            self.debris(e + rad * np.sin(ang), n + rad * np.cos(ang), size=(0.8, 3.0), kind="wreck_debris")
        return o

    def boat_wreck(self, e, n):
        r = self.rng
        L = r.uniform(8, 16)
        az = r.uniform(0, 360)
        W, H = L * 0.3, r.uniform(1.2, 2.2)
        return self.add("boat_wreck", "shipwreck", e, n, L, W, H, az,
                        [Prim("hull", e, n, L, W, H, az, 1.9, self.seed())], "small fishing / supply boat")

    def aircraft(self, e, n):
        r = self.rng
        az = r.uniform(0, 360)
        fl, span = r.uniform(11, 17), r.uniform(14, 24)
        d = np.array([np.sin(np.radians(az)), np.cos(np.radians(az))])
        wing_c = np.array([e, n]) + d * 0.1 * fl
        tail_c = np.array([e, n]) - d * 0.45 * fl
        prims = [Prim("capsule", e, n, fl, 1.9, 1.9, az, 2.6, self.seed()),
                 Prim("box", *wing_c, 2.6, span * (0.55 if r.random() < 0.4 else 1.0), 0.55, az, 2.8, self.seed()),
                 Prim("box", *tail_c, 1.3, 5.5, 0.4, az, 2.6, self.seed()),
                 Prim("box", *tail_c, 1.6, 0.3, 2.3, az, 2.6, self.seed())]
        return self.add("aircraft", "aircraft_wreck", e, n, fl, span, 2.3, az, prims, "WWII-era aircraft wreck")

    # --- mine-like / pipes ------------------------------------------------
    def mine_cylinder(self, e, n):
        r = self.rng
        L, D, az = r.uniform(1.6, 2.8), r.uniform(0.5, 0.8), r.uniform(0, 360)
        return self.add("mine_cylinder", "mine_like_object", e, n, L, D, D, az,
                        [Prim("capsule", e, n, L, D, D, az, 3.0, self.seed())], "cylindrical mine-like object")

    def manta_mine(self, e, n):
        R, H = self.rng.uniform(0.45, 0.6), self.rng.uniform(0.35, 0.5)
        return self.add("manta_mine", "mine_like_object", e, n, 2 * R, 2 * R, H, 0,
                        [Prim("cone", e, n, R, R, H, 0, 2.8, self.seed())], "truncated-cone bottom mine")

    def ordnance(self, e, n):
        r = self.rng
        L, D, az = r.uniform(1.0, 1.9), r.uniform(0.3, 0.5), r.uniform(0, 360)
        return self.add("ordnance", "mine_like_object", e, n, L, D, D, az,
                        [Prim("capsule", e, n, L, D, D, az, 2.7, self.seed())], "unexploded ordnance (bomb / shell)")

    def pipeline(self, pts, width=None, height=None, burial=0.4, kind="pipeline"):
        r = self.rng
        w = width or r.uniform(0.5, 1.0)
        h = height or w * r.uniform(0.8, 1.0)
        p = np.asarray(pts)
        c = p.mean(0)
        length = float(np.sum(np.hypot(*np.diff(p, axis=0).T)))
        az = np.degrees(np.arctan2(*(p[-1] - p[0])))
        return self.add(kind, "mine_like_object", c[0], c[1], length, w, h, az,
                        [Prim("tube", c[0], c[1], length, w, h, az, 2.3 if kind == "pipeline" else 1.8, self.seed(),
                              [tuple(x) for x in pts], burial)],
                        f"{kind}, ~{burial:.0%} buried")

    # --- debris -----------------------------------------------------------
    def container(self, e, n):
        r = self.rng
        L = 6.06 if r.random() < 0.7 else 12.19
        on_side = r.random() < 0.3
        W, H = (2.59, 2.44) if on_side else (2.44, 2.59)
        az = r.uniform(0, 360)
        return self.add("container", "debris", e, n, L, W, H, az, [Prim("box", e, n, L, W, H, az, 2.6, self.seed())],
                        "lost shipping container" + (" (on its side)" if on_side else ""))

    def tyre(self, e, n):
        return self.add("tyre", "debris", e, n, 0.7, 0.7, 0.22, 0, [Prim("ring", e, n, 0.35, 0.17, 0.22, 0, 1.3, self.seed())],
                        "single tyre")

    def tyre_cluster(self, e, n):
        r = self.rng
        prims = []
        for _ in range(int(r.integers(6, 18))):
            rad, ang = r.uniform(0, 4.5), r.uniform(0, 2 * np.pi)
            prims.append(Prim("ring", e + rad * np.sin(ang), n + rad * np.cos(ang), 0.36, 0.18,
                              r.uniform(0.22, 0.45), 0, 1.3, self.seed()))
        return self.add("tyre_cluster", "debris", e, n, 10, 10, 0.45, 0, prims, f"{len(prims)} dumped tyres")

    def crab_pot_string(self, e, n):
        r = self.rng
        az = r.uniform(0, 360)
        d = np.array([np.sin(np.radians(az)), np.cos(np.radians(az))])
        count, gap = int(r.integers(6, 11)), r.uniform(10, 16)
        string = f"string of {count} derelict crab pots"
        for k in range(count):
            c = np.array([e, n]) + d * (k - count / 2) * gap + r.normal(0, 0.8, 2)
            paz = r.uniform(0, 360)
            self.add("crab_pot", "debris", c[0], c[1], 0.9, 0.6, 0.45, paz,
                     [Prim("box", c[0], c[1], 0.9, 0.6, 0.45, paz, 2.4, self.seed())], string)

    def ghost_net(self, e, n, draped_on_rock=False):
        r = self.rng
        L, W, az = r.uniform(4, 14), r.uniform(2, 6), r.uniform(0, 360)
        prims = [Prim("patch", e, n, L, W, r.uniform(0.15, 0.35), az, 1.0, self.seed())]
        if draped_on_rock:
            prims.append(Prim("rock", e, n, L * 0.6, W * 0.8, r.uniform(0.8, 1.8), az, 1.3, self.seed()))
        return self.add("ghost_net", "debris", e, n, L, W, 0.3, az, prims,
                        "derelict fishing net" + (" draped over rock" if draped_on_rock else ""))

    def anchor_chain(self, e, n):
        r = self.rng
        az = r.uniform(0, 360)
        prims = [Prim("box", e, n, 2.2, 0.35, 0.35, az, 2.8, self.seed()),
                 Prim("box", e, n, 0.35, 1.6, 0.35, az, 2.8, self.seed())]
        pts, p, heading = [(e, n)], np.array([e, n]), np.radians(az)
        for _ in range(int(r.integers(5, 9))):
            heading += r.normal(0, 0.5)
            p = p + r.uniform(4, 9) * np.array([np.sin(heading), np.cos(heading)])
            pts.append(tuple(p))
        prims.append(Prim("tube", e, n, 0, 0.25, 0.2, az, 1.5, self.seed(), pts, 0.2))
        return self.add("anchor_chain", "debris", e, n, 2.2, 1.6, 0.35, az, prims, "anchor with chain")

    def debris(self, e, n, size=(0.5, 2.5), kind="debris"):
        r = self.rng
        L, W, H = r.uniform(*size), r.uniform(0.3, 1.2), r.uniform(0.2, 0.9)
        az = r.uniform(0, 360)
        shape = r.choice(["box", "capsule"])
        return self.add(kind, "debris", e, n, L, W, H, az, [Prim(shape, e, n, L, W, H, az, r.uniform(1.8, 2.8), self.seed())],
                        "man-made debris")

    def concrete_blocks(self, e, n):
        r = self.rng
        prims = []
        for _ in range(int(r.integers(4, 10))):
            s, rad, ang = r.uniform(1.4, 2.0), r.uniform(0, 7), r.uniform(0, 2 * np.pi)
            prims.append(Prim("box", e + rad * np.sin(ang), n + rad * np.cos(ang), s, s, s * 0.9, r.uniform(0, 90), 1.7, self.seed()))
        return self.add("concrete_blocks", "debris", e, n, 15, 15, 2.0, 0, prims, "artificial reef concrete modules")

    # --- search & rescue / biology / natural -------------------------------
    def human_body(self, e, n):
        az = self.rng.uniform(0, 360)
        return self.add("human_body", "human_body", e, n, 1.75, 0.45, 0.28, az,
                        [Prim("ellipsoid", e, n, 1.75, 0.45, 0.28, az, 1.1, self.seed())], "drowning victim (SAR target)")

    def fish_school(self, e, n, depth):
        r = self.rng
        return self.add("fish_school", "marine_life", e, n, r.uniform(8, 25), r.uniform(4, 12), 0, 0, [],
                        "fish school in the water column", school_z=float(r.uniform(2, max(3, depth * 0.6))))

    def rock_outcrop(self, e, n):
        r = self.rng
        L, W, H, az = r.uniform(4, 12), r.uniform(3, 8), r.uniform(1, 3), r.uniform(0, 360)
        return self.add("rock_outcrop", None, e, n, L, W, H, az, [Prim("rock", e, n, L, W, H, az, 1.3, self.seed())],
                        "natural rock outcrop (false-positive bait)")

    def boulder(self, e, n):
        r = self.rng
        L, H, az = r.uniform(0.8, 3), r.uniform(0.5, 2), r.uniform(0, 360)
        return self.add("boulder", None, e, n, L, L * r.uniform(0.6, 1), H, az,
                        [Prim("rock", e, n, L, L * 0.8, H, az, 1.25, self.seed())], "natural boulder")


# ------------------------------------------------------------------ areas

def _area(code, name, lat0, lon0, date, profile, course, n_lines, line_len, seabed, populate, conditions=None):
    return dict(code=code, name=name, lat0=lat0, lon0=lon0, date=date, profile=profile, course=course,
                n_lines=n_lines, line_len=line_len, seabed=seabed, populate=populate, conditions=conditions or {})


def _pop_chennai(b, box, depth):
    u = box.uniform
    b.shipwreck(*u(0.3, 0.5), length=62)
    b.shipwreck(*u(0.7, 0.8), length=34, broken=True)
    for _ in range(4): b.container(*u())
    for _ in range(2): b.tyre_cluster(*u())
    for _ in range(4): b.debris(*u())
    b.anchor_chain(*u())
    b.human_body(*u())
    for _ in range(3): b.fish_school(*u(), depth)
    for _ in range(4): b.boulder(*u())


def _pop_vizag(b, box, depth):
    u = box.uniform
    for _ in range(8): b.mine_cylinder(*u())
    for _ in range(4): b.manta_mine(*u())
    for _ in range(2): b.ordnance(*u())
    b.pipeline([box.at(-0.1, 0.35), box.at(0.5, 0.45), box.at(1.1, 0.4)], burial=0.35)
    b.shipwreck(*u(0.5, 0.6), length=72)
    for _ in range(4): b.debris(*u())
    for _ in range(6): b.boulder(*u())


def _pop_kochi(b, box, depth):
    u = box.uniform
    for _ in range(4): b.ghost_net(*u())
    for _ in range(2): b.ghost_net(*u(), draped_on_rock=True)
    for _ in range(3): b.crab_pot_string(*u(0.25, 0.75))
    for _ in range(3): b.tyre(*u())
    for _ in range(4): b.debris(*u())
    for _ in range(6): b.fish_school(*u(), depth)
    b.boat_wreck(*u())
    for _ in range(2): b.rock_outcrop(*u())


def _pop_mumbai(b, box, depth):
    u = box.uniform
    b.pipeline([box.at(0.2, -0.1), box.at(0.3, 0.5), box.at(0.25, 1.1)], burial=0.5)
    b.pipeline([box.at(-0.1, 0.7), box.at(1.1, 0.6)], burial=0.25)
    b.pipeline([box.at(0.8, -0.1), box.at(0.7, 1.1)], width=0.15, height=0.12, burial=0.5, kind="cable")
    for _ in range(3): b.container(*u())
    for _ in range(2): b.anchor_chain(*u())
    for _ in range(5): b.debris(*u())
    b.shipwreck(*u(0.4, 0.6), length=26)
    for _ in range(3): b.boulder(*u())


def _pop_andaman(b, box, depth):
    u = box.uniform
    b.aircraft(*u(0.3, 0.5))
    b.shipwreck(*u(0.6, 0.8), length=40)
    for _ in range(3): b.ordnance(*u())
    for _ in range(4): b.debris(*u())
    b.concrete_blocks(*u())
    for _ in range(4): b.fish_school(*u(), depth)
    for _ in range(5): b.rock_outcrop(*u())


def _pop_goa(b, box, depth):
    u = box.uniform
    for _ in range(4): b.human_body(*u())
    for _ in range(3): b.tyre(*u())
    b.tyre_cluster(*u())
    b.crab_pot_string(*u(0.3, 0.7))
    b.boat_wreck(*u())
    for _ in range(5): b.debris(*u())
    for _ in range(3): b.fish_school(*u(), depth)


def _pop_mannar(b, box, depth):
    u = box.uniform
    for _ in range(10): b.rock_outcrop(*u())
    for _ in range(14): b.boulder(*u())
    for _ in range(5): b.fish_school(*u(), depth)


def areas():
    ist = timezone.utc
    return [
        _area("CHN", "Chennai Port approaches", 13.1000, 80.3350, datetime(2026, 10, 3, 1, 30, tzinfo=ist),
              "TOW-DF400/900", 20, 8, 330,
              SeabedSpec(18, (0.004, 0.0), mud=0.35, gravel=0.08, rock=0.02, ripple_amp=0.05, sandwave_amp=0.35,
                         sandwave_len=35, trawl_marks=2, tide_amp=0.55, temp_c=28.5, salinity=33.8), _pop_chennai),
        _area("VIZ", "Visakhapatnam exercise area", 17.6400, 83.3300, datetime(2026, 10, 6, 2, 0, tzinfo=ist),
              "TOW-DF100/500", 135, 8, 420,
              SeabedSpec(42, (0.0, -0.01), mud=0.1, gravel=0.25, rock=0.03, ripple_amp=0.03, sandwave_amp=0.8,
                         sandwave_len=60, tide_amp=0.7, temp_c=27.5, salinity=33.5), _pop_vizag),
        _area("KOC", "Kochi fishing grounds", 9.9300, 76.1400, datetime(2026, 10, 9, 3, 0, tzinfo=ist),
              "TOW-600", 75, 8, 300,
              SeabedSpec(16, (-0.006, 0.0), mud=0.75, gravel=0.03, rock=0.01, ripple_amp=0.02, trawl_marks=6,
                         pockmarks=8, tide_amp=0.4, temp_c=29.0, salinity=34.0), _pop_kochi),
        _area("MUM", "Mumbai High pipeline corridor", 19.4000, 71.3300, datetime(2026, 10, 12, 1, 0, tzinfo=ist),
              "TOW-DF100/500", 50, 8, 440,
              SeabedSpec(68, (0.0, 0.006), mud=0.2, gravel=0.1, rock=0.0, ripple_amp=0.04, sandwave_amp=1.2,
                         sandwave_len=45, tide_amp=1.4, temp_c=27.0, salinity=35.5), _pop_mumbai,
              {"kp_offset_km": 12.4}),
        _area("AND", "Andaman - Ross Island approaches", 11.6750, 92.7750, datetime(2026, 10, 15, 0, 30, tzinfo=ist),
              "AUV-900", 160, 8, 280,
              SeabedSpec(28, (0.01, 0.0), mud=0.05, gravel=0.2, rock=0.08, rock_height=2.0, reef=0.25, ripple_amp=0.05,
                         tide_amp=0.8, temp_c=29.5, salinity=33.0), _pop_andaman),
        _area("GOA", "Mormugao harbour & beach (SAR)", 15.4150, 73.7900, datetime(2026, 10, 18, 4, 0, tzinfo=ist),
              "HULL-455", 105, 8, 220,
              SeabedSpec(8, (0.01, 0.0), mud=0.35, gravel=0.05, rock=0.0, ripple_amp=0.06, ripple_len=1.1,
                         tide_amp=0.9, temp_c=29.0, salinity=34.5), _pop_goa, {"surface_return": True}),
        _area("MAN", "Gulf of Mannar rocky reef (natural only)", 9.2000, 79.1500, datetime(2026, 10, 21, 2, 30, tzinfo=ist),
              "TOW-600", 30, 8, 300,
              SeabedSpec(14, (0.0, 0.004), mud=0.1, gravel=0.2, rock=0.2, rock_height=2.2, reef=0.1, ripple_amp=0.07,
                         sandwave_amp=0.5, sandwave_len=30, tide_amp=0.5, temp_c=29.5, salinity=35.0), _pop_mannar),
    ]


class SurveyBox:
    """Rectangle covered by the survey lines (course-aligned) used to place objects."""

    def __init__(self, course_deg, width, length, rng):
        self.fwd = np.array([np.sin(np.radians(course_deg)), np.cos(np.radians(course_deg))])
        self.right = np.array([np.cos(np.radians(course_deg)), -np.sin(np.radians(course_deg))])
        self.width, self.length, self.rng = width, length, rng

    def at(self, across_frac, along_frac):
        p = (across_frac - 0.5) * self.width * self.right + along_frac * self.length * self.fwd
        return float(p[0]), float(p[1])

    def uniform(self, lo=0.08, hi=0.92):
        return self.at(self.rng.uniform(0.05, 0.95), self.rng.uniform(lo, hi))


def build_area(area):
    """Deterministic world + survey lines for an area."""
    rng = np.random.default_rng(sum(map(ord, area["code"])) * 7919)   # stable per area
    prof = PROFILES[area["profile"]]
    R = prof.channels[0].range_m
    spacing = 1.25 * R                         # > 100 % coverage with overlap between adjacent lines
    width = spacing * (area["n_lines"] - 1)
    box = SurveyBox(area["course"], width, area["line_len"], rng)
    b = Builder(area["code"], rng)
    area["populate"](b, box, area["seabed"].depth_m)

    lines = []
    t = area["date"]
    for j in range(area["n_lines"]):
        across = (j / max(area["n_lines"] - 1, 1) - 0.5) * width
        start = across * box.right - 20 * box.fwd
        course = area["course"]
        if j % 2 == 1:                          # lawnmower: every other line reversed
            start = start + (area["line_len"] + 40) * box.fwd
            course = (course + 180) % 360
        cond = dict(area["conditions"])
        cond.update({
            "sea_state": int(rng.integers(1, 5)),
            "dropouts": int(rng.integers(0, 6)),
            "tvg_mismatch": float(rng.uniform(-0.15, 0.15)),
            "calibration": float(rng.uniform(7000, 11000)),
        })
        if rng.random() < 0.2:
            cond["gain_change"] = (float(rng.uniform(0.3, 0.7)), float(rng.choice([0.7, 1.4])))
        if rng.random() < 0.15:
            cond["interference"] = int(rng.integers(40, 120))
        if prof.platform == "towed" and cond["sea_state"] >= 4:
            cond["surface_return"] = True
        lines.append(LineSpec(f"{area['code']}-L{j + 1:02d}", float(start[0]), float(start[1]), float(course),
                              float(area["line_len"] + 40), t, cond))
        t = t + timedelta(minutes=float(area["line_len"] / prof.speed_mps / 60 + rng.uniform(6, 12)))

    ext_pts = np.array([box.at(0, 0), box.at(1, 0), box.at(0, 1), box.at(1, 1)])
    extent = (ext_pts[:, 0].min() - R - 60, ext_pts[:, 0].max() + R + 60, ext_pts[:, 1].min() - R - 60, ext_pts[:, 1].max() + R + 60)
    return prof, b.objects, lines, extent
