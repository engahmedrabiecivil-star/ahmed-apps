import base64, pathlib
root=pathlib.Path(__file__).parent
html=(root/'app.html').read_text(encoding='utf8')
html=html.replace('/*__JSZIP__*/', (root/'jszip.min.js').read_text(encoding='utf8').replace('</script','<\\/script'))
html=html.replace('/*__ENGINE__*/', (root/'engine.js').read_text(encoding='utf8'))
doc='<!doctype html>\n<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'+html.replace('<div class="wrap">','</head><body>\n<div class="wrap">',1)+'\n</body></html>\n'
out=root.parent/'android/app/src/main/assets'; out.mkdir(exist_ok=True)
(out/'index.html').write_text(doc,encoding='utf8')
print(len(doc))
