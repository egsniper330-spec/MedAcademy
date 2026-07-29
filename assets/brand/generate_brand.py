"""
MedAcademy Complete Branding System Generator
Generates all brand assets using only Pillow (no external SVG renderer needed).
Identity: Dark navy bg, graduation cap (blue), bold M (white), open book (white), play triangle (blue)
Brand colors: Navy #081A35, Blue #2DA8FF, White #F0F4FF
"""
import os, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = '/workspace/app-czyg340mpc75/assets/brand'
os.makedirs(OUT, exist_ok=True)

# ── Brand palette ────────────────────────────────────────────────────────────
NAVY        = (8,  26, 53,  255)
NAVY_DEEP   = (4,  12, 28,  255)
BLUE        = (45, 168, 255, 255)
BLUE_LIGHT  = (100, 196, 255, 255)
BLUE_DARK   = (30, 120, 200, 255)
WHITE       = (240, 244, 255, 255)
WHITE_PURE  = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)

def aa_circle(draw, cx, cy, r, color):
    draw.ellipse([cx-r, cy-r, cx+r, cy+r], fill=color)

def rounded_rect(draw, x, y, w, h, r, color):
    draw.rounded_rectangle([x, y, x+w, y+h], radius=r, fill=color)

# ─────────────────────────────────────────────────────────────────────────────
# HELPER: draw the core mark (cap + M + book + play) onto any canvas
# s = scale factor (1.0 = 200px design grid)
# ─────────────────────────────────────────────────────────────────────────────
def draw_mark(draw, ox, oy, s, cap_color, m_color, book_color, play_color, shadow=False):
    """Draw the complete MedAcademy mark.
    ox,oy = top-left origin of the 200×200 design grid
    s     = scale (pixels per grid unit)
    """
    # ── Graduation cap ───────────────────────────────────────────────────────
    # Mortarboard: flat top diamond + hanging tassel brim
    # Board (diamond shape centered at 100,42)
    cx, cy = ox + 100*s, oy + 42*s
    hw, hh = 52*s, 18*s   # half-width, half-height of diamond
    board = [
        (cx,       cy - hh),   # top
        (cx + hw,  cy),        # right
        (cx,       cy + hh),   # bottom
        (cx - hw,  cy),        # left
    ]
    draw.polygon(board, fill=cap_color)

    # Brim cylinder (trapezoid below diamond)
    brim_top_w = 70*s
    brim_bot_w = 60*s
    brim_h     = 22*s
    brim_y     = cy + hh - 2*s
    brim = [
        (cx - brim_top_w//2, brim_y),
        (cx + brim_top_w//2, brim_y),
        (cx + brim_bot_w//2, brim_y + brim_h),
        (cx - brim_bot_w//2, brim_y + brim_h),
    ]
    draw.polygon(brim, fill=cap_color)

    # Tassel string (right side)
    tx = cx + 48*s
    draw.line([(tx, cy), (tx, cy + 28*s)], fill=cap_color, width=max(2, int(3*s)))
    # Tassel end (small circle)
    aa_circle(draw, int(tx), int(cy + 30*s), max(3, int(5*s)), cap_color)

    # ── Bold M letter ────────────────────────────────────────────────────────
    # Two thick vertical strokes with a V-notch in the center
    mx   = ox + 100*s   # center x
    my   = oy + 96*s    # top of M
    mh   = 62*s         # height of M
    mw   = 64*s         # total width
    sw   = 13*s         # stroke width
    vd   = 28*s         # V notch depth

    # Left stroke
    ls_x = mx - mw//2
    draw.rectangle([ls_x, my, ls_x + sw, my + mh], fill=m_color)
    # Right stroke
    rs_x = mx + mw//2 - sw
    draw.rectangle([rs_x, my, rs_x + sw, my + mh], fill=m_color)
    # Left diagonal (top-left → center-bottom of V)
    draw.polygon([
        (ls_x,        my),
        (ls_x + sw,   my),
        (mx,          my + vd),
        (mx - sw//2,  my + vd),
    ], fill=m_color)
    # Right diagonal (top-right → center-bottom of V)
    draw.polygon([
        (rs_x + sw,   my),
        (rs_x,        my),
        (mx,          my + vd),
        (mx + sw//2,  my + vd),
    ], fill=m_color)

    # ── Open book ────────────────────────────────────────────────────────────
    bk_y  = oy + 148*s
    bk_h  = 30*s
    bk_w  = 80*s
    spine = 4*s

    # Left page (parallelogram slanting outward)
    lp = [
        (mx - spine//2,     bk_y),
        (mx - bk_w,         bk_y + 6*s),
        (mx - bk_w + 4*s,   bk_y + bk_h),
        (mx - spine//2,     bk_y + bk_h - 4*s),
    ]
    draw.polygon(lp, fill=book_color)
    # Right page
    rp = [
        (mx + spine//2,     bk_y),
        (mx + bk_w,         bk_y + 6*s),
        (mx + bk_w - 4*s,   bk_y + bk_h),
        (mx + spine//2,     bk_y + bk_h - 4*s),
    ]
    draw.polygon(rp, fill=book_color)

    # Spine line
    draw.rectangle([mx - spine//2, bk_y, mx + spine//2, bk_y + bk_h], fill=play_color)

    # ── Play triangle (centered over book) ───────────────────────────────────
    pcx, pcy = mx, oy + 163*s
    pr = 14*s
    # Equilateral triangle pointing right
    tri = [
        (pcx - pr*0.6, pcy - pr),
        (pcx + pr,     pcy),
        (pcx - pr*0.6, pcy + pr),
    ]
    draw.polygon(tri, fill=play_color)


# ─────────────────────────────────────────────────────────────────────────────
# 1. APP ICON  1024×1024  (dark navy bg, rounded square look for OS)
# ─────────────────────────────────────────────────────────────────────────────
def make_app_icon():
    SIZE = 1024
    img = Image.new('RGBA', (SIZE, SIZE), (0,0,0,0))
    draw = ImageDraw.Draw(img)

    # Background — deep navy with subtle radial gradient via layers
    bg = Image.new('RGBA', (SIZE, SIZE), NAVY_DEEP)
    # Soft glow center
    for r in range(400, 0, -4):
        alpha = int(18 * (1 - r/400))
        col = (45, 100, 180, alpha)
        draw_bg = ImageDraw.Draw(bg)
        draw_bg.ellipse([SIZE//2-r, SIZE//2-r, SIZE//2+r, SIZE//2+r], fill=col)
    img = Image.alpha_composite(img, bg)
    draw = ImageDraw.Draw(img)

    # Draw mark — scale 4.2 to fill 1024 canvas (design grid = 200px → ×5.12)
    s = 5.12
    ox = (SIZE - 200*s) // 2
    oy = (SIZE - 200*s) // 2 - 20
    draw_mark(draw, ox, oy, s, BLUE, WHITE, WHITE, BLUE_LIGHT)

    img.save(f'{OUT}/icon.png', 'PNG')
    img.save('/workspace/app-czyg340mpc75/assets/icon.png', 'PNG')
    img.save('/workspace/app-czyg340mpc75/assets/adaptive-icon.png', 'PNG')
    print('✓ App icon 1024×1024')


# ─────────────────────────────────────────────────────────────────────────────
# 2. BRAND LOGO — LIGHT MODE  800×240  transparent bg
#    Mark on left, wordmark "MedAcademy" on right
# ─────────────────────────────────────────────────────────────────────────────
def make_logo_light():
    W, H = 800, 240
    img = Image.new('RGBA', (W, H), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    # Mark area: 200×200 centered vertically in left 240px
    s = 1.0
    ox = 20
    oy = (H - 200*s) // 2
    draw_mark(draw, ox, oy, s, (30, 120, 200, 255), (15, 40, 85, 255), (15, 40, 85, 255), (30, 120, 200, 255))

    # Divider
    div_x = 250
    draw.line([(div_x, H//2 - 60), (div_x, H//2 + 60)], fill=(15, 40, 85, 60), width=1)

    # Wordmark — draw letters manually using rectangles (no font file needed)
    # "Med" in bold dark navy, "Academy" in medium navy
    # Use a scaled text rendering approach via PIL's built-in
    # We'll write two lines: "Med" large + "Academy" smaller
    tx = div_x + 30
    ty = H // 2 - 44

    # Line 1: MED — large, ultra-bold, dark navy
    try:
        font_lg = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 72)
        font_sm = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 38)
        font_tag = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 22)
    except:
        font_lg = ImageFont.load_default()
        font_sm = font_lg
        font_tag = font_lg

    draw.text((tx, ty),      'Med',      fill=(8, 26, 53, 255),  font=font_lg)
    draw.text((tx, ty + 76), 'Academy',  fill=(45, 168, 255, 255), font=font_sm)
    draw.text((tx, ty + 122),'Medical Education Platform', fill=(8, 26, 53, 120), font=font_tag)

    img.save(f'{OUT}/logo-light.png', 'PNG')
    print('✓ Logo light 800×240')


# ─────────────────────────────────────────────────────────────────────────────
# 3. BRAND LOGO — DARK MODE  800×240  transparent bg
# ─────────────────────────────────────────────────────────────────────────────
def make_logo_dark():
    W, H = 800, 240
    img = Image.new('RGBA', (W, H), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    # Mark with light colors for dark bg
    s = 1.0
    ox = 20
    oy = (H - 200*s) // 2
    draw_mark(draw, ox, oy, s, (100, 196, 255, 255), (240, 244, 255, 255), (220, 232, 255, 255), (100, 196, 255, 255))

    # Divider
    div_x = 250
    draw.line([(div_x, H//2 - 60), (div_x, H//2 + 60)], fill=(200, 220, 255, 60), width=1)

    tx = div_x + 30
    ty = H // 2 - 44

    try:
        font_lg = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 72)
        font_sm = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 38)
        font_tag = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 22)
    except:
        font_lg = ImageFont.load_default()
        font_sm = font_lg
        font_tag = font_lg

    draw.text((tx, ty),       'Med',      fill=(240, 244, 255, 255),  font=font_lg)
    draw.text((tx, ty + 76),  'Academy',  fill=(100, 196, 255, 255), font=font_sm)
    draw.text((tx, ty + 122), 'Medical Education Platform', fill=(200, 220, 255, 140), font=font_tag)

    img.save(f'{OUT}/logo-dark.png', 'PNG')
    print('✓ Logo dark 800×240')


# ─────────────────────────────────────────────────────────────────────────────
# 4. MONOGRAM  400×400  transparent bg — just the M with subtle cap hint
# ─────────────────────────────────────────────────────────────────────────────
def make_monogram_light():
    SIZE = 400
    img = Image.new('RGBA', (SIZE, SIZE), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    # Larger M centered, with tiny graduation cap above
    s = 1.6
    grid = 200 * s
    ox = (SIZE - grid) / 2
    oy = (SIZE - grid) / 2 + 10
    draw_mark(draw, ox, oy, s, (30, 120, 200, 220), (8, 26, 53, 255), (8, 26, 53, 200), (30, 120, 200, 200))

    img.save(f'{OUT}/monogram-light.png', 'PNG')
    print('✓ Monogram light 400×400')

def make_monogram_dark():
    SIZE = 400
    img = Image.new('RGBA', (SIZE, SIZE), TRANSPARENT)
    draw = ImageDraw.Draw(img)

    s = 1.6
    grid = 200 * s
    ox = (SIZE - grid) / 2
    oy = (SIZE - grid) / 2 + 10
    draw_mark(draw, ox, oy, s, (100, 196, 255, 220), (240, 244, 255, 255), (200, 218, 255, 200), (100, 196, 255, 200))

    img.save(f'{OUT}/monogram-dark.png', 'PNG')
    print('✓ Monogram dark 400×400')


# ─────────────────────────────────────────────────────────────────────────────
# 5. SPLASH  1242×2688  dark navy bg, centered mark + wordmark stacked
# ─────────────────────────────────────────────────────────────────────────────
def make_splash():
    W, H = 1242, 2688
    img = Image.new('RGBA', (W, H), NAVY_DEEP)
    draw = ImageDraw.Draw(img)

    # Radial glow background
    for r in range(600, 0, -6):
        alpha = int(22 * (1 - r/600))
        col = (45, 100, 180, alpha)
        draw.ellipse([W//2-r, H//2-r-200, W//2+r, H//2+r-200], fill=col)

    # Mark — large, centered horizontally, upper-center vertically
    s = 3.2
    grid = 200 * s
    ox = (W - grid) / 2
    oy = H // 2 - grid * 0.8
    draw_mark(draw, ox, oy, s, BLUE_LIGHT, WHITE, WHITE, BLUE_LIGHT)

    # Wordmark below mark
    try:
        font_lg = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 110)
        font_sm = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 58)
        font_tag = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 36)
    except:
        font_lg = font_sm = font_tag = ImageFont.load_default()

    # "Med" + "Academy" on same row, centered
    word_y = oy + grid + 40
    med_w = draw.textlength('Med', font=font_lg)
    acad_w = draw.textlength('Academy', font=font_sm)
    total_w = med_w + 12 + acad_w
    start_x = (W - total_w) / 2

    draw.text((start_x, word_y), 'Med', fill=(240, 244, 255, 255), font=font_lg)
    draw.text((start_x + med_w + 12, word_y + 40), 'Academy', fill=(100, 196, 255, 255), font=font_sm)

    # Tagline
    tag = 'Medical Education Platform'
    tag_w = draw.textlength(tag, font=font_tag)
    draw.text(((W - tag_w)/2, word_y + 130), tag, fill=(150, 180, 220, 160), font=font_tag)

    # Bottom dot indicator
    for i in range(3):
        dx = W//2 + (i-1)*22
        aa_circle(draw, dx, H - 180, 5 if i==1 else 4, (100, 196, 255, 180 if i==1 else 80))

    img.save(f'{OUT}/splash.png', 'PNG')
    print('✓ Splash 1242×2688')


# ─────────────────────────────────────────────────────────────────────────────
# 6. FAVICON  64×64  for web
# ─────────────────────────────────────────────────────────────────────────────
def make_favicon():
    SIZE = 64
    img = Image.new('RGBA', (SIZE, SIZE), NAVY_DEEP)
    draw = ImageDraw.Draw(img)
    s = 0.28
    ox = (SIZE - 200*s) // 2
    oy = (SIZE - 200*s) // 2 - 2
    draw_mark(draw, ox, oy, s, BLUE_LIGHT, WHITE, WHITE, BLUE_LIGHT)
    img.save('/workspace/app-czyg340mpc75/assets/favicon.png', 'PNG')
    img.save(f'{OUT}/favicon.png', 'PNG')
    print('✓ Favicon 64×64')


if __name__ == '__main__':
    make_app_icon()
    make_logo_light()
    make_logo_dark()
    make_monogram_light()
    make_monogram_dark()
    make_splash()
    make_favicon()
    print('\n✅ All brand assets generated.')
