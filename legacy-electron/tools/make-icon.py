"""生成 assets/icon.png 与 assets/icon.ico（需要 Python 3 + Pillow，Windows 自带微软雅黑）。

大尺寸：蓝色圆角底 + 白纸 + 蓝色「简」+ 斜放的笔；
小尺寸（≤32px）：细节会糊，改用白色「简」单字，保证任务栏里认得出。
用法：python tools/make-icon.py
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'assets')
FONT = 'C:/Windows/Fonts/msyhbd.ttc'
S = 2048  # 超采样画布

BLUE_TOP = (78, 131, 245)
BLUE_BOTTOM = (28, 70, 170)
INK = (35, 82, 196)
LINE = (196, 210, 236)
PEN = (255, 183, 71)
PEN_DARK = (226, 140, 32)
NIB = (52, 58, 72)


def p(v):
    return int(round(S * v))


def background(radius=0.225):
    grad = Image.new('RGB', (1, 256))
    for y in range(256):
        t = y / 255
        grad.putpixel((0, y), tuple(round(BLUE_TOP[i] * (1 - t) + BLUE_BOTTOM[i] * t) for i in range(3)))
    bg = grad.resize((S, S), Image.BICUBIC).convert('RGBA')
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=p(radius), fill=255)
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    im.paste(bg, (0, 0), mask)
    # 顶部一层很淡的高光
    hi = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hi).ellipse([p(-0.3), p(-0.75), p(1.3), p(0.42)], fill=(255, 255, 255, 34))
    hi = hi.filter(ImageFilter.GaussianBlur(p(0.06)))
    hi.putalpha(Image.composite(hi.getchannel('A'), Image.new('L', (S, S), 0), mask))
    im.alpha_composite(hi)
    return im, mask


def shadow(shape_fn, offset, blur, alpha):
    layer = Image.new('L', (S, S), 0)
    shape_fn(ImageDraw.Draw(layer), offset)
    layer = layer.filter(ImageFilter.GaussianBlur(blur))
    sh = Image.new('RGBA', (S, S), (10, 30, 80, 0))
    sh.putalpha(layer.point(lambda a: a * alpha // 255))
    return sh


def draw_text(d, text, box, size, fill):
    font = ImageFont.truetype(FONT, size)
    l, t, r, b = d.textbbox((0, 0), text, font=font)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    d.text((cx - (r - l) / 2 - l, cy - (b - t) / 2 - t), text, font=font, fill=fill)


def pen_polygons(tip, angle_deg, length, width, nib_len):
    a = math.radians(angle_deg)
    ux, uy = math.cos(a), -math.sin(a)  # 笔尖指向笔尾的方向
    nx, ny = -uy, ux
    w = width / 2

    def pt(along, side):
        return (tip[0] + ux * along + nx * side, tip[1] + uy * along + ny * side)

    nib = [pt(0, 0), pt(nib_len, w), pt(nib_len, -w)]
    body = [pt(nib_len, w), pt(length, w), pt(length, -w), pt(nib_len, -w)]
    stripe = [pt(nib_len, w * 0.05), pt(length, w * 0.05), pt(length, -w), pt(nib_len, -w)]
    cap = [pt(length - width * 0.9, w), pt(length, w), pt(length, -w), pt(length - width * 0.9, -w)]
    tip_dot = [pt(0, 0), pt(nib_len * 0.42, w * 0.42), pt(nib_len * 0.42, -w * 0.42)]
    return nib, body, stripe, cap, tip_dot


def big_icon():
    im, mask = background()
    L, T, R, B = p(0.22), p(0.15), p(0.70), p(0.83)
    fold = p(0.13)
    rad = p(0.045)

    def page_shape(d, off):
        ox, oy = off
        d.rounded_rectangle([L + ox, T + oy, R + ox, B + oy], radius=rad, fill=255)

    im.alpha_composite(shadow(page_shape, (p(0.012), p(0.03)), p(0.03), 110))

    page = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    pd = ImageDraw.Draw(page)
    pd.rounded_rectangle([L, T, R, B], radius=rad, fill=(255, 255, 255, 255))
    # 折角：先把右上角挖掉，再画一个浅蓝三角
    cut = Image.new('L', (S, S), 255)
    ImageDraw.Draw(cut).polygon([(R - fold, T - 2), (R + 2, T - 2), (R + 2, T + fold)], fill=0)
    page.putalpha(Image.composite(page.getchannel('A'), Image.new('L', (S, S), 0), cut))
    pd = ImageDraw.Draw(page)
    pd.polygon([(R - fold, T), (R - fold, T + fold), (R, T + fold)], fill=(215, 226, 248, 255))
    im.alpha_composite(page)

    d = ImageDraw.Draw(im)
    draw_text(d, '简', (L, T + p(0.03), R - p(0.02), T + p(0.40)), p(0.25), INK + (255,))
    # 三行"文字"
    for i, (x2, y) in enumerate([(R - p(0.07), 0.585), (R - p(0.07), 0.655), (L + p(0.25), 0.725)]):
        y = p(y)
        d.rounded_rectangle([L + p(0.07), y, x2, y + p(0.026)], radius=p(0.013), fill=LINE + (255,))

    # 笔：笔尖落在最后一行末尾，向右上斜放
    tip = (L + p(0.275), p(0.738))
    nib, body, stripe, cap, tip_dot = pen_polygons(tip, 48, p(0.50), p(0.105), p(0.12))

    def pen_shape(dd, off):
        ox, oy = off
        dd.polygon([(x + ox, y + oy) for x, y in nib + body], fill=255)

    im.alpha_composite(shadow(pen_shape, (p(0.01), p(0.025)), p(0.02), 120))
    pen = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    pe = ImageDraw.Draw(pen)
    pe.polygon(nib, fill=(250, 236, 214, 255))
    pe.polygon(tip_dot, fill=NIB + (255,))
    pe.polygon(body, fill=PEN + (255,))
    pe.polygon(stripe, fill=PEN_DARK + (255,))
    pe.polygon(cap, fill=(68, 76, 96, 255))
    # 笔超出底板的部分裁掉
    pen.putalpha(Image.composite(pen.getchannel('A'), Image.new('L', (S, S), 0), mask))
    im.alpha_composite(pen)
    return im


def small_icon():
    im, _ = background(radius=0.2)
    draw_text(ImageDraw.Draw(im), '简', (0, p(0.02), S, S), p(0.66), (255, 255, 255, 255))
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    big = big_icon().resize((1024, 1024), Image.LANCZOS)
    small = small_icon()
    big.save(os.path.join(OUT, 'icon.png'))
    frames = []
    for size in (16, 24, 32, 48, 64, 128, 256):
        src = small if size <= 32 else big
        frames.append(src.resize((size, size), Image.LANCZOS))
    frames[-1].save(os.path.join(OUT, 'icon.ico'), format='ICO',
                    sizes=[f.size for f in frames], append_images=frames[:-1])
    print('ok', os.path.abspath(OUT))


if __name__ == '__main__':
    main()
