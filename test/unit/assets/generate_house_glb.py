#!/usr/bin/env python3
"""
Reused verbatim (fixture + this generator) from the MapLibre Native engine
fork's model-layer test suite: `test/fixtures/model_layer/{house.glb,
generate_house_glb.py}`, branch `upstream-pr/model-layer` @ f1836c1061c5,
`Kotelberg/maplibre-native`. Ported here so the gl-js `loadGlbMesh` unit
tests (`src/render/model/glb_loader.test.ts`) exercise the exact same
CC0/public-domain asset as native's `GlbMeshLoader.*` tests, for direct
loader-output parity. Not modified from the native original.

Generate house.glb: a small, synthesized, CC0/public-domain test fixture for
the `type: "model"` style layer's glTF/GLB loader (src/mbgl/renderer/model/glb_mesh_loader.cpp).

Provenance: 100% procedurally authored by this script (no external model,
texture, or asset was used as a source) -- released to the public domain /
CC0. It is a simple stylized house: a box (walls) + a 4-sided pyramid (roof)
+ a small proud quad (door), so the render test output is visually
recognizable as "a house" rather than an abstract shape.

Deliberately restricted to CORE glTF 2.0 features only (no extensionsUsed /
extensionsRequired, no Draco, no meshopt, no KHR_mesh_quantization) because
the vendored loader uses cgltf without any extension decoders:
  - Single embedded buffer (binary GLB "BIN" chunk, no external URIs).
  - Indices: componentType 5123 (UNSIGNED_SHORT), well under the 65535 cap.
  - Positions/texcoords: componentType 5126 (FLOAT).
  - Materials: plain core `pbrMetallicRoughness` (baseColorFactor, and one
    embedded PNG baseColorTexture on the wall material) -- exactly what
    glb_mesh_loader.cpp reads; nothing else in the material is consulted.
  - One node, one mesh, three primitives (one per material): walls, roof,
    door. No skins, animations, cameras, or lights.

Usage:
    python3 test/fixtures/model_layer/generate_house_glb.py
Regenerates test/fixtures/model_layer/house.glb next to this script.
"""

import json
import os
import struct
import zlib

# ---------------------------------------------------------------------------
# Small dependency-free PNG encoder (stdlib only: zlib + struct), used for the
# one embedded wall texture -- deliberately not pulling in Pillow or any other
# third-party package for a 6-line checkerboard bitmap.
# ---------------------------------------------------------------------------


def make_png(width, height, pixels_rgb):
    """pixels_rgb: row-major list of (r, g, b) uint8 tuples, top-to-bottom."""

    def chunk(tag, data):
        out = struct.pack(">I", len(data)) + tag + data
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return out + struct.pack(">I", crc)

    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None) per scanline
        for x in range(width):
            r, g, b = pixels_rgb[y * width + x]
            raw += bytes((r, g, b))

    compressed = zlib.compress(bytes(raw), 9)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # colour type 2 = RGB

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", compressed)
    png += chunk(b"IEND", b"")
    return png


def make_wall_texture():
    """8x8 warm cream/tan horizontal siding stripes -- just enough pattern to
    visibly exercise the textured baseColor path (vs. the flat-factor-only
    roof/door materials)."""
    cream = (0xE8, 0xDE, 0xC6)
    tan = (0xD8, 0xC8, 0xA0)
    width = height = 8
    pixels = []
    for y in range(height):
        color = cream if (y % 2 == 0) else tan
        pixels.extend([color] * width)
    return make_png(width, height, pixels)


# ---------------------------------------------------------------------------
# Geometry helpers (Y-up, right-handed -- standard glTF convention; the
# loader itself remaps +Y-up -> +Z-up on load).
# ---------------------------------------------------------------------------


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def face_normal(p0, p1, p2):
    n = cross(sub(p1, p0), sub(p2, p0))
    length = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5
    if length == 0:
        return (0.0, 0.0, 0.0)
    return (n[0] / length, n[1] / length, n[2] / length)


class Primitive:
    """Accumulates non-shared (position, uv) vertices + triangle indices for
    one glTF primitive. Winding is verified/auto-corrected per quad/tri
    against an expected outward-facing normal, so face orientation mistakes
    fail loudly (assert) instead of silently baking inside-out lighting."""

    def __init__(self, has_uv):
        self.has_uv = has_uv
        self.positions = []
        self.uvs = []
        self.indices = []

    def _append_triangle(self, p0, p1, p2, uv0, uv1, uv2, expected_normal):
        n = face_normal(p0, p1, p2)
        assert dot(n, expected_normal) > 0.5, (
            f"triangle winding does not match expected outward normal: "
            f"got {n}, expected {expected_normal}"
        )
        base = len(self.positions)
        self.positions.extend((p0, p1, p2))
        if self.has_uv:
            self.uvs.extend((uv0, uv1, uv2))
        self.indices.extend((base, base + 1, base + 2))

    def add_tri(self, p0, p1, p2, expected_normal, uv0=(0.0, 0.0), uv1=(0.0, 0.0), uv2=(0.0, 0.0)):
        self._append_triangle(p0, p1, p2, uv0, uv1, uv2, expected_normal)

    def add_quad(self, p0, p1, p2, p3, expected_normal, uv0=(0.0, 0.0), uv1=(1.0, 0.0), uv2=(1.0, 1.0),
                 uv3=(0.0, 1.0)):
        """p0..p3 must be wound so that (p0,p1,p2) and (p0,p2,p3) are both
        consistent with expected_normal -- auto-flips the whole quad if the
        author passed it backwards, then asserts both triangles agree."""
        n = face_normal(p0, p1, p2)
        if dot(n, expected_normal) < 0:
            p0, p1, p2, p3 = p0, p3, p2, p1
            uv0, uv1, uv2, uv3 = uv0, uv3, uv2, uv1
        self._append_triangle(p0, p1, p2, uv0, uv1, uv2, expected_normal)
        self._append_triangle(p0, p2, p3, uv0, uv2, uv3, expected_normal)


# ---------------------------------------------------------------------------
# Author the house
# ---------------------------------------------------------------------------

# Walls: a closed box, x in [-0.5, 0.5], z in [-0.4, 0.4], y in [0, 0.6].
WX, WZ, WY = 0.5, 0.4, 0.6

wall = Primitive(has_uv=True)

# Front (z = -WZ), normal (0, 0, -1)
wall.add_quad((-WX, 0, -WZ), (WX, 0, -WZ), (WX, WY, -WZ), (-WX, WY, -WZ), (0, 0, -1))
# Back (z = +WZ), normal (0, 0, 1)
wall.add_quad((WX, 0, WZ), (-WX, 0, WZ), (-WX, WY, WZ), (WX, WY, WZ), (0, 0, 1))
# Left (x = -WX), normal (-1, 0, 0)
wall.add_quad((-WX, 0, WZ), (-WX, 0, -WZ), (-WX, WY, -WZ), (-WX, WY, WZ), (-1, 0, 0))
# Right (x = +WX), normal (1, 0, 0)
wall.add_quad((WX, 0, -WZ), (WX, 0, WZ), (WX, WY, WZ), (WX, WY, -WZ), (1, 0, 0))
# Bottom (y = 0), normal (0, -1, 0) -- included for a watertight, replayable mesh.
wall.add_quad((-WX, 0, -WZ), (-WX, 0, WZ), (WX, 0, WZ), (WX, 0, -WZ), (0, -1, 0))
# Top (y = WY), normal (0, 1, 0) -- sits under the roof overhang.
wall.add_quad((-WX, WY, WZ), (-WX, WY, -WZ), (WX, WY, -WZ), (WX, WY, WZ), (0, 1, 0))

# Roof: 4-sided pyramid, base overhangs the walls slightly, apex above center.
RX, RZ, APEX_Y = 0.6, 0.5, 1.0
roof_base = {
    "fl": (-RX, WY, -RZ),
    "fr": (RX, WY, -RZ),
    "br": (RX, WY, RZ),
    "bl": (-RX, WY, RZ),
}
apex = (0.0, APEX_Y, 0.0)

roof = Primitive(has_uv=False)
roof.add_tri(roof_base["fl"], roof_base["fr"], apex, face_normal(roof_base["fl"], roof_base["fr"], apex))
roof.add_tri(roof_base["fr"], roof_base["br"], apex, face_normal(roof_base["fr"], roof_base["br"], apex))
roof.add_tri(roof_base["br"], roof_base["bl"], apex, face_normal(roof_base["br"], roof_base["bl"], apex))
roof.add_tri(roof_base["bl"], roof_base["fl"], apex, face_normal(roof_base["bl"], roof_base["fl"], apex))

# Door: a small quad proud of the front wall face (z slightly < -WZ) so it
# never z-fights with the wall geometry it sits in front of.
DX, DY, DZ = 0.1, 0.35, -WZ - 0.01
door = Primitive(has_uv=False)
door.add_quad((-DX, 0, DZ), (DX, 0, DZ), (DX, DY, DZ), (-DX, DY, DZ), (0, 0, -1))

WALL_TEXTURE_PNG = make_wall_texture()

# ---------------------------------------------------------------------------
# glTF/GLB assembly
# ---------------------------------------------------------------------------

bin_buffer = bytearray()
buffer_views = []


def add_view(data: bytes, target=None):
    # Pad to a 4-byte boundary before appending, matching common exporter
    # convention (not strictly required by the spec for every accessor type,
    # but keeps every bufferView safely aligned).
    while len(bin_buffer) % 4 != 0:
        bin_buffer.append(0)
    offset = len(bin_buffer)
    bin_buffer.extend(data)
    view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
    if target is not None:
        view["target"] = target
    buffer_views.append(view)
    return len(buffer_views) - 1


ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963

accessors = []


def add_accessor(view_index, component_type, count, accessor_type, mins=None, maxs=None):
    acc = {
        "bufferView": view_index,
        "componentType": component_type,
        "count": count,
        "type": accessor_type,
    }
    if mins is not None:
        acc["min"] = mins
    if maxs is not None:
        acc["max"] = maxs
    accessors.append(acc)
    return len(accessors) - 1


def pack_vec3(points):
    return struct.pack(f"<{3 * len(points)}f", *[c for p in points for c in p])


def pack_vec2(points):
    return struct.pack(f"<{2 * len(points)}f", *[c for p in points for c in p])


def pack_indices(indices):
    return struct.pack(f"<{len(indices)}H", *indices)


def minmax_vec3(points):
    xs, ys, zs = zip(*points)
    return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]


def add_primitive(prim: Primitive, material_index: int):
    pos_view = add_view(pack_vec3(prim.positions), ARRAY_BUFFER)
    mins, maxs = minmax_vec3(prim.positions)
    pos_acc = add_accessor(pos_view, 5126, len(prim.positions), "VEC3", mins, maxs)

    attributes = {"POSITION": pos_acc}
    if prim.has_uv:
        uv_view = add_view(pack_vec2(prim.uvs), ARRAY_BUFFER)
        uv_acc = add_accessor(uv_view, 5126, len(prim.uvs), "VEC2")
        attributes["TEXCOORD_0"] = uv_acc

    idx_view = add_view(pack_indices(prim.indices), ELEMENT_ARRAY_BUFFER)
    idx_acc = add_accessor(idx_view, 5123, len(prim.indices), "SCALAR")

    return {
        "attributes": attributes,
        "indices": idx_acc,
        "material": material_index,
        "mode": 4,  # TRIANGLES
    }


image_view = add_view(WALL_TEXTURE_PNG)

gltf = {
    "asset": {
        "version": "2.0",
        "generator": "MapLibre Native model-layer test fixture generator (test/fixtures/model_layer/generate_house_glb.py, CC0/public domain, procedurally authored)",
    },
    "scene": 0,
    "scenes": [{"nodes": [0]}],
    "nodes": [{"mesh": 0}],
    "images": [{"bufferView": image_view, "mimeType": "image/png"}],
    "samplers": [{"magFilter": 9729, "minFilter": 9729, "wrapS": 10497, "wrapT": 10497}],
    "textures": [{"sampler": 0, "source": 0}],
    "materials": [
        {
            "name": "wall",
            "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 1.0, 1.0, 1.0],
                "baseColorTexture": {"index": 0},
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        },
        {
            "name": "roof",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.55, 0.16, 0.14, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        },
        {
            "name": "door",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.30, 0.18, 0.10, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 1.0,
            },
        },
    ],
    "meshes": [
        {
            "name": "house",
            "primitives": [
                add_primitive(wall, 0),
                add_primitive(roof, 1),
                add_primitive(door, 2),
            ],
        }
    ],
    "accessors": accessors,
    "bufferViews": buffer_views,
    "buffers": [{"byteLength": len(bin_buffer)}],
}

json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
while len(json_bytes) % 4 != 0:
    json_bytes += b" "  # JSON chunk padding must use 0x20 per the GLB spec

bin_bytes = bytes(bin_buffer)
while len(bin_bytes) % 4 != 0:
    bin_bytes += b"\x00"  # BIN chunk padding must use 0x00 per the GLB spec

json_chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes  # "JSON"
bin_chunk = struct.pack("<II", len(bin_bytes), 0x004E4942) + bin_bytes  # "BIN\0"

total_length = 12 + len(json_chunk) + len(bin_chunk)
header = struct.pack("<III", 0x46546C67, 2, total_length)  # magic "glTF", version 2

glb = header + json_chunk + bin_chunk

script_dir = os.path.dirname(os.path.abspath(__file__))
out_path = os.path.join(script_dir, "house.glb")
with open(out_path, "wb") as f:
    f.write(glb)

print(f"Written {len(glb)} bytes to {out_path}")
print(f"  Triangles: wall={len(wall.indices)//3} roof={len(roof.indices)//3} door={len(door.indices)//3}")
print("  All face windings verified outward-facing during generation (assertions passed).")
