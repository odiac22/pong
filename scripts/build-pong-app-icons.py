from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent

for instance, color in ((1, (21, 112, 239)), (2, (124, 58, 237))):
    image = Image.new("RGBA", (256, 256), (5, 10, 19, 255))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((12, 12, 244, 244), radius=52, fill=(10, 18, 32), outline=color, width=10)
    draw.line((47, 72, 47, 184), fill=color, width=13)
    draw.line((47, 72, 124, 72), fill=color, width=13)
    draw.arc((82, 67, 164, 149), -90, 90, fill=color, width=13)
    draw.line((124, 144, 47, 144), fill=color, width=13)
    draw.ellipse((155, 137, 229, 211), fill=color, outline=(225, 240, 255), width=5)
    try:
        font = ImageFont.truetype("arialbd.ttf", 47)
    except OSError:
        font = ImageFont.load_default()
    label = str(instance)
    box = draw.textbbox((0, 0), label, font=font)
    x = 192 - (box[2] - box[0]) / 2
    y = 174 - (box[3] - box[1]) / 2 - box[1]
    draw.text((x, y), label, font=font, fill="white")
    image.save(ROOT / f"pong-{instance}-icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
