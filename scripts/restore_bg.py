import base64

with open(r'C:\Users\ISURI\.gemini\antigravity\brain\88d3eb7e-d91f-4856-b545-9b0ccda9e8b7\lady_justice_bright_bg_1789491916386.jpg', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

img_code = f"""
    // Lady Justice background (bright purple variant)
    const bgB64 = "data:image/jpeg;base64,{b64}";
    this.doc.addImage(bgB64, "JPEG", 0, 0, pageW, pageH);
"""

insert_point = 'this.doc.rect(0, 0, pageW, pageH, "F");'
text = text.replace(insert_point, insert_point + "\n" + img_code)

with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print("Restored Lady Justice watermark on bright purple background.")
