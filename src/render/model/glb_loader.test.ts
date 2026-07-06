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
