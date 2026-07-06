import {RGBAImage} from '../../util/image';
import {MODEL_VERTEX_FLOATS} from './glb_loader';

/**
 * Unit cube for placeholder model rendering: x,y in [-0.5, 0.5], z in
 * [0, 1] (+z up, base on the ground plane) — the same base-centered,
 * height-1 convention `BakedModel.Part` uses (see `glb_loader.ts`), so a
 * per-instance scale-by-meters transform is identical for real and
 * placeholder geometry. 4 (non-shared) vertices per face, one UV cell per
 * face into the 3x2 face-color texture (`createFaceColorTexture`).
 *
 * TypeScript port of native's `placeholder_mesh.{hpp,cpp}`
 * (`src/mbgl/renderer/model/`, branch `upstream-pr/model-layer`,
 * commit f1836c1061c5).
 */
export type PlaceholderCubeMesh = {
    /** Interleaved `[x, y, z, u, v]` per vertex — 24 vertices (6 faces × 4). */
    vertices: Float32Array;
    /** Triangle-list indices — 36 (6 faces × 2 triangles × 3). */
    indices: Uint16Array;
};

// 6 face colors laid out in a 3x2 texture (opaque, so premultiplied values equal straight values).
const FACE_COLORS: ReadonlyArray<readonly [number, number, number, number]> = [
    [230, 57, 70, 255],   // +x east  red
    [29, 53, 87, 255],    // -x west  navy
    [42, 157, 143, 255],  // +y (projected south) teal
    [233, 196, 106, 255], // -y (projected north) sand
    [244, 162, 97, 255],  // +z top   orange
    [38, 70, 83, 255],    // -z base  slate
];

// Texcoord center of face cell `i` in the 3x2 texture.
function faceUV(faceIndex: number): [number, number] {
    const u = (faceIndex % 3 + 0.5) / 3;
    const v = (Math.floor(faceIndex / 3) + 0.5) / 2;
    return [u, v];
}

export function buildPlaceholderCube(): PlaceholderCubeMesh {
    const lo = -0.5, hi = 0.5, zb = 0, zt = 1;

    const vertices: number[] = [];
    const indices: number[] = [];

    const appendFace = (corners: ReadonlyArray<readonly [number, number, number]>, faceIndex: number) => {
        const base = vertices.length / MODEL_VERTEX_FLOATS;
        const [u, v] = faceUV(faceIndex);
        for (const p of corners) {
            vertices.push(p[0], p[1], p[2], u, v);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };

    appendFace([[hi, lo, zb], [hi, hi, zb], [hi, hi, zt], [hi, lo, zt]], 0); // +x
    appendFace([[lo, hi, zb], [lo, lo, zb], [lo, lo, zt], [lo, hi, zt]], 1); // -x
    appendFace([[hi, hi, zb], [lo, hi, zb], [lo, hi, zt], [hi, hi, zt]], 2); // +y
    appendFace([[lo, lo, zb], [hi, lo, zb], [hi, lo, zt], [lo, lo, zt]], 3); // -y
    appendFace([[lo, lo, zt], [hi, lo, zt], [hi, hi, zt], [lo, hi, zt]], 4); // +z
    appendFace([[lo, hi, zb], [hi, hi, zb], [hi, lo, zb], [lo, lo, zb]], 5); // -z

    return {vertices: new Float32Array(vertices), indices: new Uint16Array(indices)};
}

/** 3x2 texture with one distinct color per cube face (must be sampled NEAREST-filtered by the consumer, matching native). */
export function createFaceColorTexture(): RGBAImage {
    const image = new RGBAImage({width: 3, height: 2});
    for (let i = 0; i < FACE_COLORS.length; i++) {
        const row = Math.floor(i / 3);
        const col = i % 3;
        const offset = (row * 3 + col) * 4;
        const [r, g, b, a] = FACE_COLORS[i];
        image.data[offset] = r;
        image.data[offset + 1] = g;
        image.data[offset + 2] = b;
        image.data[offset + 3] = a;
    }
    return image;
}
