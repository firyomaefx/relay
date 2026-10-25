from PIL import Image, ImageDraw
import os

SIZE = 256
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded dark tile
draw.rounded_rectangle(
    [6, 6, SIZE - 6, SIZE - 6],
    radius=58,
    fill=(15, 13, 25, 255),
    outline=(58, 50, 88, 255),
    width=3,
)

# Relay glyph: three connected nodes
points = [(78, 176), (128, 82), (178, 176)]
for a, b in [(0, 1), (1, 2), (0, 2)]:
    draw.line([points[a], points[b]], fill=(167, 139, 250, 255), width=11)

for x, y in points:
    r = 18
    draw.ellipse([x - r, y - r, x + r, y + r], fill=(245, 243, 255, 255))

img.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote relay.ico")
