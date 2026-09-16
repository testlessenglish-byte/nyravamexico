import base64
import re

with open(r'C:\Users\ISURI\.gemini\antigravity\brain\88d3eb7e-d91f-4856-b545-9b0ccda9e8b7\lady_justice_bright_bg_1789491916386.jpg', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

text = re.sub(r'const bgB64 = "data:image/jpeg;base64,.*?";', f'const bgB64 = "data:image/jpeg;base64,{b64}";', text)

with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print("Updated background image to bright purple Lady Justice.")
