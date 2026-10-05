import os
import shutil
import math
import xml.etree.ElementTree as ET
from PIL import Image

def run():
    # Masters are the founder's supplied artwork (5 Oct 2026), kept in
    # assets/brand/masters/. Everything else here is derived from them.
    repo_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    brand_dir = os.path.join(repo_dir, "assets", "brand")
    server_assets_dir = os.path.join(repo_dir, "server", "assets")
    client_public_brand = os.path.join(repo_dir, "server", "client", "public", "brand")
    client_dist_brand = os.path.join(repo_dir, "server", "client", "dist", "brand")
    masters_dir = os.path.join(brand_dir, "masters")
    os.makedirs(client_public_brand, exist_ok=True)

    def master(name):
        im = Image.open(os.path.join(masters_dir, name)).convert("RGBA")
        return im.crop(im.getbbox())

    mark_navy_raw = Image.open(os.path.join(masters_dir, "mark-navy.png")).convert("RGBA")
    mark_blue = master("mark-blue.png")
    mark_white = master("mark-white.png")
    # Primary logo (5 Oct 2026): "DakyX" with the blue X, no "Tech".
    lockup_color = master("primary-on-light.png")  # navy "Daky", blue mark and X
    lockup_dark = master("primary-on-dark.png")    # white "Daky", blue mark and X
    # The light master carries a white "Tech" that ghosts on light grounds: drop it.
    px = lockup_color.load()
    for y in range(lockup_color.height):
        for x in range(lockup_color.width):
            r, g, b, a = px[x, y]
            if a and min(r, g, b) > 200:
                px[x, y] = (0, 0, 0, 0)
    lockup_color = lockup_color.crop(lockup_color.getbbox())

    def make_horizontal_lockup(lockup, canvas_size, **_):
        cw, ch = canvas_size
        pad = round(ch * 0.08)
        scale = min((cw - 2 * pad) / lockup.width, (ch - 2 * pad) / lockup.height)
        scaled = lockup.resize((round(lockup.width * scale), round(lockup.height * scale)), Image.LANCZOS)
        out = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        out.paste(scaled, ((cw - scaled.width) // 2, (ch - scaled.height) // 2), scaled)
        return out

    # 2. Master horizontal lockups (1932x414)
    # Light lockup: Blue mark + Color wordmark (Navy Daky + Blue X + Navy Tech)
    master_light = make_horizontal_lockup(lockup_color, canvas_size=(1932, 414), target_h=250, gap=80)
    master_light.save(os.path.join(brand_dir, "dakyxtech-lockup-on-light.png"))
    master_light.save(os.path.join(brand_dir, "dakyworld-lockup-on-light.png"))
    print("Saved dakyxtech-lockup-on-light.png and dakyworld-lockup-on-light.png")

    # Dark lockup: Blue mark + White Daky + Blue X + White Tech
    master_dark = make_horizontal_lockup(lockup_dark, canvas_size=(1932, 414), target_h=250, gap=80)
    master_dark.save(os.path.join(brand_dir, "dakyxtech-lockup-on-dark.png"))
    master_dark.save(os.path.join(brand_dir, "dakyworld-lockup-on-dark.png"))
    print("Saved dakyxtech-lockup-on-dark.png and dakyworld-lockup-on-dark.png")

    # 3. Header and Footer lockups on dark
    # Header: 566 x 136
    # In header, we use Blue mark + White Daky + Blue X + White Tech
    header_lockup = make_horizontal_lockup(lockup_dark, canvas_size=(566, 136), target_h=86, gap=26)
    header_lockup.save(os.path.join(brand_dir, "header-lockup-on-dark.png"))
    print("Saved header-lockup-on-dark.png (566x136)")

    # Footer: 800 x 192
    footer_lockup = make_horizontal_lockup(lockup_dark, canvas_size=(800, 192), target_h=120, gap=36)
    footer_lockup.save(os.path.join(brand_dir, "footer-lockup-on-dark.png"))
    print("Saved footer-lockup-on-dark.png (800x192)")

    # 4. Standalone marks
    # dakyxtech-mark-on-light.png & dakyxtech-mark-on-dark.png (326 x 182)
    def make_mark_card(mark, canvas_size=(326, 182), target_h=150):
        m_w = round(mark.width * target_h / mark.height)
        scaled = mark.resize((m_w, target_h), Image.LANCZOS)
        card = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
        start_x = (canvas_size[0] - m_w) // 2
        start_y = (canvas_size[1] - target_h) // 2
        card.paste(scaled, (start_x, start_y), scaled)
        return card

    mark_card_light = make_mark_card(mark_blue, (326, 182), 150)
    mark_card_light.save(os.path.join(brand_dir, "dakyxtech-mark-on-light.png"))
    mark_card_light.save(os.path.join(brand_dir, "dakyworld-mark-on-light.png"))

    mark_card_dark = make_mark_card(mark_white, (326, 182), 150)
    mark_card_dark.save(os.path.join(brand_dir, "dakyxtech-mark-on-dark.png"))
    mark_card_dark.save(os.path.join(brand_dir, "dakyworld-mark-on-dark.png"))

    # mark-on-light-96.png and mark-on-dark-96.png (96 x 96)
    def make_square_mark(mark, size=96, padding=12):
        target_w = size - padding * 2
        target_h = round(mark.height * target_w / mark.width)
        if target_h > size - padding * 2:
            target_h = size - padding * 2
            target_w = round(mark.width * target_h / mark.height)
        scaled = mark.resize((target_w, target_h), Image.LANCZOS)
        sq = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        sq.paste(scaled, ((size - target_w) // 2, (size - target_h) // 2), scaled)
        return sq

    mark_sq_light = make_square_mark(mark_blue, 96, 14)
    mark_sq_light.save(os.path.join(brand_dir, "mark-on-light-96.png"))
    mark_sq_light.save(os.path.join(client_public_brand, "mark-on-light-96.png"))

    mark_sq_dark = make_square_mark(mark_white, 96, 14)
    mark_sq_dark.save(os.path.join(brand_dir, "mark-on-dark-96.png"))
    mark_sq_dark.save(os.path.join(client_public_brand, "mark-on-dark-96.png"))

    # 5. Favicons
    # favicon-32.png (light mode: vibrant blue mark)
    fav_32 = make_square_mark(mark_blue, 32, 2)
    fav_32.save(os.path.join(brand_dir, "favicon-32.png"))
    fav_32.save(os.path.join(client_public_brand, "favicon-32.png"))

    # favicon-32-dark.png (dark mode: white mark)
    fav_32_dark = make_square_mark(mark_white, 32, 2)
    fav_32_dark.save(os.path.join(brand_dir, "favicon-32-dark.png"))
    fav_32_dark.save(os.path.join(client_public_brand, "favicon-32-dark.png"))

    # favicon-180.png (Apple touch icon: 180x180 with solid #08101F background)
    fav_180 = Image.new("RGBA", (180, 180), (8, 16, 31, 255))
    mark_180 = make_square_mark(mark_blue, 180, 28)
    fav_180.paste(mark_180, (0, 0), mark_180)
    fav_180.save(os.path.join(brand_dir, "favicon-180.png"))
    fav_180.save(os.path.join(client_public_brand, "favicon-180.png"))
    print("Saved favicons (32, 32-dark, 180)")

    # 6. Avatar and Social Mark (512x512 with solid #08101F background)
    def make_avatar(mark, size=512, padding=80, bg=(8, 16, 31, 255)):
        av = Image.new("RGBA", (size, size), bg)
        sq = make_square_mark(mark, size, padding)
        av.paste(sq, (0, 0), sq)
        return av

    avatar_512 = make_avatar(mark_blue, 512, 90)
    avatar_512.save(os.path.join(brand_dir, "avatar-512.png"))
    avatar_512.save(os.path.join(brand_dir, "og-mark-512.png"))
    print("Saved avatar-512.png and og-mark-512.png")

    # 7. Update og-share.png (1200 x 630)
    og_share_path = os.path.join(brand_dir, "og-share.png")
    if os.path.exists(og_share_path):
        og_img = Image.open(og_share_path).convert("RGBA")
        # In og-share, the logo sits at (82, 71) to (536, 166)
        # Background is dark navy: sample corner near (80, 65)
        bg_col = og_img.getpixel((80, 65))
        # Create patch over old logo
        patch = Image.new("RGBA", (465, 105), bg_col)
        og_img.paste(patch, (80, 65))
        # Generate lockup to fit in (455, 96)
        og_lockup = make_horizontal_lockup(lockup_dark, canvas_size=(455, 96), target_h=68, gap=20)
        og_img.paste(og_lockup, (82, 71), og_lockup)
        og_img.convert("RGB").save(og_share_path)
        print("Updated og-share.png with new logo")

    # 8. Server assets (repo/server/assets/)
    # logo.png: horizontal lockup for letterhead (400x96)
    server_logo = make_horizontal_lockup(lockup_color, canvas_size=(400, 96), target_h=64, gap=18)
    server_logo.save(os.path.join(server_assets_dir, "logo.png"))
    
    # mark.png: 96x96 watermark
    server_mark = make_square_mark(mark_blue, 96, 10)
    server_mark.save(os.path.join(server_assets_dir, "mark.png"))

    # logo-email.png: flattened onto #FFFFFF (400x96)
    email_light = Image.new("RGB", (400, 96), (255, 255, 255))
    email_light.paste(server_logo, (0, 0), server_logo)
    email_light.save(os.path.join(server_assets_dir, "logo-email.png"), optimize=True)

    # logo-email-dark.png: flattened onto #050A14 (400x96)
    email_dark_raw = make_horizontal_lockup(lockup_dark, canvas_size=(400, 96), target_h=64, gap=18)
    email_dark = Image.new("RGB", (400, 96), (5, 10, 20))
    email_dark.paste(email_dark_raw, (0, 0), email_dark_raw)
    email_dark.save(os.path.join(server_assets_dir, "logo-email-dark.png"), optimize=True)
    # OS shell and login lockups (trimmed, ~3.3:1).
    for name, lk in (("lockup-on-dark.png", lockup_dark), ("lockup-on-light.png", lockup_color)):
        h = 120
        lk.resize((round(lk.width * h / lk.height), h), Image.LANCZOS).save(os.path.join(client_public_brand, name))
    print("Saved server assets (logo.png, mark.png, logo-email.png, logo-email-dark.png)")

    # 9. Generate SVG: bimi-logo.svg and favicon.svg
    w_m, h_m = mark_navy_raw.size
    grid = [[mark_navy_raw.getpixel((x, y))[3] > 128 for x in range(w_m)] for y in range(h_m)]

    def get_contours():
        visited_edges = set()
        contours = []
        dirs = [(1,0), (1,1), (0,1), (-1,1), (-1,0), (-1,-1), (0,-1), (1,-1)]
        for y in range(h_m):
            for x in range(w_m):
                if grid[y][x] and not (x > 0 and grid[y][x-1]):
                    start_edge = (x, y)
                    if start_edge not in visited_edges:
                        contour = []
                        curr = (x, y)
                        d = 6
                        contour.append(curr)
                        p = curr
                        start_p = p
                        while True:
                            found = False
                            for i in range(8):
                                next_d = (d + 5 + i) % 8
                                nx, ny = p[0] + dirs[next_d][0], p[1] + dirs[next_d][1]
                                if 0 <= nx < w_m and 0 <= ny < h_m and grid[ny][nx]:
                                    p = (nx, ny)
                                    d = next_d
                                    found = True
                                    break
                            if not found or p == start_p:
                                break
                            contour.append(p)
                        if len(contour) > 50:
                            for pt in contour:
                                visited_edges.add(pt)
                            contours.append(contour)
        return contours

    def rdp(points, epsilon):
        if len(points) < 3: return points
        first, last = points[0], points[-1]
        max_dist, index = 0, 0
        dx, dy = last[0] - first[0], last[1] - first[1]
        norm = math.hypot(dx, dy)
        for i in range(1, len(points) - 1):
            p = points[i]
            dist = math.hypot(p[0]-first[0], p[1]-first[1]) if norm == 0 else abs(dy*p[0] - dx*p[1] + last[0]*first[1] - last[1]*first[0]) / norm
            if dist > max_dist:
                max_dist, index = dist, i
        if max_dist > epsilon:
            return rdp(points[:index+1], epsilon)[:-1] + rdp(points[index:], epsilon)
        return [first, last]

    contours = get_contours()
    simplified = [rdp(c, 0.6) for c in contours]

    # For 512x512 BIMI
    s = 360.0 / 667.0
    off_x = (512 - 360) / 2
    off_y = (512 - 431 * s) / 2

    path_d = []
    for c in simplified:
        cmds = []
        for i, pt in enumerate(c):
            px = round((pt[0] - 29) * s + off_x, 1)
            py = round((pt[1] - 17) * s + off_y, 1)
            if i == 0:
                cmds.append(f"M{px} {py}")
            else:
                cmds.append(f"L{px} {py}")
        cmds.append("Z")
        path_d.append(" ".join(cmds))

    full_path_str = " ".join(path_d)

    bimi_svg = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 512 512">
<title>DakyXTech</title>
<rect width="512" height="512" fill="#FFFFFF"/>
<path fill="#2563EB" fill-rule="evenodd" d="{full_path_str}"/>
</svg>
"""
    bimi_path = os.path.join(brand_dir, "bimi-logo.svg")
    with open(bimi_path, "w", encoding="utf-8") as f:
        f.write(bimi_svg)
    print("Saved bimi-logo.svg")

    # Favicon SVG (transparent background, blue mark)
    favicon_svg = f"""<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<title>DakyXTech Favicon</title>
<path fill="#2563EB" fill-rule="evenodd" d="{full_path_str}"/>
</svg>
"""
    fav_svg_path = os.path.join(brand_dir, "favicon.svg")
    with open(fav_svg_path, "w", encoding="utf-8") as f:
        f.write(favicon_svg)
    print("Saved favicon.svg")

    # 10. Copy client assets to dist if dist exists
    if os.path.exists(client_dist_brand):
        for fname in ["favicon-32.png", "favicon-32-dark.png", "favicon-180.png", "mark-on-dark-96.png", "mark-on-light-96.png"]:
            src = os.path.join(client_public_brand, fname)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(client_dist_brand, fname))
        print("Updated client/dist/brand assets")

    print("Brand assets generated.")

if __name__ == "__main__":
    run()
