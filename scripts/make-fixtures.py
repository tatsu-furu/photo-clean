#!/usr/bin/env python3
"""テスト用の写真（自作のグラデーション）を test/fixtures/ に作る。実在の人や場所は写っていない。
位置情報は、動作の確認のための適当な数値。"""
import io, os, struct
from PIL import Image, ImageCms, PngImagePlugin

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')
os.makedirs(OUT, exist_ok=True)

def picture():
    im = Image.new('RGB', (64, 48))
    px = im.load()
    for y in range(48):
        for x in range(64):
            px[x, y] = (x * 4, y * 5, (x + y) * 2)
    return im

GPS = {0: b'\x02\x03\x00\x00', 1: 'N', 2: (35.0, 10.0, 30.0), 3: 'E', 4: (135.0, 20.0, 15.0), 5: 0, 6: 12.5}

def make_exif():
    ex = Image.Exif()
    ex[0x010F] = 'AcmeCam'
    ex[0x0110] = 'Test Model 1'
    ex[0x0112] = 6
    ex[0x0131] = 'TestSoft 1.0'
    ex[0x0132] = '2026:01:02 03:04:05'
    exif_ifd = ex.get_ifd(0x8769)
    exif_ifd[0x9003] = '2026:01:02 03:04:05'
    exif_ifd[0xA434] = 'Test Lens 35mm'
    exif_ifd[0x927C] = b'MAKERNOTE-' + bytes(range(40))  # 位置がずれないことの確認用
    gps = ex.get_ifd(0x8825)
    gps.update(GPS)
    return ex

XMP = ('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
       '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       '<rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" '
       'xmp:CreatorTool="TestSoft 1.0" exif:GPSLatitude="35,10.5N" exif:GPSLongitude="135,20.25E" exif:DateTimeOriginal="2026-01-02T03:04:05">'
       '<exif:GPSAltitude>25/2</exif:GPSAltitude></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>')

def app_segment(marker, body):
    return bytes([0xFF, marker]) + struct.pack('>H', len(body) + 2) + body

def insert_after_soi(jpeg, segs):
    return jpeg[:2] + b''.join(segs) + jpeg[2:]

icc = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()

# JPEG：EXIF（向き・日時・機種・GPS）＋ICC
buf = io.BytesIO(); picture().save(buf, 'JPEG', quality=90, exif=make_exif(), icc_profile=icc)
base = buf.getvalue()
open(f'{OUT}/exif-gps.jpg', 'wb').write(base)

# JPEG：EXIF ＋ XMP（位置情報あり）＋ IPTC ＋ コメント
xmp = app_segment(0xE1, b'http://ns.adobe.com/xap/1.0/\0' + XMP.encode())
iptc = app_segment(0xED, b'Photoshop 3.0\x008BIM\x04\x04\x00\x00\x00\x00\x00\x08Test IPTC')
com = app_segment(0xFE, b'made by TestSoft')
# APP0/APP1(EXIF) のあとに入れる
pos = 2
while base[pos + 1] in (0xE0, 0xE1):
    pos += 2 + struct.unpack('>H', base[pos + 2:pos + 4])[0]
open(f'{OUT}/exif-xmp.jpg', 'wb').write(base[:pos] + xmp + iptc + com + base[pos:])

# JPEG：メタデータなし
buf = io.BytesIO(); picture().save(buf, 'JPEG', quality=90)
open(f'{OUT}/plain.jpg', 'wb').write(buf.getvalue())

# PNG：eXIf ＋ XMP（iTXt）＋ テキスト
info = PngImagePlugin.PngInfo()
info.add_text('Comment', 'made by TestSoft')
info.add_itxt('XML:com.adobe.xmp', XMP)
picture().save(f'{OUT}/exif-gps.png', 'PNG', exif=make_exif(), pnginfo=info, icc_profile=icc)

# WebP：EXIF ＋ XMP ＋ ICC
picture().save(f'{OUT}/exif-gps.webp', 'WEBP', lossless=True, exif=make_exif(), xmp=XMP.encode(), icc_profile=icc)

# HEIC もどき（先頭だけ）：形式の判定の確認用
open(f'{OUT}/fake.heic', 'wb').write(b'\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic' + b'\x00' * 64)

for n in sorted(os.listdir(OUT)):
    print(f'{n:16} {os.path.getsize(os.path.join(OUT, n)):6} bytes')
