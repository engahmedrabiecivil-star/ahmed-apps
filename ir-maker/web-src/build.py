import base64, pathlib
root=pathlib.Path(__file__).parent
html=(root/'app.html').read_text(encoding='utf8')
html=html.replace('/*__JSZIP__*/', (root/'jszip.min.js').read_text(encoding='utf8').replace('</script','<\\/script'))
def _ff(fam, f, w):
    return "@font-face{font-family:'%s';src:url(data:font/woff;base64,%s) format('woff');font-weight:%s;font-display:swap}" % (fam, base64.b64encode(f.read_bytes()).decode(), w)
_fd=root/'fonts'
fonts=_ff('Lexend',_fd/'lexend.woff','100 900')+_ff('Plex Arabic',_fd/'plexar-Regular.woff','300 500')+_ff('Plex Arabic',_fd/'plexar-SemiBold.woff','600 800')
html=html.replace('/*__FONTS__*/', fonts)
html=html.replace('/*__ENGINE__*/', (root/'engine.js').read_text(encoding='utf8'))
doc='<!doctype html>\n<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'+html.replace('<div class="wrap">','</head><body>\n<div class="wrap">',1)+'\n</body></html>\n'
out=root.parent/'android/app/src/main/assets'; out.mkdir(exist_ok=True)
(out/'index.html').write_text(doc,encoding='utf8')
print(len(doc))
