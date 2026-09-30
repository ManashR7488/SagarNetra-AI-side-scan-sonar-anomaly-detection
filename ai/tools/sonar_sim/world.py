"""World model: local ENU frame, seabed and objects. All coordinates in metres (E = east, N = north)."""

from dataclasses import dataclass, field

import numpy as np
from scipy.ndimage import gaussian_filter, map_coordinates

R_EARTH = 6371008.8


# ------------------------------------------------------------------ local frame

@dataclass
class LocalFrame:
    lat0: float
    lon0: float

    def to_latlon(self, e, n):
        lat = self.lat0 + np.degrees(np.asarray(n) / R_EARTH)
        lon = self.lon0 + np.degrees(np.asarray(e) / (R_EARTH * np.cos(np.radians(self.lat0))))
        return lat, lon

    def to_en(self, lat, lon):
        n = np.radians(np.asarray(lat) - self.lat0) * R_EARTH
        e = np.radians(np.asarray(lon) - self.lon0) * R_EARTH * np.cos(np.radians(self.lat0))
        return e, n


# ------------------------------------------------------------------ noise helpers

def _norm(a):
    return a / (np.abs(a).max() + 1e-9)


_TILE = _norm(gaussian_filter(np.random.default_rng(7).standard_normal((512, 512)), 2.0))
_TILE_FINE = _norm(gaussian_filter(np.random.default_rng(8).standard_normal((512, 512)), 0.8))


def tile_noise(x, y, cells_per_m, seed=0, fine=False):
    """Smooth pseudo-random field in [-1, 1] at world/object coordinates (tiles every 512 cells)."""
    off = np.random.default_rng(seed).uniform(0, 512, 2)
    src = _TILE_FINE if fine else _TILE
    return map_coordinates(src, [np.ravel(y) * cells_per_m + off[0], np.ravel(x) * cells_per_m + off[1]],
                           order=1, mode="grid-wrap").reshape(np.shape(x))


def fbm(x, y, base_cells_per_m, seed, octaves=3):
    total, amp, norm = 0.0, 1.0, 0.0
    for k in range(octaves):
        total = total + amp * tile_noise(x, y, base_cells_per_m * 2 ** k, seed + k)
        norm += amp
        amp *= 0.5
    return total / norm


def smoothstep(x, lo, hi):
    t = np.clip((x - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def dist_to_polyline(E, N, pts):
    """Distance (m) from points to a polyline and the along-line coordinate of the nearest point."""
    pts = np.asarray(pts, float)
    best = np.full(np.shape(E), np.inf)
    along = np.zeros(np.shape(E))
    acc = 0.0
    for (ae, an), (be, bn) in zip(pts[:-1], pts[1:]):
        de, dn = be - ae, bn - an
        seg2 = de * de + dn * dn
        t = np.clip(((E - ae) * de + (N - an) * dn) / seg2, 0, 1)
        d = np.hypot(E - (ae + t * de), N - (an + t * dn))
        closer = d < best
        best = np.where(closer, d, best)
        along = np.where(closer, acc + t * np.sqrt(seg2), along)
        acc += np.sqrt(seg2)
    return best, along


# ------------------------------------------------------------------ seabed

@dataclass
class SeabedSpec:
    depth_m: float                       # mean water depth at the area origin
    slope: tuple = (0.0, 0.0)            # depth change per metre (east, north)
    mud: float = 0.3                     # 0..1 share of low-backscatter mud
    gravel: float = 0.1                  # 0..1 share of high-backscatter gravel
    rock: float = 0.05                   # 0..1 coverage of rock outcrops
    rock_height: float = 1.5
    reef: float = 0.0                    # 0..1 coverage of coral reef patches
    sandwave_amp: float = 0.0            # m
    sandwave_len: float = 40.0           # m
    ripple_amp: float = 0.04             # m
    ripple_len: float = 1.4              # m
    trawl_marks: int = 0
    pockmarks: int = 0
    tide_amp: float = 0.6                # m (semi-diurnal)
    temp_c: float = 28.0
    salinity: float = 34.5


class Seabed:
    """Analytic seabed evaluated at arbitrary points: relief (m, + up) and backscatter strength."""

    def __init__(self, spec: SeabedSpec, extent, seed: int):
        self.spec = spec
        self.seed = seed
        rng = np.random.default_rng(seed)
        e0, e1, n0, n1 = extent
        self.e0, self.n0 = e0 - 200, n0 - 200
        self.cell = 4.0
        ny, nx = int((n1 - n0 + 400) / self.cell) + 2, int((e1 - e0 + 400) / self.cell) + 2

        def grid(sigma):
            g = gaussian_filter(rng.standard_normal((ny, nx)), sigma)
            return g / (g.std() + 1e-9)

        self.sed = grid(12)           # sediment type field
        self.rockf = grid(6)          # rock / reef outcrop field
        self.modf = grid(18)          # amplitude modulation of bedforms
        self.bathy = grid(40)         # broad depth undulation
        # thresholds reproducing the requested shares (standard normal quantiles)
        q = lambda p: float(np.quantile(self.sed, np.clip(p, 1e-3, 1 - 1e-3)))
        self.th_mud = q(spec.mud)
        self.th_gravel = q(1 - spec.gravel)
        self.th_rock = float(np.quantile(self.rockf, 1 - np.clip(spec.rock, 1e-4, 0.999)))
        self.th_reef = float(np.quantile(-self.rockf, 1 - np.clip(spec.reef, 1e-4, 0.999)))
        self.ripple_dir = rng.uniform(0, np.pi)
        self.sandwave_dir = rng.uniform(0, np.pi)
        self.trawls = []
        for _ in range(spec.trawl_marks):   # long, slightly curved otter-trawl scars
            ang = rng.uniform(0, np.pi)
            c = np.array([rng.uniform(e0, e1), rng.uniform(n0, n1)])
            d = np.array([np.sin(ang), np.cos(ang)])
            perp = np.array([d[1], -d[0]])
            ts = np.linspace(-700, 700, 8)
            bend = rng.uniform(-0.00008, 0.00008)
            self.trawls.append([tuple(c + t * d + bend * t * t * perp) for t in ts])
        self.pockmarks = [(rng.uniform(e0, e1), rng.uniform(n0, n1), rng.uniform(4, 14), rng.uniform(0.4, 1.2))
                          for _ in range(spec.pockmarks)]

    def _g(self, grid, E, N):
        return map_coordinates(grid, [(np.ravel(N) - self.n0) / self.cell, (np.ravel(E) - self.e0) / self.cell],
                               order=1, mode="nearest").reshape(np.shape(E))

    def depth(self, E, N):
        s = self.spec
        return s.depth_m + s.slope[0] * np.asarray(E) + s.slope[1] * np.asarray(N) + 1.5 * self._g(self.bathy, E, N)

    def sample(self, E, N):
        s = self.spec
        sed = self._g(self.sed, E, N)
        mud_w = 1 - smoothstep(sed, self.th_mud - 0.3, self.th_mud + 0.3)
        grav_w = smoothstep(sed, self.th_gravel - 0.3, self.th_gravel + 0.3)
        sand_w = np.clip(1 - mud_w - grav_w, 0, 1)
        refl = 0.22 * mud_w + 0.55 * sand_w + 0.9 * grav_w
        refl = refl * (1 + (0.04 + 0.08 * sand_w + 0.15 * grav_w) * tile_noise(E, N, 10, self.seed, fine=True))

        mod = np.clip(0.6 + 0.5 * self._g(self.modf, E, N), 0, 1.2)
        z = np.zeros(np.shape(E))
        if s.ripple_amp:
            proj = E * np.sin(self.ripple_dir) + N * np.cos(self.ripple_dir)
            phase = 2.5 * tile_noise(E, N, 0.3, self.seed + 1)
            z = z + s.ripple_amp * sand_w * mod * np.sin(2 * np.pi * proj / s.ripple_len + phase)
        if s.sandwave_amp:
            proj = E * np.sin(self.sandwave_dir) + N * np.cos(self.sandwave_dir)
            w = np.sin(2 * np.pi * proj / s.sandwave_len + 3 * tile_noise(E, N, 0.02, self.seed + 2))
            z = z + s.sandwave_amp * mod * (0.6 * w + 0.4 * np.abs(w))   # asymmetric crests

        rockf = self._g(self.rockf, E, N)
        if s.rock > 0:
            m = smoothstep(rockf, self.th_rock, self.th_rock + 0.35)
            relief = np.clip(fbm(E, N, 0.6, self.seed + 3) * 1.6 + 0.4, 0, None)
            z = z + m * s.rock_height * relief
            refl = refl * (1 - m) + m * (1.05 + 0.35 * tile_noise(E, N, 4, self.seed + 4))
        if s.reef > 0:
            m = smoothstep(-rockf, self.th_reef, self.th_reef + 0.3)
            relief = np.clip(fbm(E, N, 1.5, self.seed + 5) * 1.4 + 0.5, 0, None)
            z = z + m * 1.2 * relief
            refl = refl * (1 - m) + m * (0.95 + 0.45 * tile_noise(E, N, 8, self.seed + 6, fine=True))

        for pts in self.trawls:     # twin otter-board grooves with berms, slightly brighter disturbed sediment
            d, _ = dist_to_polyline(E, N, pts)
            for off in (-1.6, 1.6):
                g = np.exp(-((d - abs(off)) / 0.35) ** 2)
                z = z - 0.14 * g + 0.05 * np.exp(-((d - abs(off) - 0.6) / 0.3) ** 2)
                refl = refl * (1 + 0.18 * g)
        for pe, pn, r, dep in self.pockmarks:
            d = np.hypot(E - pe, N - pn)
            inside = np.clip(1 - (d / r) ** 2, 0, None)
            z = z - dep * inside
            refl = refl * (1 - 0.3 * inside)
        return z, np.clip(refl, 0.05, 2.5)


# ------------------------------------------------------------------ objects

@dataclass
class Prim:
    shape: str             # box | capsule | cone | ring | ellipsoid | rock | hull | tube | patch
    e: float
    n: float
    length: float = 1.0
    width: float = 1.0
    height: float = 1.0
    azimuth: float = 0.0   # deg from north, long axis
    reflect: float = 2.0   # relative to sand
    seed: int = 0
    points: list = None    # tube: [(e, n), ...]
    burial: float = 0.0    # tube: 0..1 share buried

    def radius(self):
        if self.shape == "tube":
            p = np.asarray(self.points)
            return float(np.hypot(*(p.max(0) - p.min(0))) / 2 + self.width)
        return float(np.hypot(self.length, self.width) / 2 + 0.5)

    def center(self):
        if self.shape == "tube":
            p = np.asarray(self.points)
            return tuple((p.max(0) + p.min(0)) / 2)
        return self.e, self.n


def prim_height(p: Prim, E, N):
    """Height above seabed (m) and reflectivity multiplier of a primitive at world points."""
    if p.shape == "tube":
        d, along = dist_to_polyline(E, N, p.points)
        W = p.width / 2
        h = p.height * np.sqrt(np.clip(1 - (d / W) ** 2, 0, None))
        if p.burial:
            exposed = smoothstep(tile_noise(along, along * 0, 0.08, p.seed), p.burial * 2 - 1.2, p.burial * 2 - 0.8)
            h = h * (1 - exposed * 0.95)
        if p.reflect < 1.6 and p.width < 0.4:          # chain: link texture
            h = h * (0.6 + 0.4 * (np.sin(along * np.pi / 0.18) > 0))
        return h, np.full(np.shape(E), 1.0)
    az = np.radians(p.azimuth)
    dE, dN = E - p.e, N - p.n
    u = dE * np.sin(az) + dN * np.cos(az)
    v = dE * np.cos(az) - dN * np.sin(az)
    tex = tile_noise(u, v, 5, p.seed)
    L, W, H = p.length / 2, p.width / 2, p.height
    if p.shape == "box":
        inside = (np.abs(u) <= L) & (np.abs(v) <= W)
        return np.where(inside, H * (0.93 + 0.07 * tex), 0.0), 1 + 0.2 * tex
    if p.shape == "capsule":
        uu = np.clip(np.abs(u) - (L - W), 0, None)
        q = 1 - (uu ** 2 + v ** 2) / W ** 2
        return np.where(q > 0, H * np.sqrt(np.clip(q, 0, None)), 0.0), 1 + 0.1 * tex
    if p.shape == "cone":
        r = np.hypot(u, v)
        return np.where(r < L, H * (1 - r / L) ** 0.8, 0.0), 1 + 0.1 * tex
    if p.shape == "ring":
        r = np.hypot(u, v)
        ri, ro = W, L
        inside = (r >= ri) & (r <= ro)
        return np.where(inside, H * np.sin(np.pi * (r - ri) / (ro - ri)), 0.0), 1 + 0.15 * tex
    if p.shape == "ellipsoid":
        q = 1 - (u / L) ** 2 - (v / W) ** 2
        return np.where(q > 0, H * np.sqrt(np.clip(q, 0, None)) * (0.9 + 0.1 * tex), 0.0), 1 + 0.1 * tex
    if p.shape == "rock":
        wobble = 1 + 0.35 * tile_noise(u, v, 0.8, p.seed + 7)
        r = np.hypot(u / L, v / W) / wobble
        return np.where(r < 1, H * np.clip(1 - r ** 2, 0, None) ** 0.6 * (0.8 + 0.35 * tex), 0.0), 0.85 + 0.35 * tex
    if p.shape == "hull":
        bow = np.clip((L - u) / (0.28 * p.length), 0.25, 1.0)
        stern = np.clip((u + L) / (0.08 * p.length), 0.6, 1.0)
        halfw = W * bow * stern
        inside = (np.abs(u) <= L) & (np.abs(v) <= halfw)
        deck = H * (0.72 + 0.22 * tex) * np.sqrt(np.clip(1 - (v / (halfw + 1e-6)) ** 2, 0, 1))
        holes = tile_noise(u, v, 0.9, p.seed + 3) > 0.55       # collapsed deck plating
        frames = 0.15 * (np.sin(u * 2 * np.pi / 2.2) > 0.85)
        h = np.where(inside, np.where(holes, deck * 0.45, deck), 0.0)
        return h, 1 + frames + 0.25 * tex
    if p.shape == "patch":            # ghost net: low irregular sheet with mesh texture
        wobble = 1 + 0.45 * tile_noise(u, v, 0.35, p.seed + 11)
        r = np.hypot(u / L, v / W) / wobble
        inside = r < 1
        mesh = (np.abs(np.sin(u * np.pi / 0.22)) < 0.35) | (np.abs(np.sin(v * np.pi / 0.22)) < 0.35)
        h = np.where(inside, H * (0.4 + 0.6 * (tex + 1) / 2) * np.where(mesh, 1.0, 0.55), 0.0)
        return h, np.where(mesh, 1.25, 0.8)
    raise ValueError(p.shape)


@dataclass
class WorldObject:
    id: str
    kind: str                  # shipwreck, boat_wreck, aircraft, mine_cylinder, manta_mine, ordnance, pipeline, cable,
                               # container, tyre, tyre_cluster, crab_pot_string, ghost_net, anchor_chain, debris,
                               # concrete_blocks, human_body, fish_school, rock_outcrop, boulder
    label: str | None          # detector class, None for natural features
    e: float
    n: float
    length: float
    width: float
    height: float
    azimuth: float = 0.0
    prims: list = field(default_factory=list)
    notes: str = ""
    # fish schools (water column): height of the school above the seabed
    school_z: float = 0.0

    @property
    def man_made(self):
        return self.label is not None and self.label != "marine_life"

    def radius(self):
        if not self.prims:
            return max(self.length, self.width) / 2 + 1
        return max(np.hypot(pc[0] - self.e, pc[1] - self.n) + p.radius() for p in self.prims for pc in [p.center()])
