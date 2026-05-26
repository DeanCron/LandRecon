"""
Convert a logo with an opaque white background into a true transparent PNG
by computing per-pixel alpha from luminance (preserves anti-aliased edges).

Assumes the input was rendered onto a white background:
    visible = original_color * a + 255 * (1 - a)
With min(R,G,B) as the closest-to-white channel:
    a = 1 - min(R,G,B) / 255
    R_orig = (R_visible - 255 * (1 - a)) / a   (and same for G, B)

After conversion, auto-crops to the bounding box of non-transparent pixels.
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image


def unmultiply_white(src: Path, dst: Path) -> None:
    img = Image.open(src).convert("RGB")
    arr = np.array(img).astype(np.float32)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]

    min_c = np.minimum(np.minimum(r, g), b)
    alpha = 255.0 - min_c
    alpha = np.where(alpha <= 5.0, 0.0, alpha)
    a_frac = alpha / 255.0
    safe = np.where(a_frac > 0, a_frac, 1.0)

    def undo(channel: np.ndarray) -> np.ndarray:
        original = (channel - 255.0 * (1.0 - a_frac)) / safe
        return np.clip(original, 0.0, 255.0)

    r_o = np.where(a_frac > 0, undo(r), 0.0)
    g_o = np.where(a_frac > 0, undo(g), 0.0)
    b_o = np.where(a_frac > 0, undo(b), 0.0)

    out = np.stack(
        [
            r_o.astype(np.uint8),
            g_o.astype(np.uint8),
            b_o.astype(np.uint8),
            alpha.astype(np.uint8),
        ],
        axis=-1,
    )
    rgba = Image.fromarray(out, mode="RGBA")
    a_arr = np.array(rgba)[..., 3]
    ys, xs = np.where(a_arr > 32)
    if ys.size:
        pad = 6
        x0 = max(int(xs.min()) - pad, 0)
        y0 = max(int(ys.min()) - pad, 0)
        x1 = min(int(xs.max()) + 1 + pad, rgba.width)
        y1 = min(int(ys.max()) + 1 + pad, rgba.height)
        rgba = rgba.crop((x0, y0, x1, y1))
    rgba.save(dst, optimize=True)
    print(f"output size: {rgba.size[0]} x {rgba.size[1]}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: transparent-logo.py <input.png> <output.png>")
        sys.exit(1)
    unmultiply_white(Path(sys.argv[1]), Path(sys.argv[2]))
    print(f"wrote {sys.argv[2]}")
