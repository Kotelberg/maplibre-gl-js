import {mat4, vec3} from 'gl-matrix';

import type {quat} from 'gl-matrix';
import type {TextureImage} from '../texture';

/**
 * A GLB baked once into a static, map-renderable mesh: node transforms
 * applied, glTF +Y-up converted to the map's +Z-up, base-centered at the
 * origin on z = 0, uniformly scaled so the model height is exactly 1 (a
 * per-instance transform later scales by `model-scale` meters, exactly as
 * the placeholder cube does — see `placeholder_mesh.ts`).
 *
 * This is a TypeScript port of `mbgl::model::BakedModel` /
 * `loadGlbMesh` (native `src/mbgl/renderer/model/glb_mesh_loader.{hpp,cpp}`,
 * branch `upstream-pr/model-layer`, commit f1836c1061c5) — see that file for the
 * canonical algorithm; this header documents only the TS-specific shape.
 *
 * Vertex layout: each part's `vertices` is a flat, interleaved
 * `Float32Array` of `[x, y, z, u, v]` per vertex (`MODEL_VERTEX_FLOATS`
 * floats per vertex) — the direct analogue of native's
 * `CustomDrawableLayerHost::Interface::GeometryVertex` (`position` +
 * `texcoords`). `indices` is a flat `Uint16Array` (uint16-safe by
 * construction — see `MAX_PART_VERTICES` below). This shape is deliberately
 * GPU-upload-agnostic (no `StructArray`/`VertexBuffer` coupling): Task 3
 * (the model program) owns turning these into GL buffers.
 */
export type BakedModelPart = {
    /** Interleaved `[x, y, z, u, v]` per vertex; length === vertexCount * MODEL_VERTEX_FLOATS. */
    vertices: Float32Array;
    /** Triangle-list indices into `vertices`; length === indexCount, a multiple of 3. */
    indices: Uint16Array;
    vertexCount: number;
    indexCount: number;
    /** Decoded embedded baseColorTexture, or null when the part is flat-colored (use `color`). */
    texture: TextureImage | null;
    /** Premultiplied RGBA in [0, 1], already scaled by this part's baked-lambert shade bucket. */
    color: [number, number, number, number];
};

export type BakedModel = {
    parts: BakedModelPart[];
    valid: boolean;
};

/** Floats per vertex in the interleaved `BakedModelPart.vertices` layout: position(3) + texcoord(2). */
export const MODEL_VERTEX_FLOATS = 5;

/**
 * Every part is split so its vertex count never exceeds this — keeps
 * `Uint16Array` indices valid. Verbatim from native's `kMaxVerts`
 * (`glb_mesh_loader.cpp`); NOT 65535 (0xFFFF) because 65535 is reserved as
 * the GL_PRIMITIVE_RESTART_FIXED_INDEX sentinel on some backends, so native
 * (and this port) stay one triangle short of the hard uint16 ceiling.
 */
export const MAX_PART_VERTICES = 65532;

function invalidModel(): BakedModel {
    return {parts: [], valid: false};
}

// ---------------------------------------------------------------------------
// GLB container (magic/version/length header + JSON + BIN chunks)
// ---------------------------------------------------------------------------

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const GLB_HEADER_LENGTH = 12;
const GLB_CHUNK_HEADER_LENGTH = 8;
const GLB_CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const GLB_CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

type GltfJson = Record<string, any>;

type ParsedGlb = {
    json: GltfJson;
    binChunk: ArrayBuffer | null;
};

/**
 * Parse the GLB binary container: 12-byte header (magic/version/length),
 * then one mandatory JSON chunk (must be first) and one optional BIN chunk.
 * Only the two-chunk GLB convention is supported — no `.gltf` + separate
 * `.bin`/texture files (this loader is handed a single already-fetched
 * `ArrayBuffer`, so there is nowhere to resolve sibling files from; URL
 * fetching is the caller's concern — see `loadGlbMesh` below).
 *
 * Returns null on any structural problem (bad magic, unsupported version,
 * truncated buffer, malformed/missing JSON chunk) — never throws.
 */
function parseGlbContainer(buffer: ArrayBuffer): ParsedGlb | null {
    if (buffer.byteLength < GLB_HEADER_LENGTH) return null;
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== GLB_MAGIC) return null;
    if (dv.getUint32(4, true) !== GLB_VERSION) return null;
    const totalLength = dv.getUint32(8, true);
    if (totalLength < GLB_HEADER_LENGTH || totalLength > buffer.byteLength) return null;

    let offset = GLB_HEADER_LENGTH;
    let json: GltfJson | null = null;
    let binChunk: ArrayBuffer | null = null;
    let chunkIndex = 0;

    while (offset + GLB_CHUNK_HEADER_LENGTH <= totalLength) {
        const chunkLength = dv.getUint32(offset, true);
        const chunkType = dv.getUint32(offset + 4, true);
        const chunkStart = offset + GLB_CHUNK_HEADER_LENGTH;
        if (chunkLength < 0 || chunkStart + chunkLength > totalLength) return null; // truncated chunk

        if (chunkIndex === 0 && chunkType !== GLB_CHUNK_TYPE_JSON) return null; // JSON chunk must be first

        if (chunkType === GLB_CHUNK_TYPE_JSON) {
            if (json !== null) return null; // duplicate JSON chunk
            const jsonBytes = new Uint8Array(buffer, chunkStart, chunkLength);
            let text: string;
            try {
                text = new TextDecoder('utf-8').decode(jsonBytes);
                json = JSON.parse(text);
            } catch {
                return null;
            }
        } else if (chunkType === GLB_CHUNK_TYPE_BIN) {
            binChunk = buffer.slice(chunkStart, chunkStart + chunkLength);
        }
        // Unrecognized chunk types are skipped per the GLB spec.

        offset = chunkStart + chunkLength;
        chunkIndex++;
    }

    if (!json || typeof json !== 'object') return null;
    return {json, binChunk};
}

// ---------------------------------------------------------------------------
// glTF accessor subset (no sparse accessors, no external/http buffer URIs)
// ---------------------------------------------------------------------------

const COMPONENT_TYPE_BYTE = 5120;
const COMPONENT_TYPE_UNSIGNED_BYTE = 5121;
const COMPONENT_TYPE_SHORT = 5122;
const COMPONENT_TYPE_UNSIGNED_SHORT = 5123;
const COMPONENT_TYPE_UNSIGNED_INT = 5125;
const COMPONENT_TYPE_FLOAT = 5126;

const NUM_COMPONENTS: Record<string, number> = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16,
};

function componentSize(componentType: number): number {
    switch (componentType) {
        case COMPONENT_TYPE_BYTE:
        case COMPONENT_TYPE_UNSIGNED_BYTE:
            return 1;
        case COMPONENT_TYPE_SHORT:
        case COMPONENT_TYPE_UNSIGNED_SHORT:
            return 2;
        case COMPONENT_TYPE_UNSIGNED_INT:
        case COMPONENT_TYPE_FLOAT:
            return 4;
        default:
            throw new Error(`unsupported glTF accessor componentType ${componentType}`);
    }
}

function readRawComponent(dv: DataView, byteOffset: number, componentType: number): number {
    switch (componentType) {
        case COMPONENT_TYPE_BYTE: return dv.getInt8(byteOffset);
        case COMPONENT_TYPE_UNSIGNED_BYTE: return dv.getUint8(byteOffset);
        case COMPONENT_TYPE_SHORT: return dv.getInt16(byteOffset, true);
        case COMPONENT_TYPE_UNSIGNED_SHORT: return dv.getUint16(byteOffset, true);
        case COMPONENT_TYPE_UNSIGNED_INT: return dv.getUint32(byteOffset, true);
        case COMPONENT_TYPE_FLOAT: return dv.getFloat32(byteOffset, true);
        default:
            throw new Error(`unsupported glTF accessor componentType ${componentType}`);
    }
}

// glTF 2.0 §3.9.4 normalized-integer dequantization. Core (extension-free) glTF only
// allows this for *unsigned* component types (TEXCOORD_0/COLOR_0/WEIGHTS_0 accessors
// with `normalized: true` UNSIGNED_BYTE/UNSIGNED_SHORT) — the signed BYTE/SHORT cases
// exist in the spec's dequantization formula but are only reachable via
// KHR_mesh_quantization-relaxed POSITION/NORMAL/TANGENT accessors, which this loader
// does not support (removed as dead code — see `makePositionReader` below; quantization
// support is future work alongside extension support generally).
function normalizeComponent(raw: number, componentType: number): number {
    switch (componentType) {
        case COMPONENT_TYPE_UNSIGNED_BYTE: return raw / 255;
        case COMPONENT_TYPE_UNSIGNED_SHORT: return raw / 65535;
        default: return raw;
    }
}

type AccessorReader = {
    count: number;
    componentType: number;
    read(index: number): number[];
};

/**
 * Resolve buffer `bufferIndex`'s bytes. GLB embedded buffer 0 comes from the
 * BIN chunk; `data:` URIs are decoded inline; any other URI (external file
 * or http(s)) is unsupported — this loader never performs a second fetch,
 * by design (see the module doc comment on `loadGlbMesh`).
 */
function resolveBufferData(json: GltfJson, binChunk: ArrayBuffer | null, bufferIndex: number): ArrayBuffer | null {
    const bufferDef = json.buffers?.[bufferIndex];
    if (!bufferDef) return null;
    if (bufferDef.uri === undefined) {
        return bufferIndex === 0 ? binChunk : null;
    }
    if (typeof bufferDef.uri === 'string' && bufferDef.uri.startsWith('data:')) {
        return decodeDataUri(bufferDef.uri);
    }
    return null;
}

function decodeDataUri(uri: string): ArrayBuffer | null {
    const commaIndex = uri.indexOf(',');
    if (commaIndex < 0) return null;
    const meta = uri.slice('data:'.length, commaIndex);
    if (!meta.endsWith(';base64')) return null;
    try {
        const binaryString = atob(uri.slice(commaIndex + 1));
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
        return bytes.buffer;
    } catch {
        return null;
    }
}

/**
 * Build a random-access reader for accessor `accessorIndex`. Returns null
 * for anything this loader's subset does not support: a missing accessor,
 * a sparse accessor (explicitly out of scope — no palette/sparse
 * accessors, per the port spec), an unresolvable buffer, or an out-of-range
 * read. Normalization (core-spec normalized unsigned-integer accessors, e.g.
 * TEXCOORD_0) is applied transparently, matching cgltf's
 * `cgltf_accessor_read_float`.
 */
function makeAccessorReader(json: GltfJson, binChunk: ArrayBuffer | null, accessorIndex: number): AccessorReader | null {
    const accessor = json.accessors?.[accessorIndex];
    if (!accessor || accessor.sparse) return null;
    const numComponents = NUM_COMPONENTS[accessor.type];
    if (!numComponents) return null;
    const count = accessor.count;
    if (typeof count !== 'number' || count < 0) return null;

    if (accessor.bufferView === undefined) {
        // Spec-legal zero-filled accessor (no data backing it).
        return {count, componentType: accessor.componentType, read: () => new Array(numComponents).fill(0)};
    }

    const view = json.bufferViews?.[accessor.bufferView];
    if (!view) return null;
    const bufferData = resolveBufferData(json, binChunk, view.buffer);
    if (!bufferData) return null;

    // Validate the bufferView's own declared extent against the buffer first — mirrors
    // cgltf's two-stage `data_too_short` checks (view-in-buffer, then accessor-in-view).
    const viewByteOffset = view.byteOffset || 0;
    const viewByteLength = view.byteLength;
    if (typeof viewByteLength !== 'number' || viewByteOffset < 0 ||
        viewByteOffset + viewByteLength > bufferData.byteLength) {
        return null;
    }

    let compSize: number;
    try {
        compSize = componentSize(accessor.componentType);
    } catch {
        return null;
    }
    const elementSize = compSize * numComponents;
    const stride = view.byteStride || elementSize;
    const accessorByteOffset = accessor.byteOffset || 0;
    // Validate against the bufferView's declared byteLength, NOT the whole underlying
    // buffer — a bufferView is a sub-range grant, and an accessor reading past its
    // bufferView's declared extent must be rejected even if the surrounding buffer
    // happens to have more bytes physically present (matches cgltf's `data_too_short`
    // semantics: it checks accessor-vs-bufferView, not accessor-vs-buffer).
    const lastElementEnd = accessorByteOffset + (count > 0 ? (count - 1) * stride + elementSize : 0);
    if (lastElementEnd > viewByteLength) return null; // accessor overruns its bufferView
    const baseOffset = viewByteOffset + accessorByteOffset;

    const dv = new DataView(bufferData);
    const normalized = Boolean(accessor.normalized);
    const componentType = accessor.componentType;

    return {
        count,
        componentType,
        read(index: number): number[] {
            const elementOffset = baseOffset + index * stride;
            const out = new Array(numComponents);
            for (let c = 0; c < numComponents; c++) {
                const raw = readRawComponent(dv, elementOffset + c * compSize, componentType);
                out[c] = normalized ? normalizeComponent(raw, componentType) : raw;
            }
            return out;
        }
    };
}

// glTF core restricts POSITION accessors to FLOAT; non-float (quantized) POSITION is
// only valid glTF under KHR_mesh_quantization, which — per that extension's own spec —
// must be declared in extensionsRequired. This loader implements no extensions and
// blanket-rejects any non-empty extensionsRequired (see `loadGlbMesh`), so a
// quantized-POSITION code path here would be unreachable dead code for any
// spec-compliant input; removed rather than kept-but-untested. Quantization support is
// future work, alongside extension support generally.
const POSITION_COMPONENT_TYPES = new Set([COMPONENT_TYPE_FLOAT]);
// glTF core restricts TEXCOORD accessors to float or *unsigned* normalized types (no signed
// byte/short) — this is core-spec behavior, independent of KHR_mesh_quantization.
const TEXCOORD_COMPONENT_TYPES = new Set([COMPONENT_TYPE_FLOAT, COMPONENT_TYPE_UNSIGNED_BYTE, COMPONENT_TYPE_UNSIGNED_SHORT]);
const INDEX_COMPONENT_TYPES = new Set([COMPONENT_TYPE_UNSIGNED_BYTE, COMPONENT_TYPE_UNSIGNED_SHORT, COMPONENT_TYPE_UNSIGNED_INT]);

function makePositionReader(json: GltfJson, binChunk: ArrayBuffer | null, accessorIndex: number): AccessorReader | null {
    const reader = makeAccessorReader(json, binChunk, accessorIndex);
    if (!reader || !POSITION_COMPONENT_TYPES.has(reader.componentType)) return null;
    return reader;
}

function makeTexcoordReader(json: GltfJson, binChunk: ArrayBuffer | null, accessorIndex: number): AccessorReader | null {
    const reader = makeAccessorReader(json, binChunk, accessorIndex);
    if (!reader || !TEXCOORD_COMPONENT_TYPES.has(reader.componentType)) return null;
    if (reader.componentType !== COMPONENT_TYPE_FLOAT && !json.accessors[accessorIndex].normalized) return null;
    return reader;
}

function makeIndexReader(json: GltfJson, binChunk: ArrayBuffer | null, accessorIndex: number): AccessorReader | null {
    const reader = makeAccessorReader(json, binChunk, accessorIndex);
    if (!reader || !INDEX_COMPONENT_TYPES.has(reader.componentType)) return null;
    return reader;
}

// ---------------------------------------------------------------------------
// Node hierarchy → world transforms
// ---------------------------------------------------------------------------

function localMatrixForNode(node: GltfJson): mat4 {
    if (Array.isArray(node.matrix) && node.matrix.length === 16) {
        return mat4.clone(node.matrix as unknown as mat4);
    }
    const t = (node.translation as [number, number, number]) || [0, 0, 0];
    const r = (node.rotation as [number, number, number, number]) || [0, 0, 0, 1];
    const s = (node.scale as [number, number, number]) || [1, 1, 1];
    const out = mat4.create();
    return mat4.fromRotationTranslationScale(out, r as quat, t as vec3, s as vec3);
}

/** World matrix per node index, walking the scene graph from its declared roots (or, for a
 * scene-less/legacy document, every node that is not referenced as another node's child). */
function computeWorldMatrices(json: GltfJson): mat4[] {
    const nodes: GltfJson[] = json.nodes || [];
    const world: (mat4 | null)[] = nodes.map(() => null);
    const visited = new Uint8Array(nodes.length);

    const visit = (nodeIndex: number, parentWorld: mat4) => {
        if (nodeIndex < 0 || nodeIndex >= nodes.length || visited[nodeIndex]) return;
        visited[nodeIndex] = 1;
        const node = nodes[nodeIndex];
        const local = localMatrixForNode(node);
        const m = mat4.multiply(mat4.create(), parentWorld, local);
        world[nodeIndex] = m;
        for (const childIndex of node.children || []) {
            visit(childIndex, m);
        }
    };

    let roots: number[];
    if (Array.isArray(json.scenes) && json.scenes.length > 0) {
        const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
        roots = json.scenes[sceneIndex]?.nodes || [];
    } else {
        const childSet = new Set<number>();
        nodes.forEach((n) => (n.children || []).forEach((c: number) => childSet.add(c)));
        roots = nodes.map((_, i) => i).filter((i) => !childSet.has(i));
    }

    const identity = mat4.create();
    for (const root of roots) visit(root, identity);
    // Defensive: nodes unreachable from any declared root (malformed graph) fall back to identity
    // rather than being silently skipped, so their geometry still contributes to the bake.
    nodes.forEach((_, i) => { if (!world[i]) world[i] = mat4.clone(identity); });
    return world as mat4[];
}

// ---------------------------------------------------------------------------
// Baked-lambert shading — verbatim constants (spec §4.3 / gl-js-port-spec.md)
// ---------------------------------------------------------------------------

/** Fixed engine sun (azimuth 210°, polar 45°, intensity 0.35), baked once — never relit per frame. */
const SUN: readonly [number, number, number] = [-0.3536, 0.6124, 0.7071];
/** Ambient floor = 1 − sun intensity (0.35). */
const AMBIENT = 0.65;
/** Discrete shade buckets per material: round(shade * 16). */
const SHADE_BUCKETS = 16;

function faceShadeBucket(p0: number[], p1: number[], p2: number[]): number {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    let shade = 1.0;
    if (len > 0) {
        const d = (nx * SUN[0] + ny * SUN[1] + nz * SUN[2]) / len;
        shade = AMBIENT + (1.0 - AMBIENT) * Math.max(0, d);
    }
    // shade ∈ [AMBIENT, 1.0], always non-negative, so Math.round (round-half-to-+Infinity)
    // agrees with native's std::lround (round-half-away-from-zero) over this whole range.
    return Math.round(shade * SHADE_BUCKETS);
}

// glTF +Y-up → map +Z-up: (x, y, z) → (x, -z, y). Verified against the reference
// render (roof up) — see native glb_mesh_loader.cpp's comment at the same line.
function remapAxes(p: vec3): [number, number, number] {
    return [p[0], -p[2], p[1]];
}

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

type RawTri = {
    p: [[number, number, number], [number, number, number], [number, number, number]];
    t: [[number, number], [number, number], [number, number]];
};

type TriGroup = {
    materialIndex: number; // -1 for "no material" (matches native's null-material white default)
    bucket: number;
    tris: RawTri[];
};

function groupKey(materialIndex: number, bucket: number): string {
    return `${materialIndex}:${bucket}`;
}

/**
 * Decode this material's embedded baseColorTexture (bufferView-embedded
 * PNG/JPEG only — matches native's `decodeTexture`, which likewise refuses
 * anything but a bufferView-backed `cgltf_image`, i.e. no `uri`-referenced
 * or data-URI images). Returns null (flat-color fallback) on anything else,
 * including decode failure — never throws.
 */
async function decodeMaterialTexture(json: GltfJson, binChunk: ArrayBuffer | null, materialIndex: number): Promise<TextureImage | null> {
    const material = materialIndex >= 0 ? json.materials?.[materialIndex] : null;
    const texRef = material?.pbrMetallicRoughness?.baseColorTexture;
    if (!texRef || typeof texRef.index !== 'number') return null;
    const texture = json.textures?.[texRef.index];
    if (!texture || typeof texture.source !== 'number') return null;
    const image = json.images?.[texture.source];
    if (!image || typeof image.bufferView !== 'number') return null; // bufferView-embedded only

    const view = json.bufferViews?.[image.bufferView];
    if (!view) return null;
    const bufferData = resolveBufferData(json, binChunk, view.buffer);
    if (!bufferData) return null;

    const byteOffset = view.byteOffset || 0;
    if (byteOffset + view.byteLength > bufferData.byteLength) return null;
    const bytes = new Uint8Array(bufferData, byteOffset, view.byteLength);
    const mimeType = image.mimeType || 'image/png';

    if (typeof createImageBitmap !== 'function') return null;
    try {
        const blob = new Blob([bytes], {type: mimeType});
        return await createImageBitmap(blob);
    } catch {
        return null;
    }
}

function baseColorFactorOf(json: GltfJson, materialIndex: number): [number, number, number, number] {
    const material = materialIndex >= 0 ? json.materials?.[materialIndex] : null;
    const factor = material?.pbrMetallicRoughness?.baseColorFactor;
    if (Array.isArray(factor) && factor.length === 4) {
        return [factor[0], factor[1], factor[2], factor[3]];
    }
    return [1, 1, 1, 1]; // glTF spec default
}

/**
 * Parse + bake a GLB `ArrayBuffer` already in memory. This function performs
 * no I/O of its own (no fetch, no filesystem) — resolving a `model-id` (or a
 * URL) to bytes is the caller's job (the `addModel` registry, Task 3); this
 * is the pure, host-agnostic parse+bake step, callable from either a browser
 * main thread or a worker.
 *
 * Never throws: any parse failure (bad container, unsupported extension, no
 * triangles, degenerate bounding box) resolves to an invalid, empty model
 * (`valid` false, `parts` empty), mirroring native's `loadGlbMesh` contract —
 * callers use `.valid` to decide whether to fall back to the placeholder
 * cube (`placeholder_mesh.ts`).
 */
export async function loadGlbMesh(buffer: ArrayBuffer): Promise<BakedModel> {
    try {
        const parsed = parseGlbContainer(buffer);
        if (!parsed) return invalidModel();
        const {json, binChunk} = parsed;

        // Honest, conservative extension gate: this loader implements no glTF
        // extensions at all (no Draco, no meshopt, no palette/sparse accessors —
        // see the port spec), so ANY required extension cannot be honored.
        if (Array.isArray(json.extensionsRequired) && json.extensionsRequired.length > 0) {
            return invalidModel();
        }

        const nodes: GltfJson[] = json.nodes || [];
        const meshes: GltfJson[] = json.meshes || [];
        const worldMatrices = computeWorldMatrices(json);

        const groups = new Map<string, TriGroup>();
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
            const node = nodes[nodeIndex];
            if (typeof node.mesh !== 'number') continue;
            const mesh = meshes[node.mesh];
            if (!mesh || !Array.isArray(mesh.primitives)) continue;
            const world = worldMatrices[nodeIndex];

            for (const primitive of mesh.primitives) {
                // Default primitive mode is 4 (TRIANGLES) per the glTF spec.
                const mode = typeof primitive.mode === 'number' ? primitive.mode : 4;
                if (mode !== 4) continue; // triangles only — no strips/fans/lines/points

                const positionAccessorIndex = primitive.attributes?.POSITION;
                if (typeof positionAccessorIndex !== 'number') continue;
                const posReader = makePositionReader(json, binChunk, positionAccessorIndex);
                if (!posReader) continue;

                const uvAccessorIndex = primitive.attributes?.TEXCOORD_0;
                const uvReader = typeof uvAccessorIndex === 'number' ? makeTexcoordReader(json, binChunk, uvAccessorIndex) : null;

                let indexReader: AccessorReader | null = null;
                let count: number;
                if (typeof primitive.indices === 'number') {
                    indexReader = makeIndexReader(json, binChunk, primitive.indices);
                    if (!indexReader) continue;
                    count = indexReader.count;
                } else {
                    count = posReader.count;
                }

                const materialIndex = typeof primitive.material === 'number' ? primitive.material : -1;

                for (let i = 0; i + 2 < count; i += 3) {
                    const tri: RawTri = {p: [[0, 0, 0], [0, 0, 0], [0, 0, 0]], t: [[0, 0], [0, 0], [0, 0]]};
                    for (let k = 0; k < 3; k++) {
                        const idx = indexReader ? indexReader.read(i + k)[0] : i + k;
                        const v = posReader.read(idx);
                        const worldP = vec3.transformMat4(vec3.create(), v as vec3, world);
                        const mapP = remapAxes(worldP);
                        tri.p[k] = mapP;
                        if (uvReader) {
                            const uv = uvReader.read(idx);
                            tri.t[k] = [uv[0], uv[1]];
                        }
                        minX = Math.min(minX, mapP[0]); maxX = Math.max(maxX, mapP[0]);
                        minY = Math.min(minY, mapP[1]); maxY = Math.max(maxY, mapP[1]);
                        minZ = Math.min(minZ, mapP[2]); maxZ = Math.max(maxZ, mapP[2]);
                    }

                    const bucket = faceShadeBucket(tri.p[0], tri.p[1], tri.p[2]);
                    const key = groupKey(materialIndex, bucket);
                    let group = groups.get(key);
                    if (!group) {
                        group = {materialIndex, bucket, tris: []};
                        groups.set(key, group);
                    }
                    group.tris.push(tri);
                }
            }
        }

        const height = maxZ - minZ;
        if (groups.size === 0 || !(height > 0)) return invalidModel();

        const cx = (minX + maxX) * 0.5;
        const cy = (minY + maxY) * 0.5;
        const invH = 1 / height;

        // Decode each distinct material's texture exactly once (native re-decodes per
        // bucket group; caching here is a safe, output-identical perf improvement — see
        // the Task 2 report's fidelity notes).
        const materialIndices = Array.from(new Set(Array.from(groups.values(), (g) => g.materialIndex)));
        const decodedTextures = await Promise.all(materialIndices.map((mi) => decodeMaterialTexture(json, binChunk, mi)));
        const textureByMaterial = new Map<number, TextureImage | null>();
        materialIndices.forEach((mi, i) => textureByMaterial.set(mi, decodedTextures[i]));

        const parts: BakedModelPart[] = [];
        for (const group of groups.values()) {
            const shade = group.bucket / SHADE_BUCKETS;
            const [r, g, b, a] = baseColorFactorOf(json, group.materialIndex);
            // glTF baseColor = texture × factor; premultiply (rgb × alpha), then apply the
            // per-part shade bucket — verbatim from the port spec / native loader.
            const color: [number, number, number, number] = [r * a * shade, g * a * shade, b * a * shade, a];
            const texture = textureByMaterial.get(group.materialIndex) ?? null;

            let i = 0;
            while (i < group.tris.length) {
                const partTris: RawTri[] = [];
                let vertexCount = 0;
                while (i < group.tris.length && vertexCount + 3 <= MAX_PART_VERTICES) {
                    partTris.push(group.tris[i++]);
                    vertexCount += 3;
                }

                const vertices = new Float32Array(vertexCount * MODEL_VERTEX_FLOATS);
                const indices = new Uint16Array(vertexCount);
                let vOffset = 0;
                for (const tri of partTris) {
                    for (let k = 0; k < 3; k++) {
                        const base = vOffset * MODEL_VERTEX_FLOATS;
                        vertices[base] = (tri.p[k][0] - cx) * invH;
                        vertices[base + 1] = (tri.p[k][1] - cy) * invH;
                        vertices[base + 2] = (tri.p[k][2] - minZ) * invH;
                        vertices[base + 3] = tri.t[k][0];
                        vertices[base + 4] = tri.t[k][1];
                        indices[vOffset] = vOffset;
                        vOffset++;
                    }
                }

                parts.push({vertices, indices, vertexCount, indexCount: indices.length, texture, color});
            }
        }

        return {parts, valid: true};
    } catch {
        return invalidModel();
    }
}
