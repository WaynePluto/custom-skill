"""AI pixel-art image -> native-resolution Aseprite-ready PNG.

stages: grid detect -> phase align -> per-cell downsample -> optional palette quantize

usage:
  python pipeline.py <input.png> <output.png> [--colors N] [--cell N]
  --colors 0   : keep downsampled colors as-is (no quantization)
  --colors N   : quantize to N colors (k-means-ish via PIL MEDIANCUT/OCTREE best pick)
  --cell N     : force cell size (skip detection)
"""
import sys
import numpy as np
from PIL import Image


def detect_cell(gray: np.ndarray) -> int:
    """Detect pixel-grid cell size via autocorrelation of gradient profiles,
       then VERIFY with intra-cell variance (real upscaled art -> near-zero)."""
    def profile_period(profile):
        p = profile - profile.mean()
        ac = np.correlate(p, p, mode="full")[len(p) - 1:]
        ac /= ac[0] + 1e-9
        best_lag, best_v = 0, 0.0
        for lag in range(2, 25):
            if ac[lag] > ac[lag - 1] and ac[lag] >= ac[lag + 1] and ac[lag] > best_v:
                best_lag, best_v = lag, ac[lag]
        return best_lag, best_v

    gx = np.abs(np.diff(gray, axis=1)).sum(axis=0)
    gy = np.abs(np.diff(gray, axis=0)).sum(axis=1)
    lx, vx = profile_period(gx)
    ly, vy = profile_period(gy)
    print(f"grid detect: x-lag={lx} (conf {vx:.2f}), y-lag={ly} (conf {vy:.2f})")
    if vx <= 0.05 and vy <= 0.05:
        return 1
    cand = lx if vx >= vy else ly
    # verify: a genuine N x upscale has ~uniform cells (variance ~0..30)
    ox, oy = best_phase(gray, cand)
    h, w = gray.shape
    ys = (h - oy) // cand
    xs = (w - ox) // cand
    sub = gray[oy:oy + ys * cand, ox:ox + xs * cand]
    var = sub.reshape(ys, cand, xs, cand).var(axis=(1, 3)).mean()
    print(f"verify cell={cand}: intra-cell variance = {var:.1f}")
    if var > 40:
        print("variance too high -> image is already native resolution (cell=1)")
        return 1
    return cand


def best_phase(gray: np.ndarray, cell: int):
    """Find grid offset minimizing intra-cell variance."""
    h, w = gray.shape
    best, best_score = (0, 0), 1e18
    for oy in range(cell):
        for ox in range(cell):
            ys = (h - oy) // cell
            xs = (w - ox) // cell
            if ys < 4 or xs < 4:
                continue
            sub = gray[oy:oy + ys * cell, ox:ox + xs * cell]
            blocks = sub.reshape(ys, cell, xs, cell)
            score = blocks.var(axis=(1, 3)).mean()
            if score < best_score:
                best_score, best = score, (ox, oy)
    return best


def downsample(arr: np.ndarray, cell: int, ox: int, oy: int) -> np.ndarray:
    """Center-pixel-of-cell downsample (keeps colors crisp, no averaging drift)."""
    h, w = arr.shape[:2]
    nh = (h - oy) // cell
    nw = (w - ox) // cell
    cy = oy + cell // 2
    cx = ox + cell // 2
    return arr[cy:cy + nh * cell:cell, cx:cx + nw * cell:cell].copy()


def quantize_kmeans(arr: np.ndarray, n: int, iters: int = 12) -> np.ndarray:
    """K-means in RGB with perceptual weights; seeds from most frequent colors."""
    wgt = np.array([0.55, 0.77, 0.33])   # sqrt of luma weights, softened
    px = arr.reshape(-1, 3).astype(np.float64)
    # unique colors + counts (image is already flat-ish after downsample)
    uniq, counts = np.unique(px, axis=0, return_counts=True)
    order = np.argsort(-counts)
    uniq, counts = uniq[order], counts[order]
    # seed: greedy pick frequent colors that are mutually distant
    seeds = [uniq[0]]
    for c in uniq[1:]:
        if len(seeds) >= n:
            break
        d = min(((c - s) ** 2 @ wgt ** 2) for s in seeds)
        if d > 180:
            seeds.append(c)
    i = 1
    while len(seeds) < n and i < len(uniq):
        seeds.append(uniq[i]); i += 1
    cent = np.array(seeds, dtype=np.float64)

    uw = uniq * wgt
    for _ in range(iters):
        cw = cent * wgt
        d2 = ((uw[:, None, :] - cw[None, :, :]) ** 2).sum(axis=2)
        lab = d2.argmin(axis=1)
        for k in range(len(cent)):
            m = lab == k
            if m.any():
                cent[k] = np.average(uniq[m], axis=0, weights=counts[m])
    cw = cent * wgt
    d2 = ((uw[:, None, :] - cw[None, :, :]) ** 2).sum(axis=2)
    lab = d2.argmin(axis=1)
    lut = {tuple(u.astype(int)): cent[l].round().astype(np.uint8) for u, l in zip(uniq, lab)}
    out = np.array([lut[tuple(p.astype(int))] for p in px], dtype=np.uint8)
    return out.reshape(arr.shape)


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    src, dst = args[0], args[1]
    colors = 0
    cell_force = 0
    for i, a in enumerate(args):
        if a == "--colors":
            colors = int(args[i + 1])
        if a == "--cell":
            cell_force = int(args[i + 1])

    im = Image.open(src).convert("RGB")
    arr = np.asarray(im)
    gray = np.asarray(im.convert("L"), dtype=float)
    print(f"input {im.size}")

    cell = cell_force or detect_cell(gray)
    print(f"cell = {cell}")
    if cell > 1:
        ox, oy = best_phase(gray, cell)
        print(f"phase = ({ox},{oy})")
        native = downsample(arr, cell, ox, oy)
    else:
        native = arr
    h, w = native.shape[:2]
    ncol = len(np.unique(native.reshape(-1, 3), axis=0))
    print(f"native = {w}x{h}, colors = {ncol}")

    if colors > 0 and ncol > colors:
        native = quantize_kmeans(native, colors)
        print(f"quantized to {len(np.unique(native.reshape(-1,3), axis=0))} colors")

    Image.fromarray(native).save(dst)
    print(f"saved {dst}")


if __name__ == "__main__":
    main()
