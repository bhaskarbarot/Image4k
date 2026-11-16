#!/usr/bin/env python3
"""Independent QR decoder for the test suite (zxing-cpp, Apache-2.0).
Usage: python qrdecode.py image.png [more.png ...]  → prints one JSON string (or null) per line.
Setup (once):  python3 -m venv tests/.venv && tests/.venv/bin/pip install -r tests/requirements.txt"""
import json, sys
import zxingcpp
from PIL import Image

for path in sys.argv[1:]:
    img = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', img.size, (255, 255, 255, 255))   # transparent codes are read on white, like paper
    bg.alpha_composite(img)
    res = zxingcpp.read_barcodes(bg.convert('RGB'), formats=zxingcpp.BarcodeFormat.QRCode)
    print(json.dumps(res[0].text if res else None, ensure_ascii=False))
