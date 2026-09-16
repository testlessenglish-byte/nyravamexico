import base64

with open('public/brand/lady-justice-bg.jpg', 'rb') as f:
    b64 = base64.b64encode(f.read()).decode('utf-8')

with open('src/lib/export.ts', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('this.doc.setTextColor(...GOLD);\n    this.doc.text("N", cx, 110,', 'this.doc.setTextColor(255, 255, 255);\n    this.doc.text("N", cx, 110,')

img_code = f"""
    // Lady Justice background
    const bgB64 = "data:image/jpeg;base64,{b64}";
    this.doc.addImage(bgB64, "JPEG", 0, 0, pageW, pageH);
"""

insert_point = 'this.doc.rect(0, 0, pageW, pageH, "F");'
text = text.replace(insert_point, insert_point + "\n" + img_code)

with open('src/lib/export.ts', 'w', encoding='utf-8') as f:
    f.write(text)
print('Updated export.ts with background and white N.')
