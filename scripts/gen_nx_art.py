#!/usr/bin/env python3
# gen_nx_art.py — NX brand art: mod icon + per-theme pack.png
# Dark glass rounded square, gradient accent ring, geometric "NX" glyph.
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

SS = 4  # supersample
S = 256 * SS

THEMES = {
    'purple':  ('#a855f7', '#c084fc'),
    'emerald': ('#22c55e', '#4ade80'),
    'cyan':    ('#06b6d4', '#22d3ee'),
    'orange':  ('#f97316', '#fb923c'),
}

def hx(h, a=255):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)

def rounded_gradient(size, radius, c_from, c_to, horizontal=False):
    """Rounded-rect image with a vertical/diagonal gradient."""
    w, h = size
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    grad = Image.new('RGBA', (w, h))
    gd = ImageDraw.Draw(grad)
    for y in range(h):
        t = y / max(1, h - 1)
        if horizontal:
            t = y / max(1, w - 1)
        c = tuple(int(c_from[i] + (c_to[i] - c_from[i]) * t) for i in range(4))
        if horizontal:
            gd.line([(y, 0), (y, h)], fill=c)
        else:
            gd.line([(0, y), (w, y)], fill=c)
    mask = Image.new('L', (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    return img

def nx_logo(accent='#a855f7', bright='#22d3ee'):
    """The NX icon at 256x256 (supersampled)."""
    acc, bri = hx(accent), hx(bright)
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # glass body
    body = rounded_gradient((S, S), 56 * SS, hx('#12151f'), hx('#0a0c12'), horizontal=True)
    img.alpha_composite(body)

    # subtle top sheen
    sheen = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.rounded_rectangle([6 * SS, 6 * SS, S - 7 * SS, S // 2], radius=52 * SS, fill=(255, 255, 255, 14))
    sheen = sheen.filter(ImageFilter.GaussianBlur(6 * SS))
    img.alpha_composite(sheen)

    # accent ring (diagonal gradient purple->bright)
    ring = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    for i in range(6 * SS):
        t = i / (6 * SS)
        c = tuple(int(acc[j] + (bri[j] - acc[j]) * t) for j in range(4))
        alpha = int(255 * (1 - t * 0.15))
        rd.rounded_rectangle([i * SS * 0 + i, i, S - 1 - i, S - 1 - i], radius=max(0, 56 * SS - i),
                             outline=(c[0], c[1], c[2], alpha), width=1)
    img.alpha_composite(ring)

    # inner glow behind glyph
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([S * 0.22, S * 0.30, S * 0.78, S * 0.72], fill=(acc[0], acc[1], acc[2], 60))
    glow = glow.filter(ImageFilter.GaussianBlur(22 * SS))
    img.alpha_composite(glow)

    # NX glyph — geometric blocks (no font dependency): N = two stems + diagonal, X = two diagonals
    g = ImageDraw.Draw(img)
    m = 46 * SS          # glyph box margin
    x0, y0, x1, y1 = m, m, S - m, S - m
    t_ = 17 * SS         # stroke thickness
    diag = (x1 - x0) - t_  # horizontal run of the diagonal
    # N
    g.rectangle([x0, y0, x0 + t_, y1], fill=(255, 255, 255, 242))
    g.rectangle([x1 - t_, y0, x1, y1], fill=(255, 255, 255, 242))
    for i in range(diag):
        xx = x0 + t_ + i
        yy0 = y0 + int(i * (y1 - y0 - t_) / diag)
        g.line([(xx, yy0), (xx, yy0 + t_)], fill=(255, 255, 255, 242))
    # accent edge on N diagonal
    # X (right half)
    gx0 = x1 + 0  # X occupies its own half below? No: single row "NX" — X drawn to the right of N
    # shift: draw X in the right 45% of a wider canvas is complex; instead draw X overlapping right side
    # Simple approach: draw X centered in right half of glyph box
    hx0 = int(S * 0.585)
    hy0, hy1 = y0 + 6 * SS, y1 - 6 * SS
    hw = (x1 - hx0)
    steps = hw
    for i in range(steps):
        t01 = i / max(1, steps - 1)
        # down-left stroke
        yy = int(hy0 + t01 * (hy1 - hy0))
        xx = hx0 + int(t01 * (hw - t_))
        g.rectangle([xx, yy, xx + t_, yy + int((hy1 - hy0) * 0.045) + t_ // 3], fill=(bri[0], bri[1], bri[2], 235))
        # up-left stroke
        yy2 = int(hy1 - t01 * (hy1 - hy0))
        g.rectangle([xx, yy2 - int((hy1 - hy0) * 0.045) - t_ // 3 + t_ // 3, xx + t_, yy2 + t_ // 3], fill=(255, 255, 255, 225))

    # scanline detail
    g.rectangle([x0 + t_, y1 + 8 * SS, x1 - int((x1 - x0) * 0.35), y1 + 11 * SS], fill=(acc[0], acc[1], acc[2], 160))

    return img.resize((256, 256), Image.LANCZOS)

def main():
    out_icon = '/home/z/my-project/nx-mod/src/main/resources/assets/nx/icon.png'
    os.makedirs(os.path.dirname(out_icon), exist_ok=True)
    nx_logo().save(out_icon)
    print('icon ->', out_icon)

    packs = '/home/z/my-project/neurax-launcher/src/main/clientpacks'
    for theme, (acc, bri) in THEMES.items():
        p = os.path.join(packs, theme, 'pack.png')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        nx_logo(acc, bri).save(p)
        print('pack.png ->', p)

if __name__ == '__main__':
    main()
