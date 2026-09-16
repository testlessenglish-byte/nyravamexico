import base64
from PIL import Image, ImageEnhance, ImageDraw

# Open the centered lady justice image
img = Image.open(r'C:\Users\ISURI\.gemini\antigravity\brain\88d3eb7e-d91f-4856-b545-9b0ccda9e8b7\lady_justice_bright_bg_1789491916386.jpg').convert('RGBA')
width, height = img.size

# The base color
target_color = (124, 58, 237, 255)

# Create a solid background
bg = Image.new('RGBA', (width, height), target_color)

# Scale up Lady Justice by 1.5x
new_size = (int(width * 1.5), int(height * 1.5))
lady = img.resize(new_size, Image.Resampling.LANCZOS)

# We want her to be offset to the right side
# Place her so her center is on the right edge or a bit left of it
x_offset = int(width - new_size[0] * 0.45)
y_offset = int((height - new_size[1]) / 2)

# Make her very faded (lower opacity)
# The image itself is mostly the same purple background, so we can blend it using alpha
alpha = lady.split()[3]
alpha = ImageEnhance.Brightness(alpha).enhance(0.4) # fade to 40%
lady.putalpha(alpha)

# Paste onto background
bg.paste(lady, (x_offset, y_offset), lady)

# We need it as RGB JPEG
final = bg.convert('RGB')
final.save('lady_justice_offset.jpg', quality=95)

# Encode to base64
with open('lady_justice_offset.jpg', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')

import re
with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace the base64 string in export.ts
text = re.sub(r'const bgB64 = "data:image/jpeg;base64,.*?";', f'const bgB64 = "data:image/jpeg;base64,{b64}";', text)

with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)

print("Updated image to be offset to the right and faded.")
