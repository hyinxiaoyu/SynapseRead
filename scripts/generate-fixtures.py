#!/usr/bin/env python3
"""Regenerates the binary fixtures in fixtures/documents. Output is deterministic.

Hand-written so the fixtures stay tiny and their exact contents are known to tests.
"""

import struct
import zipfile
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "documents"


def escape(text):
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_page(lines, top=720):
    ops = ["BT", "/F1 14 Tf", "16 TL", f"72 {top} Td"]
    for line in lines:
        ops += [f"({escape(line)}) Tj", "T*"]
    ops.append("ET")
    return "\n".join(ops)


def build_pdf():
    pages = [
        (612, 792, text_page([
            "SynapseRead PDF fixture",
            "",
            "The quick brown fox jumps over the lazy dog.",
            "Pack my box with five dozen liquor jugs.",
            "How vexingly quick daft zebras jump!",
        ])),
        (612, 792, text_page([f"Filler line {n} on the second page." for n in range(1, 30)])),
        # A solid box, so a rectangle capture has known pixels to contain.
        (612, 792, "0.1 0.4 0.8 rg\n150 400 200 150 re\nf\n"
                   + text_page(["The third page has a blue box below this line."])),
        # A different page size, so anchors must normalize per page.
        (420, 595, text_page(["A smaller page.", "The final target sentence is here."], top=500)),
        # A non-embedded CJK font, which only renders if the CMap files can load.
        (612, 792, "BT\n/F2 18 Tf\n72 700 Td\n<6C49 5B57 76EE 6807>Tj\nET"),
    ]

    objects = {}
    objects[1] = b"<</Type/Catalog/Pages 2 0 R/Outlines 17 0 R>>"
    objects[3] = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>"
    objects[4] = (b"<</Type/Font/Subtype/Type0/BaseFont/STSong-Light/Encoding/UniGB-UCS2-H"
                  b"/DescendantFonts[5 0 R]>>")
    objects[5] = (b"<</Type/Font/Subtype/CIDFontType0/BaseFont/STSong-Light"
                  b"/CIDSystemInfo<</Registry(Adobe)/Ordering(GB1)/Supplement 2>>"
                  b"/FontDescriptor 6 0 R>>")
    objects[6] = (b"<</Type/FontDescriptor/FontName/STSong-Light/Flags 6"
                  b"/FontBBox[-25 -254 1000 880]/ItalicAngle 0/Ascent 880/Descent -120"
                  b"/CapHeight 880/StemV 93>>")
    kids = []
    next_id = 7
    for index, (width, height, content) in enumerate(pages):
        page_id, content_id = next_id, next_id + 1
        next_id += 2
        kids.append(f"{page_id} 0 R")
        annots_entry = "/Annots[21 0 R 22 0 R 23 0 R]" if index == 0 else ""
        objects[page_id] = (
            f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 {width} {height}]"
            f"/Resources<</Font<</F1 3 0 R/F2 4 0 R>>>>{annots_entry}/Contents {content_id} 0 R>>"
        ).encode()
        data = content.encode("latin-1")
        objects[content_id] = b"<</Length %d>>\nstream\n%s\nendstream" % (len(data), data)
    objects[2] = f"<</Type/Pages/Kids[{' '.join(kids)}]/Count {len(pages)}>>".encode()
    # Embedded outline tree with a nested entry (Pages 1, 3, and 4 are objects 7, 11, and 13).
    objects[17] = b"<</Type/Outlines/First 18 0 R/Last 20 0 R/Count 3>>"
    objects[18] = (
        b"<</Title(Part One)/Parent 17 0 R/Next 20 0 R"
        b"/First 19 0 R/Last 19 0 R/Count 1/Dest[7 0 R /XYZ 0 792 null]>>"
    )
    objects[19] = b"<</Title(Blue Box Section)/Parent 18 0 R/Dest[11 0 R /XYZ 0 792 null]>>"
    objects[20] = b"<</Title(Part Two)/Parent 17 0 R/Prev 18 0 R/Dest[13 0 R /XYZ 0 595 null]>>"
    # Page 1 annotations: internal link partway down Page 4, an embedded Highlight
    # with a note, and an unsupported Stamp.
    objects[21] = (
        b"<</Type/Annot/Subtype/Link/Rect[72 620 260 640]/Border[0 0 0]"
        b"/Dest[13 0 R /XYZ 0 520 null]>>"
    )
    objects[22] = (
        b"<</Type/Annot/Subtype/Highlight/Rect[72 670 300 688]"
        b"/QuadPoints[72 688 300 688 72 670 300 670]/C[1 0.85 0.2]"
        b"/T(Reviewer)/Contents(Embedded PDF review note)>>"
    )
    objects[23] = b"<</Type/Annot/Subtype/Stamp/Rect[420 700 520 740]/Name/Draft>>"
    return serialize_pdf(objects)


def build_labelled_pdf():
    """Six pages printed i, ii, 1, 2, 3, 4: front matter, then the body from 1."""
    labels = ["i", "ii", "1", "2", "3", "4"]
    objects = {}
    # /PageLabels: lower-case roman from the first page, decimal from the third.
    objects[1] = b"<</Type/Catalog/Pages 2 0 R/PageLabels<</Nums[0<</S/r>>2<</S/D>>]>>>>"
    objects[3] = b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>"
    kids = []
    next_id = 4
    for index, label in enumerate(labels):
        page_id, content_id = next_id, next_id + 1
        next_id += 2
        kids.append(f"{page_id} 0 R")
        objects[page_id] = (
            b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]"
            b"/Resources<</Font<</F1 3 0 R>>>>/Contents %d 0 R>>" % content_id
        )
        data = text_page([f"Labelled fixture, printed page {label}",
                          f"Physical page {index + 1} of {len(labels)}."]).encode("latin-1")
        objects[content_id] = b"<</Length %d>>\nstream\n%s\nendstream" % (len(data), data)
    objects[2] = f"<</Type/Pages/Kids[{' '.join(kids)}]/Count {len(labels)}>>".encode()
    return serialize_pdf(objects)


def serialize_pdf(objects):
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for number in sorted(objects):
        offsets[number] = len(out)
        out += b"%d 0 obj\n%s\nendobj\n" % (number, objects[number])
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for number in sorted(objects):
        out += b"%010d 00000 n \n" % offsets[number]
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def tiny_png():
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", 8, 8, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x20\x80\x40" * 8 for _ in range(8))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def chapter(title, body):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{title}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>{body}</body></html>
"""


def build_epub():
    filler = "".join(f"<p>Filler paragraph {n} keeps this chapter long.</p>" for n in range(1, 60))
    files = {
        "META-INF/container.xml": """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles></container>
""",
        "OEBPS/content.opf": """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">synapseread-fixture</dc:identifier>
<dc:title>SynapseRead EPUB fixture</dc:title><dc:language>en</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml" properties="scripted"/>
<item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="img" href="box.png" media-type="image/png"/>
</manifest>
<spine><itemref idref="ch1"/><itemref idref="ch2"/></spine>
</package>
""",
        "OEBPS/nav.xhtml": chapter("Contents", """<nav xmlns:epub="http://www.idpf.org/2007/ops"
epub:type="toc"><ol><li><a href="chapter1.xhtml">One</a><ol><li><a href="chapter1.xhtml#section-1-1">Section 1.1</a></li></ol></li>
<li><a href="chapter2.xhtml">Two</a></li></ol></nav>"""),
        # The script stands in for a hostile book: it must never run.
        "OEBPS/chapter1.xhtml": chapter("One", """<h1>Chapter One</h1>
<script>try { window.parent.__bookScriptRan = true; } catch (e) {}
document.documentElement.setAttribute('data-book-script-ran', 'true');</script>
<p><a href="chapter2.xhtml">Go to Chapter Two</a></p>
<p>The quick brown fox jumps over the lazy dog.</p>
<p>Café, 汉字, and 😀 sit in this second paragraph.</p>
<p>A “curly quote” — an em dash, and we co­operate across a break.
An end-of-line hyphen-
ated word wraps in this paragraph.</p>
<p><img src="box.png" alt="a small box"/></p>
<p><img src="missing.png" alt="" onerror="document.documentElement.setAttribute('data-book-handler-ran', 'true')"/></p>""" + filler + """<h2 id="section-1-1">Section 1.1</h2>"""),
        "OEBPS/chapter2.xhtml": chapter("Two", """<h1>Chapter Two</h1>
<p>The final target sentence is in the second chapter.</p>""" + filler),
        "OEBPS/style.css": "body { font-family: serif; line-height: 1.4; } h1 { color: #204080; }\n",
    }
    path = OUT / "sample.epub"
    with zipfile.ZipFile(path, "w") as archive:
        # The EPUB spec requires this entry first, stored, with no extra fields.
        info = zipfile.ZipInfo("mimetype", date_time=(2026, 1, 1, 0, 0, 0))
        archive.writestr(info, "application/epub+zip", zipfile.ZIP_STORED)
        for name, content in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            archive.writestr(info, content.encode(), zipfile.ZIP_DEFLATED)
        info = zipfile.ZipInfo("OEBPS/box.png", date_time=(2026, 1, 1, 0, 0, 0))
        archive.writestr(info, tiny_png(), zipfile.ZIP_STORED)


def write_epub(path, files, images=()):
    with zipfile.ZipFile(path, "w") as archive:
        # The EPUB spec requires this entry first, stored, with no extra fields.
        info = zipfile.ZipInfo("mimetype", date_time=(2026, 1, 1, 0, 0, 0))
        archive.writestr(info, "application/epub+zip", zipfile.ZIP_STORED)
        for name, content in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            archive.writestr(info, content.encode(), zipfile.ZIP_DEFLATED)
        for name, content in images:
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            archive.writestr(info, content, zipfile.ZIP_STORED)


# Ten short front-matter files, then three chapters of very different lengths: by
# spine file Chapter One opens at 10/13 (77%) of the book, by text at about 2% (#52).
UNEVEN_FRONT_MATTER = [
    ("cover", "Cover", '<p><img src="box.png" alt="Cover"/></p>'),
    ("half-title", "Half Title", "<p>Uneven Lengths</p>"),
    ("frontispiece", "Frontispiece", "<p>A drawing of a long road.</p>"),
    ("title", "Title Page", "<h1>Uneven Lengths</h1><p>A SynapseRead fixture</p>"),
    ("copyright", "Copyright", "<p>Copyright 2026. Made for tests.</p>"),
    ("dedication", "Dedication", "<p>For every reader at 25%.</p>"),
    ("epigraph", "Epigraph", "<p>Not all chapters are equal.</p>"),
    ("contents", "Contents Page", "<p>Chapter One, Two, Three.</p>"),
    ("foreword", "Foreword", "<p>A very short foreword.</p>"),
    ("preface", "Preface", "<p>An even shorter preface.</p>"),
]
# (id, title, paragraphs): each paragraph is 60 characters of text.
UNEVEN_CHAPTERS = [
    ("chapter-one", "Chapter One", 100),
    ("chapter-two", "Chapter Two", 20),
    ("chapter-three", "Chapter Three", 240),
]


def build_uneven_epub():
    files = {
        "META-INF/container.xml": """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles></container>
""",
    }
    manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
                '<item id="img" href="box.png" media-type="image/png"/>']
    spine = []
    toc = []
    for ident, title, body in UNEVEN_FRONT_MATTER:
        files[f"OEBPS/{ident}.xhtml"] = chapter(title, body)
        manifest.append(f'<item id="{ident}" href="{ident}.xhtml" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{ident}"/>')
    toc.append('<li><a href="title.xhtml">Title Page</a></li>')
    for ident, title, paragraphs in UNEVEN_CHAPTERS:
        # "Paragraph 001 of Chapter One keeps this text long enough." padded to 60.
        body = f"<h1>{title}</h1>" + "".join(
            f"<p>{f'Paragraph {n:03d} of {title} adds to its length.'.ljust(60, '.')}</p>"
            for n in range(1, paragraphs + 1)
        )
        files[f"OEBPS/{ident}.xhtml"] = chapter(title, body)
        manifest.append(f'<item id="{ident}" href="{ident}.xhtml" media-type="application/xhtml+xml"/>')
        spine.append(f'<itemref idref="{ident}"/>')
        toc.append(f'<li><a href="{ident}.xhtml">{title}</a></li>')
    files["OEBPS/content.opf"] = f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">synapseread-uneven-fixture</dc:identifier>
<dc:title>Uneven Lengths</dc:title><dc:language>en</dc:language>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta></metadata>
<manifest>
{chr(10).join(manifest)}
</manifest>
<spine>{"".join(spine)}</spine>
</package>
"""
    files["OEBPS/nav.xhtml"] = chapter("Contents", f"""<nav xmlns:epub="http://www.idpf.org/2007/ops"
epub:type="toc"><ol>{"".join(toc)}</ol></nav>""")
    write_epub(OUT / "sample-uneven.epub", files, [("OEBPS/box.png", tiny_png())])


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "sample.pdf").write_bytes(build_pdf())
    (OUT / "sample-labels.pdf").write_bytes(build_labelled_pdf())
    build_epub()
    build_uneven_epub()


if __name__ == "__main__":
    main()
