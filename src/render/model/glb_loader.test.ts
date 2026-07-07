import path from 'path';
import {readFileSync} from 'fs';
import {describe, expect, test} from 'vitest';
import {loadGlbMesh, MAX_PART_VERTICES, MODEL_VERTEX_FLOATS, type BakedModel} from './glb_loader';

// test/unit/assets/house.glb (+ generate_house_glb.py alongside it) is a
// procedurally-authored, CC0/public-domain fixture reused verbatim from
// MapLibre Native's model-layer test suite (branch `upstream-pr/model-layer`
// @ f1836c1061c5, `Kotelberg/maplibre-native`): a box (walls, textured) + a
// 4-sided pyramid (roof, flat color) + a small proud quad (door, flat
// color) -- 3 materials total, core glTF 2.0 only (no draco, no meshopt, no
// KHR_mesh_quantization), uint16 indices throughout. See that repo's
// `test/renderer/model/glb_mesh_loader.test.cpp` for the native assertions
// this test mirrors.
const HOUSE_GLB_PATH = path.join(__dirname, '../../../test/unit/assets/house.glb');

function readFixture(relativePath: string): ArrayBuffer {
    const buf = readFileSync(relativePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function nearlyEqual(a: number, b: number, eps = 1e-4): boolean {
    return Math.abs(a - b) <= eps;
}

// ---------------------------------------------------------------------------
// Minimal synthetic-GLB builder, for the container/edge-case tests below.
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BIN_CHUNK = 0x004e4942;

function padTo4(bytes: Uint8Array, padByte: number): Uint8Array {
    if (bytes.byteLength % 4 === 0) return bytes;
    const padded = new Uint8Array(Math.ceil(bytes.byteLength / 4) * 4);
    padded.fill(padByte);
    padded.set(bytes);
    return padded;
}

/** Assemble a GLB `ArrayBuffer` from a glTF JSON object and an optional BIN chunk. */
function buildGlb(gltf: unknown, bin?: Uint8Array): ArrayBuffer {
    const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(gltf)), 0x20);
    const binBytes = bin ? padTo4(bin, 0x00) : new Uint8Array(0);
    const hasBin = binBytes.byteLength > 0;
    const totalLength = 12 + 8 + jsonBytes.byteLength + (hasBin ? 8 + binBytes.byteLength : 0);

    const buffer = new ArrayBuffer(totalLength);
    const dv = new DataView(buffer);
    let offset = 0;
    dv.setUint32(offset, GLB_MAGIC, true); offset += 4;
    dv.setUint32(offset, 2, true); offset += 4;
    dv.setUint32(offset, totalLength, true); offset += 4;

    dv.setUint32(offset, jsonBytes.byteLength, true); offset += 4;
    dv.setUint32(offset, GLB_JSON_CHUNK, true); offset += 4;
    new Uint8Array(buffer, offset, jsonBytes.byteLength).set(jsonBytes); offset += jsonBytes.byteLength;

    if (hasBin) {
        dv.setUint32(offset, binBytes.byteLength, true); offset += 4;
        dv.setUint32(offset, GLB_BIN_CHUNK, true); offset += 4;
        new Uint8Array(buffer, offset, binBytes.byteLength).set(binBytes); offset += binBytes.byteLength;
    }

    return buffer;
}

/** One upward-facing (map-frame +z normal) triangle per entry in `heights` (varying the
 * original glTF Y so the baked bounding box has nonzero height), sharing one accessor. */
function upwardTrianglesGltf(heights: number[], extra: Record<string, unknown> = {}): {gltf: unknown; bin: Uint8Array} {
    const floats: number[] = [];
    for (const y of heights) {
        floats.push(0, y, 0, 0, y, 1, 1, y, 0);
    }
    const positions = new Float32Array(floats);
    const bin = new Uint8Array(positions.buffer);
    const count = heights.length * 3;
    const gltf = {
        asset: {version: '2.0'},
        scene: 0,
        scenes: [{nodes: [0]}],
        nodes: [{mesh: 0}],
        meshes: [{primitives: [{attributes: {POSITION: 0}, mode: 4}]}],
        accessors: [{bufferView: 0, componentType: 5126, count, type: 'VEC3'}],
        bufferViews: [{buffer: 0, byteOffset: 0, byteLength: bin.byteLength}],
        buffers: [{byteLength: bin.byteLength}],
        ...extra,
    };
    return {gltf, bin};
}

function base64Encode(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

describe('loadGlbMesh — house.glb fixture (native loader-test parity)', () => {
    test('loads the fixture with 5 parts, matching native GlbMeshLoader.LoadsHouseFixture', async () => {
        const model: BakedModel = await loadGlbMesh(readFixture(HOUSE_GLB_PATH));

        expect(model.valid).toBe(true);
        // 3 materials (wall/roof/door); the wall's 12 triangles further split across
        // per-triangle baked-lambert shade buckets, so there are more than 3 parts overall.
        expect(model.parts).toHaveLength(5);

        let totalVertices = 0;
        let totalIndices = 0;
        let texturedParts = 0;
        let untexturedParts = 0;
        let minZ = Infinity;
        let maxZ = -Infinity;
        let foundRoofColor = false;
        let foundDoorColor = false;

        for (const part of model.parts) {
            expect(part.vertexCount).toBeGreaterThan(0);
            expect(part.indexCount).toBeGreaterThan(0);
            // Every part is triangle-soup with no shared vertices in this fixture: one
            // index per emitted vertex, in multiples of 3.
            expect(part.indexCount).toBe(part.vertexCount);
            expect(part.indexCount % 3).toBe(0);
            expect(part.vertices.length).toBe(part.vertexCount * MODEL_VERTEX_FLOATS);

            for (let i = 0; i < part.indices.length; i++) {
                expect(part.indices[i]).toBeLessThan(part.vertexCount);
            }

            totalVertices += part.vertexCount;
            totalIndices += part.indexCount;

            const [r, g, b, a] = part.color;
            if (part.texture) {
                texturedParts++;
                // Wall material's baseColorFactor is [1,1,1,1] (white) -- the baked-lambert
                // shade scales r/g/b uniformly, so they must stay equal.
                expect(nearlyEqual(r, g)).toBe(true);
                expect(nearlyEqual(g, b)).toBe(true);
                expect(a).toBeCloseTo(1.0, 5);
            } else {
                untexturedParts++;
                expect(a).toBeCloseTo(1.0, 5);
                expect(r).toBeGreaterThan(0);
                const gOverR = g / r;
                const bOverR = b / r;
                // roof: baseColorFactor [0.55, 0.16, 0.14, 1.0]
                if (nearlyEqual(gOverR, 0.16 / 0.55, 1e-3) && nearlyEqual(bOverR, 0.14 / 0.55, 1e-3)) {
                    foundRoofColor = true;
                }
                // door: baseColorFactor [0.30, 0.18, 0.10, 1.0]
                if (nearlyEqual(gOverR, 0.18 / 0.30, 1e-3) && nearlyEqual(bOverR, 0.10 / 0.30, 1e-3)) {
                    foundDoorColor = true;
                }
            }

            for (let i = 0; i < part.vertexCount; i++) {
                const z = part.vertices[i * MODEL_VERTEX_FLOATS + 2];
                minZ = Math.min(minZ, z);
                maxZ = Math.max(maxZ, z);
            }
        }

        // 3 wall shading buckets (textured), roof + door (flat color, no texture).
        expect(texturedParts).toBe(3);
        expect(untexturedParts).toBe(2);
        expect(foundRoofColor).toBe(true);
        expect(foundDoorColor).toBe(true);

        // wall (12 tri) + roof (4 tri) + door (2 tri) = 18 triangles = 54 verts/indices.
        expect(totalVertices).toBe(54);
        expect(totalIndices).toBe(54);

        // Base-centered, height normalized to exactly [0, 1].
        expect(nearlyEqual(minZ, 0.0, 1e-3)).toBe(true);
        expect(nearlyEqual(maxZ, 1.0, 1e-3)).toBe(true);
    });
});

describe('loadGlbMesh — GLB container edge cases', () => {
    test('rejects a buffer with the wrong magic', async () => {
        const buffer = new ArrayBuffer(20);
        new DataView(buffer).setUint32(0, 0xdeadbeef, true);
        const model = await loadGlbMesh(buffer);
        expect(model.valid).toBe(false);
        expect(model.parts).toEqual([]);
    });

    test('rejects a buffer shorter than the GLB header', async () => {
        const model = await loadGlbMesh(new ArrayBuffer(4));
        expect(model.valid).toBe(false);
        expect(model.parts).toEqual([]);
    });

    test('rejects a truncated GLB (declared length exceeds the buffer)', async () => {
        const full = readFixture(HOUSE_GLB_PATH);
        const truncated = full.slice(0, full.byteLength - 100);
        const model = await loadGlbMesh(truncated);
        expect(model.valid).toBe(false);
    });

    test('rejects an unsupported GLB version', async () => {
        const buffer = readFixture(HOUSE_GLB_PATH).slice(0);
        new DataView(buffer).setUint32(4, 3, true); // version 3
        const model = await loadGlbMesh(buffer);
        expect(model.valid).toBe(false);
    });

    test('rejects malformed JSON in the JSON chunk', async () => {
        const jsonBytes = new TextEncoder().encode('{not valid json');
        const totalLength = 12 + 8 + jsonBytes.byteLength;
        const bad = new ArrayBuffer(totalLength);
        const dv = new DataView(bad);
        dv.setUint32(0, GLB_MAGIC, true);
        dv.setUint32(4, 2, true);
        dv.setUint32(8, totalLength, true);
        dv.setUint32(12, jsonBytes.byteLength, true);
        dv.setUint32(16, GLB_JSON_CHUNK, true);
        new Uint8Array(bad, 20, jsonBytes.byteLength).set(jsonBytes);
        const model = await loadGlbMesh(bad);
        expect(model.valid).toBe(false);
    });

    test('rejects an empty ArrayBuffer', async () => {
        const model = await loadGlbMesh(new ArrayBuffer(0));
        expect(model.valid).toBe(false);
        expect(model.parts).toEqual([]);
    });
});

describe('loadGlbMesh — glTF subset constraints', () => {
    test('loads a minimal single-triangle mesh with no indices accessor (implicit range) and no material', async () => {
        const {gltf, bin} = upwardTrianglesGltf([0, 1]);
        const model = await loadGlbMesh(buildGlb(gltf, bin));

        expect(model.valid).toBe(true);
        expect(model.parts).toHaveLength(1); // both triangles share one normal -> one shade bucket
        const part = model.parts[0];
        expect(part.vertexCount).toBe(6);
        expect(part.texture).toBeNull();
        // No material -> glTF default baseColorFactor [1,1,1,1], premultiplied, times shade.
        expect(part.color[0]).toBeCloseTo(part.color[1], 5);
        expect(part.color[1]).toBeCloseTo(part.color[2], 5);
        expect(part.color[3]).toBeCloseTo(1.0, 5);
    });

    test('rejects a required extension it cannot honor (extensionsRequired gate)', async () => {
        const {gltf, bin} = upwardTrianglesGltf([0, 1], {extensionsRequired: ['KHR_draco_mesh_compression']});
        const model = await loadGlbMesh(buildGlb(gltf, bin));
        expect(model.valid).toBe(false);
        expect(model.parts).toEqual([]);
    });

    test('control: the same mesh without extensionsRequired loads fine', async () => {
        const {gltf, bin} = upwardTrianglesGltf([0, 1]);
        const model = await loadGlbMesh(buildGlb(gltf, bin));
        expect(model.valid).toBe(true);
    });

    test('rejects a sparse POSITION accessor (unsupported by this loader\'s subset)', async () => {
        const {gltf, bin} = upwardTrianglesGltf([0, 1]);
        (gltf as any).accessors[0].sparse = {count: 1, indices: {}, values: {}};
        const model = await loadGlbMesh(buildGlb(gltf, bin));
        // The only primitive's POSITION accessor is unreadable -> no triangles gathered -> invalid.
        expect(model.valid).toBe(false);
    });

    test('rejects a mesh with no triangles (degenerate / zero height)', async () => {
        // A single flat triangle at z=0 (all three points share the same map-frame height) ->
        // maxZ - minZ === 0, which native/this loader both treat as invalid.
        const {gltf, bin} = upwardTrianglesGltf([0]);
        const model = await loadGlbMesh(buildGlb(gltf, bin));
        expect(model.valid).toBe(false);
    });

    test('resolves buffer data from a base64 data: URI (no BIN chunk required)', async () => {
        const {gltf} = upwardTrianglesGltf([0, 1]);
        const positions = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0]);
        const bytes = new Uint8Array(positions.buffer);
        (gltf as any).buffers[0] = {
            byteLength: bytes.byteLength,
            uri: `data:application/octet-stream;base64,${base64Encode(bytes)}`,
        };
        const model = await loadGlbMesh(buildGlb(gltf)); // no BIN chunk at all
        expect(model.valid).toBe(true);
        expect(model.parts).toHaveLength(1);
    });

    test('treats an external (non-data:) buffer URI as unsupported', async () => {
        const {gltf} = upwardTrianglesGltf([0, 1]);
        (gltf as any).buffers[0] = {byteLength: 72, uri: 'external.bin'};
        const model = await loadGlbMesh(buildGlb(gltf)); // no BIN chunk, no embeddable data
        expect(model.valid).toBe(false);
    });

    test('rejects an accessor that overruns its bufferView, even though the underlying buffer has room', async () => {
        // count=6 VEC3 FLOAT needs 6 * 12 = 72 bytes, but the bufferView only declares 12
        // bytes (one vertex). The BIN chunk backing it is padded well beyond 72 bytes, so a
        // check against the whole buffer's byteLength would wrongly accept this and read
        // past the bufferView's declared extent into neighboring bytes. A bufferView is a
        // sub-range grant, not a hint — cgltf's `data_too_short` validates accessor-vs-view.
        const {gltf, bin} = upwardTrianglesGltf([0, 1]); // bin is 72 bytes (6 VEC3 floats)
        (gltf as any).bufferViews[0] = {buffer: 0, byteOffset: 0, byteLength: 12}; // only 1 vertex declared
        const model = await loadGlbMesh(buildGlb(gltf, bin));
        expect(model.valid).toBe(false);
        expect(model.parts).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// KHR_mesh_quantization — the encoding real-world glTF-Transform exports use for
// buildings and other large meshes (quantized normalized-SHORT POSITION, required
// extension, interleaved with a quantized NORMAL at byteStride 12). MapLibre Native's
// cgltf loader reads these transparently (`cgltf_accessor_read_float` dequantizes; it
// never gates on `extensionsRequired`); this loader must match. These synthetic fixtures
// reproduce that exact structural feature (a non-committed production apartment export
// that used it rendered as a degenerate "two flat planes" / was rejected outright before
// this loader learned to honor the extension).
// ---------------------------------------------------------------------------

/** A tetrahedron (genuinely 3D: nonzero extent on all axes, apex at glTF +Y = map height),
 * built with either FLOAT POSITION or normalized-SHORT quantized POSITION. When `quantized`,
 * POSITION is interleaved with a normalized-BYTE NORMAL at byteStride 12 — the exact layout
 * glTF-Transform emits for apartment.glb. Normalized values are all −1, 0, or 1, which map to
 * SHORT −32767, 0, or 32767 and dequantize back *exactly*, so the quantized and float bakes
 * must be bit-identical (any dequantization error would show up immediately). */
function tetraGltf(quantized: boolean, extra: Record<string, unknown> = {}): {gltf: unknown; bin: Uint8Array} {
    // glTF-frame normalized positions; +Y (index 3 apex) becomes the baked model's height.
    const verts = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 0, -1],
        [0, 1, 0],
    ];
    const indices = [0, 1, 3, 1, 2, 3, 2, 0, 3, 0, 2, 1];
    const S = 2; // node scale — for quantized assets the node TRS reconstructs world units.

    const idxBytes = new Uint8Array(new Uint16Array(indices).buffer);

    if (!quantized) {
        const posBytes = new Uint8Array(new Float32Array(verts.flat()).buffer);
        const bin = new Uint8Array(posBytes.byteLength + idxBytes.byteLength);
        bin.set(posBytes, 0);
        bin.set(idxBytes, posBytes.byteLength);
        const gltf = {
            asset: {version: '2.0'},
            scene: 0,
            scenes: [{nodes: [0]}],
            nodes: [{mesh: 0, scale: [S, S, S]}],
            meshes: [{primitives: [{attributes: {POSITION: 0}, indices: 1, mode: 4}]}],
            accessors: [
                {bufferView: 0, componentType: 5126, count: 4, type: 'VEC3'},
                {bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR'},
            ],
            bufferViews: [
                {buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength},
                {buffer: 0, byteOffset: posBytes.byteLength, byteLength: idxBytes.byteLength},
            ],
            buffers: [{byteLength: posBytes.byteLength + idxBytes.byteLength}],
            ...extra,
        };
        return {gltf, bin};
    }

    // Interleaved quantized vertex buffer: per vertex, SHORT[3] POSITION at byteOffset 0,
    // BYTE[3] NORMAL at byteOffset 8, stride 12 (matches apartment.glb byte-for-byte).
    const stride = 12;
    const vbuf = new ArrayBuffer(stride * verts.length);
    const dv = new DataView(vbuf);
    for (let i = 0; i < verts.length; i++) {
        const base = i * stride;
        for (let c = 0; c < 3; c++) dv.setInt16(base + c * 2, Math.round(verts[i][c] * 32767), true);
        // A plausible (unused-by-the-bake) quantized NORMAL, proving stride/offset handling.
        for (let c = 0; c < 3; c++) dv.setInt8(base + 8 + c, c === 2 ? 127 : 0);
    }
    const vbytes = new Uint8Array(vbuf);
    const bin = new Uint8Array(vbytes.byteLength + idxBytes.byteLength);
    bin.set(vbytes, 0);
    bin.set(idxBytes, vbytes.byteLength);
    const gltf = {
        asset: {version: '2.0', generator: 'glTF-Transform (synthetic)'},
        extensionsUsed: ['KHR_mesh_quantization'],
        extensionsRequired: ['KHR_mesh_quantization'],
        scene: 0,
        scenes: [{nodes: [0]}],
        nodes: [{mesh: 0, scale: [S, S, S]}],
        meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2, mode: 4}]}],
        accessors: [
            {bufferView: 0, byteOffset: 0, componentType: 5122, normalized: true, count: 4, type: 'VEC3'},
            {bufferView: 0, byteOffset: 8, componentType: 5120, normalized: true, count: 4, type: 'VEC3'},
            {bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR'},
        ],
        bufferViews: [
            {buffer: 0, byteOffset: 0, byteLength: vbytes.byteLength, byteStride: stride},
            {buffer: 0, byteOffset: vbytes.byteLength, byteLength: idxBytes.byteLength},
        ],
        buffers: [{byteLength: bin.byteLength}],
        ...extra,
    };
    return {gltf, bin};
}

function bakedBounds(model: BakedModel): {min: [number, number, number]; max: [number, number, number]; verts: number} {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let verts = 0;
    for (const part of model.parts) {
        for (let i = 0; i < part.vertexCount; i++) {
            for (let a = 0; a < 3; a++) {
                const v = part.vertices[i * MODEL_VERTEX_FLOATS + a];
                if (v < min[a]) min[a] = v;
                if (v > max[a]) max[a] = v;
            }
        }
        verts += part.vertexCount;
    }
    return {min, max, verts};
}

describe('loadGlbMesh — KHR_mesh_quantization (apartment.glb structural parity)', () => {
    test('honors KHR_mesh_quantization in extensionsRequired and reads quantized normalized-SHORT POSITION', async () => {
        const {gltf, bin} = tetraGltf(true);
        const model = await loadGlbMesh(buildGlb(gltf, bin));

        expect(model.valid).toBe(true);
        expect(model.parts.length).toBeGreaterThan(0);
        const b = bakedBounds(model);
        // Genuinely 3D (not the "two flat planes" degenerate bake): every axis has extent,
        // and the height axis is normalized to exactly 1.
        expect(b.max[0] - b.min[0]).toBeGreaterThan(0.1);
        expect(b.max[1] - b.min[1]).toBeGreaterThan(0.1);
        expect(b.max[2] - b.min[2]).toBeCloseTo(1, 5);
    });

    test('quantized POSITION bakes identically to the equivalent FLOAT mesh (correct dequantization)', async () => {
        const quant = tetraGltf(true);
        const float = tetraGltf(false);
        const q = await loadGlbMesh(buildGlb(quant.gltf, quant.bin));
        const f = await loadGlbMesh(buildGlb(float.gltf, float.bin));

        expect(q.valid).toBe(true);
        expect(f.valid).toBe(true);
        const qb = bakedBounds(q);
        const fb = bakedBounds(f);
        expect(qb.verts).toBe(fb.verts);
        // {−1,0,1} normalized values quantize to SHORT exactly, so the two bakes must match
        // to floating-point precision — this asserts the /32767 dequantization is correct.
        for (let a = 0; a < 3; a++) {
            expect(qb.min[a]).toBeCloseTo(fb.min[a], 5);
            expect(qb.max[a]).toBeCloseTo(fb.max[a], 5);
        }
    });

    test('still rejects a genuinely-unsupported required extension alongside KHR_mesh_quantization', async () => {
        const {gltf, bin} = tetraGltf(true, {extensionsRequired: ['KHR_mesh_quantization', 'KHR_draco_mesh_compression']});
        const model = await loadGlbMesh(buildGlb(gltf, bin));
        expect(model.valid).toBe(false);
        expect(model.parts).toEqual([]);
    });
});

describe('loadGlbMesh — uint16 part splitting', () => {
    test('splits a group whose triangle count would overflow one uint16-indexed part', async () => {
        // One vertex more than a single part can hold: MAX_PART_VERTICES is a multiple of 3,
        // so `triCount = MAX_PART_VERTICES / 3 + 1` yields MAX_PART_VERTICES + 3 vertices,
        // guaranteed to require exactly two parts (all triangles share one shade bucket).
        const triCount = MAX_PART_VERTICES / 3 + 1;
        const heights = Array.from({length: triCount}, (_, i) => i * 0.01);
        const {gltf, bin} = upwardTrianglesGltf(heights);

        const model = await loadGlbMesh(buildGlb(gltf, bin));

        expect(model.valid).toBe(true);
        expect(model.parts).toHaveLength(2);
        expect(model.parts[0].vertexCount).toBe(MAX_PART_VERTICES);
        expect(model.parts[1].vertexCount).toBe(3);
        const totalVertices = model.parts.reduce((sum, p) => sum + p.vertexCount, 0);
        expect(totalVertices).toBe(triCount * 3);
        for (const part of model.parts) {
            expect(part.vertexCount).toBeLessThanOrEqual(MAX_PART_VERTICES);
        }
    });
});
