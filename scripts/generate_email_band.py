"""The navy header bands: navy, the dot field, and (for email) the white lock-up.

Writes server/assets/email-band.png and server/assets/doc-band.png. The second is
the same band at A4 width with no lock-up, which the Word proposal floats behind
its header (proposalDocx.ts); the PDFs draw theirs as vectors (letterhead.ts).

email-band.png is attached to every message as an inline
part (cid:dakyworld-band) rather than loaded from a server, because a remote
image in an email tells whoever serves it that the message was opened.

Email clients cannot draw the website's CSS dot field, so it is baked into the
picture here. The band is flattened (no transparency) for the same reason the
lock-ups are: see server/assets/README.md.

    python scripts/generate_email_band.py
"""
import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAVY = (9, 24, 51)
DOT = (130, 165, 255)
SCALE = 2                      # drawn at 2x for high-density screens
W, H = 600 * SCALE, 84 * SCALE
STEP = 11 * SCALE              # the website's 11px grid
RADIUS = 1.15 * SCALE
DOT_ALPHA = 0.22

# Soft patches of dots, as the website's mask does — kept to the right so the
# lock-up sits on clean navy. (centre x, centre y, radius x, radius y) as fractions.
PATCHES = [(0.72, 0.45, 0.20, 0.70), (0.92, 0.30, 0.12, 0.60), (0.55, 0.85, 0.14, 0.50)]


def strength(x: float, y: float) -> float:
    best = 0.0
    for cx, cy, rx, ry in PATCHES:
        d = math.hypot((x / W - cx) / rx, (y / H - cy) / ry)
        best = max(best, 1.0 if d < 0.55 else max(0.0, (1 - d) / 0.45))
    return best


def dots(W: int, H: int, step: int, radius: float, patches) -> Image.Image:
    ss = 4
    big = Image.new("RGB", (W * ss, H * ss), NAVY)
    draw = ImageDraw.Draw(big)
    for y in range(step // 2, H, step):
        for x in range(step // 2, W, step):
            best = 0.0
            for cx, cy, rx, ry in patches:
                d = math.hypot((x / W - cx) / rx, (y / H - cy) / ry)
                best = max(best, 1.0 if d < 0.55 else max(0.0, (1 - d) / 0.45))
            a = DOT_ALPHA * best
            if a <= 0.01:
                continue
            colour = tuple(round(n * (1 - a) + d * a) for n, d in zip(NAVY, DOT))
            r = radius * ss
            draw.ellipse((x * ss - r, y * ss - r, x * ss + r, y * ss + r), fill=colour)
    return big.resize((W, H), Image.LANCZOS)


def doc_band() -> None:
    # A4 is 595.28pt wide; the band is 104pt, as in letterhead.ts. 2x.
    W2, H2 = 1191, 208
    band = dots(W2, H2, 15, 1.6, [(0.6, 0.42, 0.16, 0.85), (0.79, 0.72, 0.13, 0.7), (0.5, 0.15, 0.1, 0.55)])
    out = os.path.join(ROOT, "server", "assets", "doc-band.png")
    band.save(out, optimize=True)
    print("saved", out, band.size, os.path.getsize(out), "bytes")


def run() -> None:
    # Dots this small come out as diamonds when drawn at size, so they are
    # drawn four times larger and scaled down.
    ss = 4
    big = Image.new("RGB", (W * ss, H * ss), NAVY)
    draw = ImageDraw.Draw(big)
    for y in range(STEP // 2, H, STEP):
        for x in range(STEP // 2, W, STEP):
            a = DOT_ALPHA * strength(x, y)
            if a <= 0.01:
                continue
            colour = tuple(round(n * (1 - a) + d * a) for n, d in zip(NAVY, DOT))
            r = RADIUS * ss
            draw.ellipse((x * ss - r, y * ss - r, x * ss + r, y * ss + r), fill=colour)
    band = big.resize((W, H), Image.LANCZOS)

    logo = Image.open(os.path.join(ROOT, "assets", "brand", "header-lockup-on-dark.png")).convert("RGBA")
    target_h = 31 * SCALE
    logo = logo.resize((round(logo.width * target_h / logo.height), target_h), Image.LANCZOS)
    band.paste(logo, (32 * SCALE, (H - target_h) // 2), logo)

    out = os.path.join(ROOT, "server", "assets", "email-band.png")
    band.save(out, optimize=True)
    print("saved", out, band.size, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    run()
    doc_band()
