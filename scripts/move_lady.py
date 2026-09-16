import base64
from PIL import Image, ImageEnhance

img = Image.open(r'C:\Users\ISURI\.gemini\antigravity\brain\88d3eb7e-d91f-4856-b545-9b0ccda9e8b7\lady_justice_bright_bg_1789491916386.jpg').convert('RGBA')
width, height = img.size

target_color = (124, 58, 237, 255)
bg = Image.new('RGBA', (width, height), target_color)

new_size = (int(width * 1.5), int(height * 1.5))
lady = img.resize(new_size, Image.Resampling.LANCZOS)

x_offset = int(width - new_size[0] * 0.65)
y_offset = int((height - new_size[1]) / 2)

alpha = lady.split()[3]
alpha = ImageEnhance.Brightness(alpha).enhance(0.4)
lady.putalpha(alpha)

bg.paste(lady, (x_offset, y_offset), lady)

final = bg.convert('RGB')
final.save('lady_justice_offset_2.jpg', quality=95)

with open('lady_justice_offset_2.jpg', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')

import re
with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

text = re.sub(r'const bgB64 = "data:image/jpeg;base64,.*?";', f'const bgB64 = "data:image/jpeg;base64,{b64}";', text)

with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)

print('Updated offset')
