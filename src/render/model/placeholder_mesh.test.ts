import {describe, expect, test} from 'vitest';
import {buildPlaceholderCube, createFaceColorTexture} from './placeholder_mesh';
import {MODEL_VERTEX_FLOATS} from './glb_loader';

function nearlyEqual(a: number, b: number, eps = 1e-6): boolean {
    return Math.abs(a - b) <= eps;
}

describe('buildPlaceholderCube (native GlbMeshLoader.PlaceholderCubeShape parity)', () => {
    test('emits 24 vertices (6 faces x 4, not shared) and 36 indices (6 faces x 2 tris x 3)', () => {
        const {vertices, indices} = buildPlaceholderCube();

        expect(vertices.length).toBe(24 * MODEL_VERTEX_FLOATS);
        expect(indices.length).toBe(36);
    });

    test('every index references a vertex that exists in this mesh', () => {
        const {vertices, indices} = buildPlaceholderCube();
        const vertexCount = vertices.length / MODEL_VERTEX_FLOATS;
        for (let i = 0; i < indices.length; i++) {
            expect(indices[i]).toBeLessThan(vertexCount);
        }
    });

    test('is base-centered on the ground plane, +z up, height exactly 1 — same convention as BakedModel.Part', () => {
        const {vertices} = buildPlaceholderCube();
        const vertexCount = vertices.length / MODEL_VERTEX_FLOATS;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (let i = 0; i < vertexCount; i++) {
            const x = vertices[i * MODEL_VERTEX_FLOATS];
            const y = vertices[i * MODEL_VERTEX_FLOATS + 1];
            const z = vertices[i * MODEL_VERTEX_FLOATS + 2];
            expect(x).toBeGreaterThanOrEqual(-0.5);
            expect(x).toBeLessThanOrEqual(0.5);
            expect(y).toBeGreaterThanOrEqual(-0.5);
            expect(y).toBeLessThanOrEqual(0.5);
            minZ = Math.min(minZ, z);
            maxZ = Math.max(maxZ, z);
        }
        expect(nearlyEqual(minZ, 0)).toBe(true);
        expect(nearlyEqual(maxZ, 1)).toBe(true);
    });

    test('forms 12 valid triangles (two per face) with no degenerate winding', () => {
        const {indices} = buildPlaceholderCube();
        expect(indices.length % 3).toBe(0);
        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i], b = indices[i + 1], c = indices[i + 2];
            expect(a).not.toBe(b);
            expect(b).not.toBe(c);
            expect(a).not.toBe(c);
        }
        // sanity: 6 faces x 2 tris
        expect(indices.length / 3).toBe(12);
    });
});

describe('createFaceColorTexture (native placeholder_mesh createFaceColorTexture parity)', () => {
    test('is a 3x2 RGBA image, one distinct opaque color per cell, nearest-filter friendly', () => {
        const image = createFaceColorTexture();
        expect(image.width).toBe(3);
        expect(image.height).toBe(2);
        expect(image.data.length).toBe(3 * 2 * 4);

        const seen = new Set<string>();
        for (let i = 0; i < 6; i++) {
            const offset = i * 4;
            const r = image.data[offset];
            const g = image.data[offset + 1];
            const b = image.data[offset + 2];
            const a = image.data[offset + 3];
            expect(a).toBe(255); // fully opaque, so premultiplied === straight
            seen.add(`${r},${g},${b}`);
        }
        expect(seen.size).toBe(6); // all six face colors are distinct
    });
});
