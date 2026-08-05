"""Numeric verification for pixel2ase output (no vision required).

usage: python verify.py <original.png> <native.png>

Reports objective metrics so a text-only model can judge correctness:
  * grid fidelity   : native upscaled back == original ?
  * residual grid   : does native still contain NxN uniform blocks ?
  * color count     : indexed-mode readiness
"""
import sys
import numpy as np
from PIL import Image


def uniform_block_ratio(arr: np.ndarray, n: int) -> float:
    """Fraction of NxN blocks that are a single flat color."""
    h, w = arr.shape[:2]
    bh, bw = h // n, w // n
    if bh < 2 or bw < 2:
        return 0.0
    sub = arr[: bh * n, : bw * n].reshape(bh, n, bw, n, -1)
    first = sub[:, :1, :, :1, :]
    return float((sub == first).all(axis=(1, 3, 4)).mean())


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    orig = np.asarray(Image.open(sys.argv[1]).convert("RGB"))
    nat = np.asarray(Image.open(sys.argv[2]).convert("RGB"))

    oh, ow = orig.shape[:2]
    nh, nw = nat.shape[:2]
    scale = max(1, round(ow / nw))
    print(f"original : {ow}x{oh}")
    print(f"native   : {nw}x{nh}   (detected scale = {scale}x)")

    # --- 1. grid fidelity: upscale native back, compare with original
    up = np.repeat(np.repeat(nat, scale, axis=0), scale, axis=1)
    ch, cw = min(oh, up.shape[0]), min(ow, up.shape[1])
    a, b = orig[:ch, :cw], up[:ch, :cw]
    exact = float((a == b).all(axis=2).mean())
    mad = float(np.abs(a.astype(int) - b.astype(int)).mean())
    print(f"grid fidelity : {exact*100:.1f}% pixels identical, mean abs diff {mad:.2f}")

    # --- 2. residual grid in native (should be low; high => under-sampled)
    residual = {}
    for n in (2, 3, 4):
        residual[n] = uniform_block_ratio(nat, n)
    res_str = ", ".join(f"{n}x{n}={residual[n]*100:.0f}%" for n in residual)
    print(f"residual grid : {res_str}")

    # --- 3. colors
    ncol = len(np.unique(nat.reshape(-1, 3), axis=0))
    print(f"colors        : {ncol}")

    # --- verdict
    problems, warns = [], []
    if exact < 0.85:
        problems.append(
            f"grid fidelity too low ({exact*100:.1f}% < 85%): cell size likely wrong. "
            f"retry with --cell 1 (keep native) or an explicit --cell N")
    worst = max(residual, key=residual.get)
    if residual[worst] > 0.60:
        problems.append(
            f"native still contains {worst}x{worst} uniform blocks ({residual[worst]*100:.0f}%): "
            f"probably under-sampled, retry with --cell {worst * scale}")
    if ncol > 256:
        warns.append(f"{ncol} colors > 256: png2ase.lua needs indexed<=256, "
                     f"rerun pipeline.py with --colors 256")

    print()
    if problems:
        print("RESULT: FAIL")
        for p in problems:
            print(f"  - {p}")
    elif warns:
        print("RESULT: WARN")
        for w in warns:
            print(f"  - {w}")
    else:
        print("RESULT: PASS  (grid correct, no residual blocks, indexed-ready)")

    # note for the caller
    print("\nNOTE: these metrics cannot judge artistic quality (blurry faces, "
          "color mood). If you cannot view images, ask the user to eyeball the "
          "preview before proceeding.")


if __name__ == "__main__":
    main()
