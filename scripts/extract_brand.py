#!/usr/bin/env python3
"""Extract transparent brand assets from 品牌/ renders into web/public/brand/.

Method: un-blend against the known flat background.
  white bg: alpha = 1 - min(r,g,b)/255 ; C = (C_obs - (1-a)*255) / a
  black bg: alpha = max(r,g,b)/255     ; C = C_obs / a
This recovers full-saturation color (Lucky Blue stays #2563FF-ish) with clean
anti-aliased edges — no threshold halos.
"""
import numpy as np
from PIL import Image
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / '品牌'
OUT = ROOT / 'web' / 'public' / 'brand'
OUT.mkdir(parents=True, exist_ok=True)


def unblend(img: Image.Image, bg: str) -> Image.Image:
    a = np.asarray(img.convert('RGB'), dtype=np.float64) / 255.0
    if bg == 'white':
        alpha = 1.0 - a.min(axis=2)
    else:
        alpha = a.max(axis=2)
    alpha_c = np.clip(alpha, 1e-6, 1.0)[..., None]
    if bg == 'white':
        color = (a - (1.0 - alpha_c)) / alpha_c
    else:
        color = a / alpha_c
    color = np.clip(color, 0.0, 1.0)
    rgba = np.dstack([color, np.clip(alpha, 0, 1)])
    # kill speckle noise from render compression
    rgba[..., 3][rgba[..., 3] < 0.04] = 0.0
    return Image.fromarray((rgba * 255).round().astype(np.uint8), 'RGBA')


def trim(img: Image.Image, pad_ratio=0.03) -> Image.Image:
    alpha = np.asarray(img)[..., 3]
    ys, xs = np.where(alpha > 8)
    if len(xs) == 0:
        return img
    pad = int(max(img.size) * pad_ratio)
    x0, x1 = max(0, xs.min() - pad), min(img.width, xs.max() + 1 + pad)
    y0, y1 = max(0, ys.min() - pad), min(img.height, ys.max() + 1 + pad)
    return img.crop((x0, y0, x1, y1))


def save_scaled(img: Image.Image, name: str, target_h: int | None = None, target_w: int | None = None):
    w, h = img.size
    if target_h and h > target_h:
        img = img.resize((round(w * target_h / h), target_h), Image.LANCZOS)
    elif target_w and w > target_w:
        img = img.resize((target_w, round(h * target_w / w)), Image.LANCZOS)
    img.save(OUT / name)
    print(f'{name:22} {img.size[0]}x{img.size[1]}')


def recolor_to_white(img: Image.Image) -> Image.Image:
    """Turn near-black strokes white, keep the blue star (for dark backgrounds)."""
    arr = np.asarray(img).astype(np.float64)
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    is_blue = (b > 120) & (b > r + 40)
    dark = ~is_blue
    for ch in range(3):
        arr[..., ch][dark] = 255
    return Image.fromarray(arr.round().astype(np.uint8), 'RGBA')


# wordmark (black + blue on white) → transparent, dark-ink version for light UI
wordmark = trim(unblend(Image.open(SRC / 'mindex-2.png'), 'white'))
save_scaled(wordmark, 'wordmark.png', target_h=120)
# white version for dark surfaces (recolored from the same clean alpha)
save_scaled(recolor_to_white(wordmark), 'wordmark-white.png', target_h=120)

# symbol: M + star without container (from mindex-4). The pale container ring
# unblends to low-alpha black, so a color filter can't remove it — instead keep
# only pixels near SOLID cores (alpha>0.6), which the faint ring never has.
from PIL import ImageFilter

icon_white = unblend(Image.open(SRC / 'mindex-4.png'), 'white')
arr = np.asarray(icon_white).astype(np.float64)
core = (arr[..., 3] > 150).astype(np.uint8) * 255
dilated = np.asarray(Image.fromarray(core, 'L').filter(ImageFilter.MaxFilter(9)))
arr[..., 3] = np.where(dilated > 0, arr[..., 3], 0)
symbol = trim(Image.fromarray(arr.round().astype(np.uint8), 'RGBA'))
save_scaled(symbol, 'symbol.png', target_h=256)
save_scaled(recolor_to_white(symbol), 'symbol-white.png', target_h=256)

# app icon: black rounded container + WHITE M + blue star (mindex-3 on white).
# Luminance unblend would wrongly erase the white M (same as bg). Instead flood-fill
# only the background reachable from the border → the enclosed white M stays opaque;
# the rounded-corner gaps become transparent. RGB is kept verbatim (white M stays white).
from PIL import ImageDraw


def cutout_appicon(img: Image.Image) -> Image.Image:
    rgb = img.convert('RGB')
    # flood the outer white background with a sentinel that won't occur in the art
    flood = rgb.copy()
    sentinel = (255, 0, 255)
    w, h = flood.size
    for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(flood, seed, sentinel, thresh=40)
    fa = np.asarray(flood)
    is_bg = (fa[..., 0] == 255) & (fa[..., 1] == 0) & (fa[..., 2] == 255)
    alpha = np.where(is_bg, 0, 255).astype(np.uint8)
    out = np.dstack([np.asarray(rgb), alpha])
    return Image.fromarray(out, 'RGBA')


appicon = trim(cutout_appicon(Image.open(SRC / 'mindex-3.png')), pad_ratio=0.02)
save_scaled(appicon.copy(), 'appicon-512.png', target_w=512)
save_scaled(appicon.copy(), 'favicon-64.png', target_w=64)
save_scaled(appicon.copy(), 'favicon-32.png', target_w=32)
save_scaled(appicon.copy(), 'apple-touch-icon.png', target_w=180)

print('done →', OUT)
