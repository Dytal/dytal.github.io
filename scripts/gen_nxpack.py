#!/usr/bin/env python3
# gen_nxpack.py — "NX Interface": the Neurax 64x-class futuristic animated GUI pack.
#
# Scope (user-directed): buttons, checkboxes, sliders, scrollbars, text fields,
# tooltips, cross/page/lock chips — pure *interactive widget* chrome only.
# Inventory, hotbar, HUD and container screens are NOT touched (no container/*,
# no hud/* sprites are emitted).
#
# Art spec: every sprite is exactly 4x its vanilla pixel size (200x20 -> 800x80),
# nine-slice borders scaled to match, animated sprites are vertical frame strips
# with a vanilla-format .png.mcmeta (animation + gui.scaling nine_slice).
# Four theme variants driven by the launcher's own accents.
import json, os, sys
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_nx_art import nx_logo, THEMES

PACKS = '/home/z/my-project/neurax-launcher/src/main/clientpacks'
X = 4  # art scale (64x-class)
SS = 1  # direct 1:1 drawing (art is already 4x; extra supersample caused coord bugs)

SPR = 'assets/minecraft/textures/gui/sprites'

# --------------------------------------------------------------------------
# low-level helpers
# --------------------------------------------------------------------------

def canvas(w, h):
    return Image.new('RGBA', (w * SS, h * SS), (0, 0, 0, 0))

def hx(hexstr, a=255):
    h = hexstr.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)

def vgrad(size, top, bot, radius):
    """Vertical gradient clipped to a rounded rect."""
    w, h = size
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    grad = Image.new('RGBA', (w, h))
    gd = ImageDraw.Draw(grad)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(4))
        gd.line([(0, y), (w, y)], fill=c)
    mask = Image.new('L', (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    return img

def glow_layer(size, shape_fn, color, blur, alpha=255):
    """Blurred accent shape used for glows."""
    layer = Image.new('RGBA', size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    shape_fn(d, (color[0], color[1], color[2], alpha))
    return layer.filter(ImageFilter.GaussianBlur(blur))

def finish(img, w, h):
    return img.resize((w, h), Image.LANCZOS)

def rrect(d, box, r, **kw):
    d.rounded_rectangle([box[0] * SS, box[1] * SS, box[2] * SS - 1, box[3] * SS - 1], radius=r * SS, **kw)

# --------------------------------------------------------------------------
# sprite builders (each returns PIL image at the 4x pixel size)
# --------------------------------------------------------------------------

def make_button(theme, state, frame=None, frames=8):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    W, H, r, b = 200 * X, 20 * X, 6 * X, 3 * X
    img = canvas(W, H)
    d = ImageDraw.Draw(img)
    if state == 'disabled':
        img.alpha_composite(vgrad((W, H), (13, 15, 22, 205), (10, 12, 18, 215), r * SS))
        rrect(d, (0, 0, W, H), r, outline=(255, 255, 255, 26), width=b)
    else:
        img.alpha_composite(vgrad((W, H), (15, 17, 26, 226), (9, 11, 17, 238), r * SS))
        # top sheen + bottom shadow
        d.line([(2 * r, 7), (W - 2 * r, 7)], fill=(255, 255, 255, 26), width=1)
        d.line([(2 * r, H - 9), (W - 2 * r, H - 9)], fill=(0, 0, 0, 70), width=3)
        pulse = 1.0
        if state == 'highlighted':
            if frame is not None:
                pulse = 0.82 + 0.18 * (1 - abs(2 * frame / frames - 1))  # breathe
            rrect(d, (0, 0, W, H), r, outline=(bri[0], bri[1], bri[2], int(215 * pulse)), width=b)
            d = ImageDraw.Draw(img)
            wash = glow_layer((W, H), lambda dd, c: dd.rounded_rectangle(
                [b * SS, b * SS, (W - b) * SS - 1, (H - b) * SS - 1], radius=r * SS - b * SS, fill=c),
                acc, blur=10 * SS, alpha=int(46 * pulse))
            img.alpha_composite(wash)
            # sweeping sheen, center region
            if frame is not None:
                span = W - 4 * b - 60 * X
                x0 = b * 2 + int(span * frame / (frames - 1))
                sheen = Image.new('RGBA', (W, H), (0, 0, 0, 0))
                sd = ImageDraw.Draw(sheen)
                sd.polygon([(x0, 8), (x0 + int(18 * X), 8), (x0 + int(10 * X), H - 8), (x0 - int(8 * X), H - 8)],
                           fill=(255, 255, 255, 22))
                sheen = sheen.filter(ImageFilter.GaussianBlur(4 * SS))
                img.alpha_composite(sheen)
            d = ImageDraw.Draw(img)
        else:
            rrect(d, (0, 0, W, H), r, outline=(255, 255, 255, 44), width=b)
    return finish(img, W, H)

def make_checkbox(theme, state):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    S_ = 20 * X
    img = canvas(S_, S_)
    d = ImageDraw.Draw(img)
    r = 4 * X
    img.alpha_composite(vgrad((S_, S_), (15, 17, 26, 228), (9, 11, 17, 238), r * SS))
    selected = 'selected' in state
    hovered = 'highlighted' in state
    if selected:
        glow = glow_layer((S_, S_), lambda dd, c: dd.rounded_rectangle(
            [3 * SS, 3 * SS, S_ * SS - 3 * SS, S_ * SS - 3 * SS], radius=r * SS, fill=c),
            acc, blur=6 * SS, alpha=150)
        img.alpha_composite(glow)
        d = ImageDraw.Draw(img)
        img.alpha_composite(vgrad((S_, S_), (bri[0], bri[1], bri[2], 242), (acc[0], acc[1], acc[2], 242), r * SS))
        d = ImageDraw.Draw(img)
        # crisp check glyph
        pts = [(int(S_ * .24), int(S_ * .52)), (int(S_ * .43), int(S_ * .70)), (int(S_ * .78), int(S_ * .30))]
        d.line(pts, fill=(255, 255, 255, 252), width=3 * X - 2 * SS, joint='curve')
        rrect(d, (0, 0, S_, S_), r, outline=(255, 255, 255, 120 if hovered else 70), width=2 * SS)
    else:
        if hovered:
            wash = glow_layer((S_, S_), lambda dd, c: dd.rounded_rectangle(
                [0, 0, S_ * SS - 1, S_ * SS - 1], radius=r * SS, fill=c), acc, blur=4 * SS, alpha=60)
            img.alpha_composite(wash)
            d = ImageDraw.Draw(img)
        rrect(d, (0, 0, S_, S_), r, outline=(acc[0], acc[1], acc[2], 170) if hovered else (255, 255, 255, 52),
              width=3 * X - 4 * SS)
    return finish(img, S_, S_)

def make_slider_track(theme, highlighted):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    W, H, r = 200 * X, 20 * X, 6 * X
    img = canvas(W, H)
    d = ImageDraw.Draw(img)
    img.alpha_composite(vgrad((W, H), (5, 7, 12, 238), (7, 9, 15, 238), r * SS))
    d = ImageDraw.Draw(img)
    # accent centerline
    lc = bri if highlighted else acc
    d.line([(3 * r, H // 2), (W - 3 * r, H // 2)], fill=(lc[0], lc[1], lc[2], 105 if highlighted else 60), width=1 * X)
    rrect(d, (0, 0, W, H), r, outline=(255, 255, 255, 55 if highlighted else 36), width=1 * X)
    return finish(img, W, H)

def make_slider_handle(theme, highlighted, frame=None, frames=6):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    W, H, r = 8 * X, 20 * X, 2 * X
    img = canvas(W, H)
    d = ImageDraw.Draw(img)
    img.alpha_composite(vgrad((W, H), (bri[0], bri[1], bri[2], 248), (acc[0], acc[1], acc[2], 248), r * SS))
    d = ImageDraw.Draw(img)
    d.line([(W // 2, int(H * .28)), (W // 2, int(H * .72))], fill=(0, 0, 0, 95), width=1 * X)
    if highlighted and frame is not None:
        t = frame / (frames - 1)
        y0 = int(H * (0.18 + 0.5 * t))
        sheen = Image.new('RGBA', (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(sheen).rectangle([2, y0, W - 2, y0 + int(H * .16)], fill=(255, 255, 255, 85))
        sheen = sheen.filter(ImageFilter.GaussianBlur(2 * SS))
        img.alpha_composite(sheen)
        d = ImageDraw.Draw(img)
    rrect(d, (0, 0, W, H), r, outline=(255, 255, 255, 130 if highlighted else 95), width=1 * X)
    return finish(img, W, H)

def make_scroller(theme, is_bg):
    W, H = 6 * X, 32 * X
    img = canvas(W, H)
    d = ImageDraw.Draw(img)
    if is_bg:
        img.alpha_composite(vgrad((W, H), (4, 6, 10, 175), (4, 6, 10, 185), 2 * SS))
        d = ImageDraw.Draw(img)
        rrect(d, (0, 0, W, H), 1 * X, outline=(255, 255, 255, 26), width=1 * X)
    else:
        img.alpha_composite(vgrad((W, H), (17, 20, 30, 238), (12, 14, 22, 238), 1 * X))
        d = ImageDraw.Draw(img)
        for i in range(2):
            y = H // 2 + (i * 2 - 1) * 2 * X
            d.line([(2 * X, y), (4 * X, y)], fill=(255, 255, 255, 55), width=1 * X)
        rrect(d, (0, 0, W, H), 1 * X, outline=(255, 255, 255, 60), width=1 * X)
    return finish(img, W, H)

def make_text_field(theme, state, frame=None, frames=6):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    W, H, r, b = 200 * X, 20 * X, 4 * X, 1 * X
    img = canvas(W, H)
    d = ImageDraw.Draw(img)
    img.alpha_composite(vgrad((W, H), (4, 6, 10, 242), (6, 8, 13, 242), r * SS))
    d = ImageDraw.Draw(img)
    d.line([(2 * r, 4), (W - 2 * r, 4)], fill=(0, 0, 0, 110), width=2)
    if state == 'highlighted':
        alpha = 150
        if frame is not None:
            alpha = int(110 + 60 * (1 - abs(2 * frame / (frames - 1) - 1)))
        rrect(d, (0, 0, W, H), r, outline=(bri[0], bri[1], bri[2], alpha), width=1 * X)
        wash = glow_layer((W, H), lambda dd, c: dd.rounded_rectangle(
            [1, 1, W * SS - 1, H * SS - 1], radius=r * SS, fill=c), acc, blur=8 * SS, alpha=26)
        img.alpha_composite(wash)
        d = ImageDraw.Draw(img)
    else:
        rrect(d, (0, 0, W, H), r, outline=(255, 255, 255, 44), width=1 * X)
    return finish(img, W, H)

def make_tooltip(theme, is_frame):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    W = H = 100 * X
    r = 9 * X
    img = canvas(W, H)
    d = ImageDraw.Draw(img)
    if not is_frame:
        img.alpha_composite(vgrad((W, H), (7, 9, 14, 232), (5, 7, 11, 238), r * SS))
        d = ImageDraw.Draw(img)
        rrect(d, (0, 0, W, H), r, outline=(acc[0], acc[1], acc[2], 70), width=1 * X)
        rrect(d, (2 * X, 2 * X, W - 2 * X, H - 2 * X), r - 2 * X, outline=(255, 255, 255, 16), width=1 * X)
    else:
        rrect(d, (0, 0, W, H), r, outline=(bri[0], bri[1], bri[2], 165), width=1 * X)
        # corner ticks
        L = 5 * X
        for cx, cy, sx, sy in [(0, 0, 1, 1), (W, 0, -1, 1), (0, H, 1, -1), (W, H, -1, -1)]:
            d.line([(cx, cy + sy * L), (cx, cy)], fill=(bri[0], bri[1], bri[2], 230), width=1 * X)
            d.line([(cx, cy), (cx + sx * L, cy)], fill=(bri[0], bri[1], bri[2], 230), width=1 * X)
    return finish(img, W, H)

def make_cross(theme, highlighted, frame=None, frames=5):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    S_ = 14 * X
    img = canvas(S_, S_)
    d = ImageDraw.Draw(img)
    img.alpha_composite(vgrad((S_, S_), (12, 14, 22, 218), (8, 10, 16, 224), 3 * X))
    d = ImageDraw.Draw(img)
    pulse = 1.0
    if highlighted and frame is not None:
        pulse = 0.72 + 0.28 * (1 - abs(2 * frame / (frames - 1) - 1))
    col = bri if highlighted else (255, 255, 255, 195)
    m, L = int(S_ * .30), int(S_ * .40)
    c = col if isinstance(col, tuple) else (255, 255, 255, 195)
    alpha = int(c[3] * pulse) if highlighted else c[3]
    d.line([(m, m), (m + L, m + L)], fill=(c[0], c[1], c[2], alpha), width=2 * X)
    d.line([(m + L, m), (m, m + L)], fill=(c[0], c[1], c[2], alpha), width=2 * X)
    if highlighted:
        rrect(d, (0, 0, S_, S_), 3 * X, outline=(acc[0], acc[1], acc[2], int(150 * pulse)), width=1 * X)
    return finish(img, S_, S_)

def make_page(theme, direction, highlighted, frame=None, frames=5):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    W, H = 23 * X, 13 * X
    img = canvas(W, H)
    d = ImageDraw.Draw(img)
    pulse = 1.0
    if highlighted and frame is not None:
        pulse = 0.7 + 0.3 * (1 - abs(2 * frame / (frames - 1) - 1))
    base = bri if highlighted else (255, 255, 255, 175)
    col = (base[0], base[1], base[2], int(base[3] * pulse)) if highlighted else base
    # chevron: '>' points right, '<' points left, vertically centered
    mid_y = H // 2
    arm = int(W * 0.20)          # horizontal reach of each arm
    tip = int(W * 0.60 if direction == 'forward' else W * 0.40)
    sgn = 1 if direction == 'forward' else -1
    d.line([(tip - sgn * arm, int(H * 0.18)), (tip, mid_y)], fill=col, width=2 * X)
    d.line([(tip, mid_y), (tip - sgn * arm, int(H * 0.82))], fill=col, width=2 * X)
    return finish(img, W, H)

def make_lock(theme, locked, state):
    acc, bri = hx(THEMES[theme][0]), hx(THEMES[theme][1])
    S_ = 20 * X
    img = canvas(S_, S_)
    d = ImageDraw.Draw(img)
    img.alpha_composite(vgrad((S_, S_), (12, 14, 22, 218), (8, 10, 16, 224), 4 * X))
    d = ImageDraw.Draw(img)
    alpha = {'normal': 200, 'highlighted': 250, 'disabled': 80}[state]
    col = bri if state == 'highlighted' else (255, 255, 255, alpha)
    # body
    bx0, by0, bx1, by1 = int(S_ * .30), int(S_ * .48), int(S_ * .70), int(S_ * .76)
    rrect(d, (bx0, by0, bx1, by1), 1 * X, fill=col if state != 'disabled' else (col[0], col[1], col[2], alpha),
          outline=(0, 0, 0, 60), width=1)
    # shackle
    if locked:
        d.arc([int(S_ * .32) * SS, int(S_ * .20) * SS, int(S_ * .68) * SS, int(S_ * .56) * SS], 180, 360,
              fill=col, width=2 * X - 1)
    else:
        d.arc([int(S_ * .32) * SS, int(S_ * .16) * SS, int(S_ * .68) * SS, int(S_ * .52) * SS], 200, 340,
              fill=col, width=2 * X - 1)
    return finish(img, S_, S_)

# --------------------------------------------------------------------------
# mcmeta helpers
# --------------------------------------------------------------------------

def mcmeta(vanilla_w, vanilla_h, vanilla_border, animated=None, frametime=2, frames_n=None, interpolate=True):
    """Vanilla-format sprite mcmeta: nine_slice scaled to 4x + optional animation."""
    out = {'gui': {'scaling': {'type': 'nine_slice', 'width': vanilla_w * X, 'height': vanilla_h * X}}}
    b = vanilla_border
    if isinstance(b, dict):
        out['gui']['scaling']['border'] = {k: v * X for k, v in b.items()}
    else:
        out['gui']['scaling']['border'] = b * X
    if animated:
        fr = list(range(frames_n)) if frames_n else []
        out['animation'] = {'frametime': frametime, 'frames': fr, 'interpolate': interpolate}
    return json.dumps(out, indent=2)

def strip(frames_imgs):
    """Stack same-size frames vertically into one texture."""
    w, h = frames_imgs[0].size
    out = Image.new('RGBA', (w, h * len(frames_imgs)), (0, 0, 0, 0))
    for i, f in enumerate(frames_imgs):
        out.paste(f, (0, i * h))
    return out

# --------------------------------------------------------------------------
# pack assembly
# --------------------------------------------------------------------------

def build_theme(theme):
    root = os.path.join(PACKS, theme)
    assets = os.path.join(root, 'assets')
    if os.path.isdir(assets):
        import shutil
        shutil.rmtree(assets)  # kills any stale old-pack files (e.g. container/*)
    sprite_dir = os.path.join(root, SPR)
    os.makedirs(sprite_dir, exist_ok=True)
    files = {}

    def emit(name, img, meta=None):
        p = os.path.join(sprite_dir, name + '.png')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        img.save(p)
        files[name + '.png'] = img.size
        if meta is not None:
            with open(os.path.join(sprite_dir, name + '.png.mcmeta'), 'w') as f:
                f.write(meta)
            files[name + '.png.mcmeta'] = None

    # buttons
    emit('widget/button', make_button(theme, 'normal'),
         mcmeta(200, 20, 3))
    emit('widget/button_disabled', make_button(theme, 'disabled'),
         mcmeta(200, 20, 3))
    N_FR = 8
    emit('widget/button_highlighted',
         strip([make_button(theme, 'highlighted', frame=f, frames=N_FR) for f in range(N_FR)]),
         mcmeta(200, 20, 3, animated=True, frametime=2, frames_n=N_FR, interpolate=True))

    # checkboxes
    for st in ('checkbox', 'checkbox_highlighted', 'checkbox_selected', 'checkbox_selected_highlighted'):
        emit(f'widget/{st}', make_checkbox(theme, st.split('_', 1)[1] if '_' in st.replace('checkbox_', '', 1) else st))

    # sliders
    emit('widget/slider', make_slider_track(theme, False), mcmeta(200, 20, 3))
    emit('widget/slider_highlighted', make_slider_track(theme, True), mcmeta(200, 20, 3))
    emit('widget/slider_handle', make_slider_handle(theme, False), mcmeta(8, 20, {'left': 2, 'top': 2, 'right': 2, 'bottom': 3}))
    HN = 6
    emit('widget/slider_handle_highlighted',
         strip([make_slider_handle(theme, True, frame=f, frames=HN) for f in range(HN)]),
         mcmeta(8, 20, {'left': 2, 'top': 2, 'right': 2, 'bottom': 3}, animated=True, frametime=2, frames_n=HN, interpolate=True))

    # scroller
    emit('widget/scroller', make_scroller(theme, False), mcmeta(6, 32, 1))
    emit('widget/scroller_background', make_scroller(theme, True), mcmeta(6, 32, 1))

    # text fields
    emit('widget/text_field', make_text_field(theme, 'normal'), mcmeta(200, 20, 1))
    TN = 6
    emit('widget/text_field_highlighted',
         strip([make_text_field(theme, 'highlighted', frame=f, frames=TN) for f in range(TN)]),
         mcmeta(200, 20, 1, animated=True, frametime=3, frames_n=TN, interpolate=True))
    emit('widget/preedit', make_text_field(theme, 'highlighted'), mcmeta(200, 20, 1))

    # tooltip
    emit('tooltip/background', make_tooltip(theme, False), mcmeta(100, 100, 9))
    emit('tooltip/frame', make_tooltip(theme, True), mcmeta(100, 100, 9))

    # cross / page / locks
    CN = 5
    emit('widget/cross_button', make_cross(theme, False), None)
    emit('widget/cross_button_highlighted',
         strip([make_cross(theme, True, frame=f, frames=CN) for f in range(CN)]),
         json.dumps({'animation': {'frametime': 3, 'frames': list(range(CN)), 'interpolate': True}}))
    for direction, name in (('backward', 'page_backward'), ('forward', 'page_forward')):
        emit(f'widget/{name}', make_page(theme, direction, False), None)
        emit(f'widget/{name}_highlighted',
             strip([make_page(theme, direction, True, frame=f, frames=CN) for f in range(CN)]),
             json.dumps({'animation': {'frametime': 3, 'frames': list(range(CN)), 'interpolate': True}}))
    for base, locked in (('locked_button', True), ('unlocked_button', False)):
        for st in ('normal', 'highlighted', 'disabled'):
            emit(f'widget/{base}_{st}' if st != 'normal' else f'widget/{base}',
                 make_lock(theme, locked, st), None)

    # pack.mcmeta — wide supported range so it is valid on every 1.20.2+ / 26.x version
    with open(os.path.join(root, 'pack.mcmeta'), 'w') as f:
        f.write(json.dumps({'pack': {
            'pack_format': 34,
            'description': f'NX Interface [{theme}] - futuristic animated 64x widgets by Neurax',
            'supported_formats': {'min_inclusive': 34, 'max_inclusive': 999},
        }}, indent=2))
    files['pack.mcmeta'] = None
    return files

def main():
    for theme in THEMES:
        files = build_theme(theme)
        print(f'{theme}: {len(files)} files')

def verify():
    """Structural verification of the generated packs."""
    from PIL import Image
    ok = True
    vanilla = json.load(open('/home/z/my-project/research/sprite-dims.json'))
    for theme in THEMES:
        root = os.path.join(PACKS, theme)
        pngs = []
        for dirpath, _, fnames in os.walk(root):
            for fn in fnames:
                rel = os.path.relpath(os.path.join(dirpath, fn), root)
                pngs.append(rel.replace('\\', '/'))
        sprites = [p for p in pngs if p.startswith('assets/') and p.endswith('.png')]
        assert not any('container/' in p or 'hud/' in p for p in sprites), f'{theme}: inventory/HUD sprite leaked!'
        for s in sprites:
            full = os.path.join(root, s)
            im = Image.open(full)
            key = s.replace('assets/minecraft/textures/gui/sprites/', '')
            if key in vanilla:
                vw, vh = vanilla[key]
                fw, fh = im.size
                assert fw == vw * X and (fh % vh * X == 0 or fh % (vh * X) == 0), \
                    f'{theme}/{key}: {im.size} != 4x{vanilla[key]}'
                if fh != vh * X:  # animated strip
                    n = fh // (vh * X)
                    assert fh == vh * X * n, f'{theme}/{key}: bad frame strip'
                    mcf = full + '.mcmeta'
                    assert os.path.exists(mcf), f'{theme}/{key}: animated without mcmeta'
                    anim = json.load(open(mcf))['animation']
                    assert len(anim['frames']) == n, f'{theme}/{key}: frames {len(anim["frames"])} != {n}'
        mcmetas = [p for p in pngs if p.endswith('.mcmeta')]
        for m in mcmetas:
            json.load(open(os.path.join(root, m)))
        print(f'{theme}: {len(sprites)} sprites, {len(mcmetas)} mcmeta — structure OK')
    # identical file sets across themes
    sets = []
    for theme in THEMES:
        root = os.path.join(PACKS, theme)
        sets.append({os.path.relpath(os.path.join(dp, fn), root).replace('\\', '/')
                     for dp, _, fns in os.walk(root) for fn in fns})
    assert sets[0] == sets[1] == sets[2] == sets[3], 'theme file sets differ!'
    print('all 4 themes identical file sets — OK')

if __name__ == '__main__':
    main()
    verify()
