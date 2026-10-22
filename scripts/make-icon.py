"""生成启动器图标（PCL 风格的蓝色方块 + 草方块意象）"""
from PIL import Image, ImageDraw, ImageFont
import os

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角背景渐变
grad = Image.new("RGB", (1, S))
for y in range(S):
    t = y / S
    r = int(46 + (86 - 46) * t)
    g = int(116 + (160 - 116) * t)
    b = int(200 + (232 - 200) * t)
    grad.putpixel((0, y), (r, g, b))
grad = grad.resize((S, S)).convert("RGBA")

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=112, fill=255)
img.paste(grad, (0, 0), mask)

# 高光
hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(hl).ellipse([-160, -230, 430, 300], fill=(255, 255, 255, 40))
img = Image.alpha_composite(img, hl)
d = ImageDraw.Draw(img)


def isometric_block(cx, cy, w, h, top, left, right, outline=None):
    """绘制等距方块：顶面 + 左面 + 右面"""
    tw, th = w / 2, h / 4
    top_pts = [(cx, cy - th * 2), (cx + tw, cy - th), (cx, cy), (cx - tw, cy - th)]
    left_pts = [(cx - tw, cy - th), (cx, cy), (cx, cy + h - th), (cx - tw, cy + h - 2 * th)]
    right_pts = [(cx + tw, cy - th), (cx, cy), (cx, cy + h - th), (cx + tw, cy + h - 2 * th)]
    d.polygon(left_pts, fill=left, outline=outline)
    d.polygon(right_pts, fill=right, outline=outline)
    d.polygon(top_pts, fill=top, outline=outline)


# 草方块
isometric_block(S / 2, 330, 300, 140, (122, 206, 112), (84, 148, 76), (103, 175, 93), (255, 255, 255, 26))

# 白色 P 字母（等距风格块字母）
font_path = r"C:\Windows\Fonts\arialbd.ttf"
try:
    font = ImageFont.truetype(font_path, 232)
except Exception:
    font = ImageFont.load_default()

text = "P"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
tx = (S - tw) / 2 - bbox[0]
ty = 62 - bbox[1]
# 阴影
d.text((tx + 5, ty + 7), text, font=font, fill=(20, 50, 90, 110))
d.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))

os.makedirs("assets", exist_ok=True)
img.save("assets/icon.png")
print("saved assets/icon.png", img.size)
