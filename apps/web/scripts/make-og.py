# One-off generator for public/og.png (1200x630). Run: python3 scripts/make-og.py  (needs Pillow; not part of the build).
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BG, FG, MUTED, BLUE = (14, 17, 23), (240, 243, 248), (176, 186, 202), (122, 162, 240)
S = 2  # supersample
img = Image.new("RGB", (W * S, H * S), BG)
d = ImageDraw.Draw(img)

def pt(x, y):
    return (x * S, y * S)

# Eye mark (same geometry as src/components/site/logo.tsx, scaled)
cx, cy, k = 190, 250, 6.0
def tx(x, y):
    return pt(cx + (x - 16) * k, cy + (y - 16) * k)
import math
def bez(p0, p1, p2, p3, n=40):
    out = []
    for i in range(n + 1):
        t = i / n
        a = (1 - t) ** 3; b = 3 * (1 - t) ** 2 * t; c = 3 * (1 - t) * t ** 2; e = t ** 3
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1]))
    return out
upper = bez((2, 16), (6, 9.5), (11, 6.5), (16, 6.5)) + bez((16, 6.5), (21, 6.5), (26, 9.5), (30, 16))
lower = bez((30, 16), (26, 22.5), (21, 25.5), (16, 25.5)) + bez((16, 25.5), (11, 25.5), (6, 22.5), (2, 16))
poly = [tx(x, y) for x, y in upper + lower]
d.line(poly + [poly[0]], fill=BLUE, width=int(2.2 * k * S), joint="curve")
r = 5.2 * k
d.ellipse([pt(cx - r, cy - r), pt(cx + r, cy + r)], fill=BLUE)
r2 = 1.7 * k
d.ellipse([pt(cx + 1.9 * k - r2, cy - 1.9 * k - r2), pt(cx + 1.9 * k + r2, cy - 1.9 * k + r2)], fill=BG)

bold = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
reg = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
d.text(pt(360, 130), "ik", font=ImageFont.truetype(bold, 150 * S), fill=FG)
d.text(pt(360, 330), "Controlled access for Claude", font=ImageFont.truetype(bold, 44 * S), fill=FG)
d.text(pt(360, 390), "to your dev workspace.", font=ImageFont.truetype(bold, 44 * S), fill=FG)
d.text(pt(360, 470), "Local-first MCP server. Read-only by default. Free.", font=ImageFont.truetype(reg, 28 * S), fill=MUTED)
d.text(pt(360, 515), "Pre-release. Verified on Linux/WSL.", font=ImageFont.truetype(reg, 24 * S), fill=MUTED)
img = img.resize((W, H), Image.LANCZOS)
img.save("public/og.png", optimize=True)
