#!/usr/bin/env python3
"""Generate the Vellox LinkedIn launch image set.

Run with Pillow available on PYTHONPATH. The cards deliberately use only
verified product capabilities and the latest real-project scan summary.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "assets" / "linkedin"
LOGO = ROOT / "public" / "logo-signal-512.png"

WIDTH = 1080
HEIGHT = 1350
PAD = 76

BG = "#060806"
SURFACE = "#0D100D"
SURFACE_2 = "#111510"
GREEN = "#C8FF53"
GREEN_DARK = "#24320F"
WHITE = "#F6F8F1"
MUTED = "#A1A89B"
MUTED_2 = "#70776C"
LINE = "#252B22"

FONT_REGULAR = "/run/host/fonts/google-noto/NotoSans-Regular.ttf"
FONT_BOLD = "/run/host/fonts/google-noto/NotoSans-Bold.ttf"
FONT_MONO = "/run/host/fonts/google-noto/NotoSansMono-Regular.ttf"
FONT_MONO_BOLD = "/run/host/fonts/google-noto/NotoSansMono-Bold.ttf"


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size=size)


def rounded_rectangle(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    radius: int,
    fill: str,
    outline: str | None = None,
    width: int = 1,
) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def base_canvas(accent_x: int = 820, accent_y: int = 120) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    pixels = image.load()

    # Subtle radial signal glow and gentle vertical falloff.
    for y in range(HEIGHT):
        for x in range(WIDTH):
            distance = math.sqrt(((x - accent_x) / 610) ** 2 + ((y - accent_y) / 550) ** 2)
            glow = max(0.0, 1.0 - distance) ** 2
            vertical = max(0.0, 1.0 - y / HEIGHT) * 0.35
            pixels[x, y] = (
                int(6 + 12 * glow + 2 * vertical),
                int(8 + 23 * glow + 3 * vertical),
                int(6 + 5 * glow + 2 * vertical),
            )

    draw = ImageDraw.Draw(image, "RGBA")
    for x in range(0, WIDTH, 54):
        draw.line((x, 0, x, HEIGHT), fill=(200, 255, 83, 8), width=1)
    for y in range(0, HEIGHT, 54):
        draw.line((0, y, WIDTH, y), fill=(200, 255, 83, 6), width=1)

    random.seed(19)
    for _ in range(3600):
        x = random.randrange(WIDTH)
        y = random.randrange(HEIGHT)
        alpha = random.randrange(2, 11)
        draw.point((x, y), fill=(255, 255, 255, alpha))
    return image


def paste_logo(image: Image.Image, x: int, y: int, size: int, glow: bool = True) -> None:
    logo = Image.open(LOGO).convert("RGBA")
    logo.thumbnail((size, size), Image.Resampling.LANCZOS)
    if glow:
        glow_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
        glow_logo = logo.copy()
        glow_logo.putalpha(glow_logo.getchannel("A").point(lambda a: int(a * 0.6)))
        glow_layer.alpha_composite(glow_logo, (x, y))
        glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(28))
        image.paste(glow_layer, (0, 0), glow_layer)
    image.paste(logo, (x, y), logo)


def brand_header(image: Image.Image, index: str) -> None:
    draw = ImageDraw.Draw(image)
    paste_logo(image, PAD - 8, 53, 58, glow=False)
    draw.text((PAD + 62, 66), "VELLOX", font=font(FONT_BOLD, 25), fill=WHITE)
    draw.text((PAD + 62, 99), "LOCAL PERFORMANCE INTELLIGENCE", font=font(FONT_MONO, 12), fill=MUTED_2)
    draw.text((WIDTH - PAD, 71), index, font=font(FONT_MONO_BOLD, 18), fill=GREEN, anchor="ra")
    draw.line((PAD, 142, WIDTH - PAD, 142), fill=LINE, width=1)


def footer(image: Image.Image, text: str = "github.com/Guimenn/Vellox") -> None:
    draw = ImageDraw.Draw(image)
    y = HEIGHT - 82
    draw.line((PAD, y - 28, WIDTH - PAD, y - 28), fill=LINE, width=1)
    draw.ellipse((PAD, y - 1, PAD + 10, y + 9), fill=GREEN)
    draw.text((PAD + 24, y - 8), text, font=font(FONT_MONO, 16), fill=MUTED)
    draw.text((WIDTH - PAD, y - 8), "SOURCE AVAILABLE  /  LOCAL FIRST", font=font(FONT_MONO, 14), fill=MUTED_2, anchor="ra")


def cover() -> Image.Image:
    image = base_canvas(830, 280)
    draw = ImageDraw.Draw(image)
    brand_header(image, "01 / 03")

    paste_logo(image, 642, 184, 360)

    rounded_rectangle(draw, (PAD, 202, 420, 251), 24, GREEN_DARK, outline="#4E681B")
    draw.text((PAD + 21, 218), "EVIDENCE-FIRST  •  100% LOCAL", font=font(FONT_MONO_BOLD, 14), fill=GREEN)

    draw.text((PAD, 341), "Encontre o", font=font(FONT_BOLD, 85), fill=WHITE)
    draw.text((PAD, 435), "gargalo antes", font=font(FONT_BOLD, 85), fill=WHITE)
    draw.text((PAD, 529), "da produção.", font=font(FONT_BOLD, 85), fill=GREEN)

    draw.text(
        (PAD, 678),
        "Scanner estático para riscos de performance\nem Python, JavaScript, TypeScript e SQL.",
        font=font(FONT_REGULAR, 29),
        fill=MUTED,
        spacing=13,
    )

    rounded_rectangle(draw, (PAD, 860, WIDTH - PAD, 998), 24, SURFACE, outline=LINE)
    draw.text((PAD + 32, 889), "EXECUTE NO SEU PROJETO", font=font(FONT_MONO_BOLD, 14), fill=MUTED_2)
    draw.text((PAD + 32, 937), "npx --yes vellox", font=font(FONT_MONO_BOLD, 28), fill=GREEN)
    draw.rounded_rectangle((WIDTH - PAD - 75, 900, WIDTH - PAD - 27, 948), radius=24, outline=GREEN, width=2)
    arrow_x = WIDTH - PAD - 51
    arrow_y = 924
    draw.line((arrow_x - 7, arrow_y + 7, arrow_x + 7, arrow_y - 7), fill=GREEN, width=3)
    draw.line((arrow_x, arrow_y - 7, arrow_x + 7, arrow_y - 7), fill=GREEN, width=3)
    draw.line((arrow_x + 7, arrow_y - 7, arrow_x + 7, arrow_y), fill=GREEN, width=3)

    draw.text((PAD, 1067), "SEM DAEMON", font=font(FONT_MONO_BOLD, 15), fill=WHITE)
    draw.text((PAD + 230, 1067), "SEM CONTA", font=font(FONT_MONO_BOLD, 15), fill=WHITE)
    draw.text((PAD + 425, 1067), "SEM UPLOAD DO CÓDIGO", font=font(FONT_MONO_BOLD, 15), fill=WHITE)
    footer(image)
    return image


def workflow() -> Image.Image:
    image = base_canvas(220, 220)
    draw = ImageDraw.Draw(image)
    brand_header(image, "02 / 03")

    draw.text((PAD, 206), "Do código ao CI", font=font(FONT_BOLD, 70), fill=WHITE)
    draw.text((PAD, 286), "em três comandos.", font=font(FONT_BOLD, 70), fill=GREEN)
    draw.text((PAD, 392), "Comece local. Registre o estado. Proteja cada pull request.", font=font(FONT_REGULAR, 25), fill=MUTED)

    cards = [
        ("01", "SCAN", "Encontra riscos e mostra\na evidência exata.", "npx --yes vellox"),
        ("02", "BASELINE", "Aceita o estado revisado\nsem esconder dívida antiga.", "npx --yes vellox baseline"),
        ("03", "CI", "Cria o gate para impedir\nnovas regressões.", "npx --yes vellox ci"),
    ]
    top = 494
    for offset, (number, label, body, command) in enumerate(cards):
        y = top + offset * 222
        rounded_rectangle(draw, (PAD, y, WIDTH - PAD, y + 186), 22, SURFACE, outline=LINE)
        draw.text((PAD + 29, y + 28), number, font=font(FONT_MONO_BOLD, 16), fill=GREEN)
        draw.text((PAD + 98, y + 24), label, font=font(FONT_BOLD, 23), fill=WHITE)
        draw.text((PAD + 98, y + 62), body, font=font(FONT_REGULAR, 20), fill=MUTED, spacing=6)
        command_x = 565
        draw.rounded_rectangle((command_x, y + 54, WIDTH - PAD - 27, y + 130), radius=14, fill=SURFACE_2, outline="#2D3726")
        draw.text((command_x + 22, y + 92), command, font=font(FONT_MONO_BOLD, 16), fill=GREEN, anchor="lm")

    rounded_rectangle(draw, (PAD, 1172, WIDTH - PAD, 1236), 32, GREEN_DARK, outline="#4E681B")
    draw.text((WIDTH // 2, 1204), "JSON  •  MARKDOWN  •  SARIF  •  GATE", font=font(FONT_MONO_BOLD, 15), fill=GREEN, anchor="mm")
    footer(image)
    return image


def real_result() -> Image.Image:
    image = base_canvas(870, 260)
    draw = ImageDraw.Draw(image)
    brand_header(image, "03 / 03")

    draw.text((PAD, 203), "Teste em projeto real.", font=font(FONT_BOLD, 66), fill=WHITE)
    draw.text((PAD, 281), "Resultado auditável.", font=font(FONT_BOLD, 66), fill=GREEN)
    draw.text((PAD, 380), "Aplicação Next.js com Prisma  •  execução local", font=font(FONT_MONO, 17), fill=MUTED)

    rounded_rectangle(draw, (PAD, 450, WIDTH - PAD, 1032), 24, "#090B09", outline="#2B3327")
    draw.ellipse((PAD + 28, 478, PAD + 40, 490), fill="#FF6B63")
    draw.ellipse((PAD + 50, 478, PAD + 62, 490), fill="#F1C74A")
    draw.ellipse((PAD + 72, 478, PAD + 84, 490), fill=GREEN)
    draw.text((WIDTH - PAD - 28, 485), "VELLOX PROJECT ANALYSIS", font=font(FONT_MONO_BOLD, 13), fill=MUTED_2, anchor="ra")
    draw.line((PAD + 24, 511, WIDTH - PAD - 24, 511), fill=LINE)

    stats = [
        ("72 / 72", "FILES ANALYZED"),
        ("COMPLETE", "COVERAGE"),
        ("0", "CRITICAL"),
        ("1", "HIGH"),
        ("8", "MEDIUM"),
    ]
    stat_x = PAD + 32
    stat_y = 550
    stat_w = (WIDTH - 2 * PAD - 64) // len(stats)
    for i, (value, label) in enumerate(stats):
        x = stat_x + i * stat_w
        draw.text((x, stat_y), value, font=font(FONT_MONO_BOLD, 22), fill=GREEN if i in (0, 1) else WHITE)
        draw.text((x, stat_y + 39), label, font=font(FONT_MONO, 10), fill=MUTED_2)

    rounded_rectangle(draw, (PAD + 28, 660, WIDTH - PAD - 28, 932), 18, SURFACE, outline="#34412A")
    draw.text((PAD + 55, 691), "HIGH", font=font(FONT_MONO_BOLD, 13), fill="#0A0C08", stroke_fill=GREEN, stroke_width=9)
    draw.text((PAD + 55, 750), "Database query fan-out has no", font=font(FONT_BOLD, 25), fill=WHITE)
    draw.text((PAD + 55, 785), "concurrency bound", font=font(FONT_BOLD, 25), fill=WHITE)
    draw.text((PAD + 55, 840), "app/api/dashboard/progress/route.ts:31", font=font(FONT_MONO, 14), fill=GREEN)
    draw.text((PAD + 55, 883), "Promise.all + queries por usuário  →  custo cresce com n", font=font(FONT_MONO, 13), fill=MUTED)

    draw.text((PAD + 30, 967), "Report: .vellox/report.json", font=font(FONT_MONO, 14), fill=MUTED_2)

    rounded_rectangle(draw, (PAD, 1080, WIDTH - PAD, 1183), 18, GREEN_DARK, outline="#4E681B")
    draw.text((PAD + 27, 1104), "RESULTADO HONESTO", font=font(FONT_MONO_BOLD, 13), fill=GREEN)
    draw.text((PAD + 27, 1141), "O scanner encontra o risco. O benchmark confirma o ganho.", font=font(FONT_REGULAR, 21), fill=WHITE)
    footer(image)
    return image


def open_graph_cover() -> Image.Image:
    width = 1200
    height = 630
    image = Image.new("RGB", (width, height), BG)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            distance = math.sqrt(((x - 965) / 630) ** 2 + ((y - 180) / 480) ** 2)
            glow = max(0.0, 1.0 - distance) ** 2
            pixels[x, y] = (int(6 + 11 * glow), int(8 + 24 * glow), int(6 + 5 * glow))
    draw = ImageDraw.Draw(image, "RGBA")
    for x in range(0, width, 54):
        draw.line((x, 0, x, height), fill=(200, 255, 83, 8), width=1)
    for y in range(0, height, 54):
        draw.line((0, y, width, y), fill=(200, 255, 83, 6), width=1)
    logo = Image.open(LOGO).convert("RGBA")
    logo.thumbnail((390, 390), Image.Resampling.LANCZOS)
    glow_layer = Image.new("RGBA", image.size, (0, 0, 0, 0))
    glow_logo = logo.copy()
    glow_logo.putalpha(glow_logo.getchannel("A").point(lambda a: int(a * 0.58)))
    glow_layer.alpha_composite(glow_logo, (770, 112))
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(28))
    image.paste(glow_layer, (0, 0), glow_layer)
    image.paste(logo, (770, 112), logo)

    draw = ImageDraw.Draw(image)
    draw.text((64, 54), "VELLOX", font=font(FONT_BOLD, 28), fill=WHITE)
    draw.text((64, 94), "LOCAL PERFORMANCE INTELLIGENCE", font=font(FONT_MONO, 12), fill=MUTED_2)
    draw.line((64, 130, width - 64, 130), fill=LINE, width=1)
    draw.text((64, 190), "Encontre o gargalo", font=font(FONT_BOLD, 58), fill=WHITE)
    draw.text((64, 260), "antes da produção.", font=font(FONT_BOLD, 58), fill=GREEN)
    draw.text((64, 359), "Python  •  JavaScript  •  TypeScript  •  SQL", font=font(FONT_MONO, 17), fill=MUTED)
    rounded_rectangle(draw, (64, 432, 610, 526), 18, SURFACE, outline=LINE)
    draw.text((92, 462), "npx --yes vellox", font=font(FONT_MONO_BOLD, 24), fill=GREEN)
    draw.text((64, 568), "EVIDENCE-FIRST  /  SOURCE AVAILABLE", font=font(FONT_MONO_BOLD, 13), fill=MUTED_2)
    return image


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    images = {
        "vellox-linkedin-01-cover.png": cover(),
        "vellox-linkedin-02-workflow.png": workflow(),
        "vellox-linkedin-03-real-result.png": real_result(),
    }
    for name, image in images.items():
        target = OUTPUT / name
        image.save(target, format="PNG", optimize=True)
        print(target)
    open_graph_target = ROOT / "public" / "og-vellox.png"
    open_graph_cover().save(open_graph_target, format="PNG", optimize=True)
    print(open_graph_target)


if __name__ == "__main__":
    main()
