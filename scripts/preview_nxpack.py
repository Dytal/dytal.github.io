#!/usr/bin/env python3
# preview_nxpack.py — contact sheet of the NX pack sprites for visual review
import os, sys, json
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_nx_art import THEMES

PACKS = '/home/z/my-project/neurax-launcher/src/main/clientpacks'
X = 4

ORDER = [
    ('widget/button', 'button'), ('widget/button_highlighted', 'button_hi [anim 8f]'),
    ('widget/button_disabled', 'button_disabled'),
    ('widget/checkbox', 'checkbox'), ('widget/checkbox_highlighted', 'checkbox_hi'),
    ('widget/checkbox_selected', 'checkbox_sel'), ('widget/checkbox_selected_highlighted', 'checkbox_sel_hi'),
    ('widget/slider', 'slider track'), ('widget/slider_highlighted', 'slider_hi'),
    ('widget/slider_handle', 'handle'), ('widget/slider_handle_highlighted', 'handle_hi [anim 6f]'),
    ('widget/scroller', 'scroller thumb'), ('widget/scroller_background', 'scroller bg'),
    ('widget/text_field', 'text_field'), ('widget/text_field_highlighted', 'text_field_hi [anim 6f]'),
    ('widget/cross_button', 'cross'), ('widget/cross_button_highlighted', 'cross_hi [anim 5f]'),
    ('widget/page_backward', 'page_back'), ('widget/page_backward_highlighted', 'page_back_hi [anim]'),
    ('widget/page_forward', 'page_fwd'), ('widget/page_forward_highlighted', 'page_fwd_hi [anim]'),
    ('widget/locked_button', 'locked'), ('widget/locked_button_highlighted', 'locked_hi'),
    ('widget/locked_button_disabled', 'locked_dis'),
    ('widget/unlocked_button', 'unlocked'), ('widget/unlocked_button_highlighted', 'unlocked_hi'),
    ('tooltip/background', 'tooltip bg'), ('tooltip/frame', 'tooltip frame'),
]

def last_frame(path):
    im = Image.open(path).convert('RGBA')
    w, h = im.size
    return im.crop((0, 0, w, min(h, w)))  # for strips just show first frame area

def main():
    theme = 'purple'
    root = os.path.join(PACKS, theme)
    COLS = 4
    CELL_W, CELL_H = 460, 130
    rows = (len(ORDER) + COLS - 1) // COLS
    W, H = COLS * CELL_W + 40, rows * CELL_H + 60
    sheet = Image.new('RGBA', (W, H), (18, 20, 27, 255))
    d = ImageDraw.Draw(sheet)
    d.text((20, 14), f'NX Interface [{theme}] — 4x sprites preview', fill=(240, 242, 248, 255))
    for i, (name, label) in enumerate(ORDER):
        cx, cy = 20 + (i % COLS) * CELL_W, 44 + (i // COLS) * CELL_H
        d.rectangle([cx, cy, cx + CELL_W - 16, cy + CELL_H - 16], fill=(12, 14, 20, 255),
                    outline=(40, 44, 56, 255))
        p = os.path.join(root, 'assets/minecraft/textures/gui/sprites', name + '.png')
        if os.path.exists(p):
            im = Image.open(p).convert('RGBA')
            # scale down to fit cell (max width 260, max height 56)
            sc = min(260 / im.width, 56 / im.height, 1.0)
            im2 = im.resize((max(1, int(im.width * sc)), max(1, int(im.height * sc))), Image.NEAREST)
            sheet.alpha_composite(im2, (cx + 12, cy + 10))
            d.text((cx + 12, cy + CELL_H - 34), f'{label}  {im.size[0]}x{im.size[1]}', fill=(150, 156, 170, 255))
        else:
            d.text((cx + 12, cy + 10), 'MISSING', fill=(255, 90, 90, 255))
    out = '/home/z/my-project/research/preview-nx-purple.png'
    sheet.convert('RGB').save(out)
    print('preview ->', out)

if __name__ == '__main__':
    main()
