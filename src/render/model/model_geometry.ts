import {mat4, vec3} from 'gl-matrix';
import {ModelLayoutArray, TriangleIndexArray} from '../../data/array_types.g';
import {modelAttributes} from '../../data/bucket/model_attributes';
import {SegmentVector} from '../../data/segment';
import {Texture} from '../texture';
import {Mesh} from '../mesh';
import {RGBAImage} from '../../util/image';
import {latFromMercatorY} from '../../geo/mercator_coordinate';
import {degreesToRadians} from '../../util/util';
import {buildPlaceholderCube, createFaceColorTexture} from './placeholder_mesh';
import {MODEL_VERTEX_FLOATS} from './glb_loader';

import type {Context} from '../../gl/context';
import type {Color} from '@maplibre/maplibre-gl-style-spec';
import type {BakedModel, BakedModelPart} from './glb_loader';
import type {PlacedInstance} from './model_placement';
import type {ModelManager} from '../../style/model_manager';

/** Meters spanned by the full mercator world at the equator (native `kEarthCircumference`). */
const EARTH_CIRCUMFERENCE = 40075016.686;
/** Merged-chunk vertex cap; below the 65532 uint16 index ceiling with headroom (native uses 60000). */
const MAX_CHUNK_VERTICES = 60000;

/**
 * A drawable part: a merged mesh (one or more instances baked into it) plus its
 * premultiplied base color and optional texture. `textured` selects the shader
 * branch; `color` is the per-draw base later scaled by the grow/fade ramp.
 */
export type BuiltPart = {
    mesh: Mesh;
    color: [number, number, number, number];
    textured: boolean;
    texture: Texture | null;
    /** true for the placeholder face-color texture (NEAREST/CLAMP), false for baseColor textures (LINEAR/REPEAT/mipmap). */
    nearest: boolean;
};

/**
 * All instances of one model, baked relative to a shared ground anchor. The
 * per-frame matrix maps meters→world-pixels at `lat0` and applies the grow/fade
 * ramp; the baked geometry itself is camera-independent (rigid under motion).
 */
export type BuiltGroup = {
    anchorFx: number;
    anchorFy: number;
    lat0: number;
    parts: BuiltPart[];
    shadow: Mesh | null;
    shadowTexture: Texture | null;
};

export type BuiltModels = {
    groups: BuiltGroup[];
    destroy: () => void;
};

// Soft radial contact shadow, verbatim from native `makeContactShadowImage`:
// 64x64 premultiplied black, alpha = (max(0, 1 - r))^2 * 0.38.
let contactShadowImage: RGBAImage | null = null;
function getContactShadowImage(): RGBAImage {
    if (contactShadowImage) return contactShadowImage;
    const size = 64;
    const image = new RGBAImage({width: size, height: size});
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x + 0.5) / size * 2 - 1;
            const dy = (y + 0.5) / size * 2 - 1;
            const r = Math.sqrt(dx * dx + dy * dy);
            const falloff = Math.max(0, 1 - r);
            const alpha = Math.round(falloff * falloff * 0.38 * 255);
            const o = (y * size + x) * 4;
            // Premultiplied black: rgb stay 0.
            image.data[o + 3] = alpha;
        }
    }
    contactShadowImage = image;
    return image;
}

function buildMesh(context: Context, vertices: ModelLayoutArray, indices: TriangleIndexArray): Mesh {
    return new Mesh(
        context.createVertexBuffer(vertices, modelAttributes.members),
        context.createIndexBuffer(indices),
        SegmentVector.simpleSegment(0, 0, vertices.length, indices.length / 3)
    );
}

/**
 * Bake the placements into GPU-ready grouped geometry. Instances whose
 * `model-id` resolves to a loaded, valid mesh are grouped by model; every other
 * instance (unregistered id, still loading, or failed parse) draws the
 * face-colored placeholder cube — a visible "asset not loaded" signal.
 *
 * Per-instance transform is baked into the vertices in ground meters relative to
 * the group anchor (`translate` * `rotate_z(model-rotation)` *
 * `scale(size*footprint, size*footprint, size)`), exactly as native's
 * `render_model_layer.cpp`. Merged into 60000-vertex-max chunks so uint16
 * indices stay valid.
 */
export function buildModelGeometry(
    context: Context,
    instances: PlacedInstance[],
    modelManager: ModelManager
): BuiltModels {
    // Group by resolved mesh; unresolved → face-colored placeholder cube.
    const placeholderCube = buildPlaceholderCube();
    const placeholderModel: BakedModel = {
        valid: true,
        parts: [{
            vertices: placeholderCube.vertices,
            indices: placeholderCube.indices,
            vertexCount: placeholderCube.vertices.length / MODEL_VERTEX_FLOATS,
            indexCount: placeholderCube.indices.length,
            texture: createFaceColorTexture(),
            color: [1, 1, 1, 1]
        }]
    };

    const byModel = new Map<string, {model: BakedModel; placeholder: boolean; instances: PlacedInstance[]}>();
    const cubes: PlacedInstance[] = [];
    for (const inst of instances) {
        const mesh = inst.modelId ? modelManager.getModel(inst.modelId) : null;
        if (mesh && mesh.valid && mesh.parts.length > 0) {
            let group = byModel.get(inst.modelId);
            if (!group) {
                group = {model: mesh, placeholder: false, instances: []};
                byModel.set(inst.modelId, group);
            }
            group.instances.push(inst);
        } else {
            cubes.push(inst);
        }
    }
    if (cubes.length > 0) {
        byModel.set('\0placeholder', {model: placeholderModel, placeholder: true, instances: cubes});
    }

    const owned: Array<{destroy: () => void}> = [];
    const textureCache = new Map<object, Texture>();
    let shadowTexture: Texture | null = null;

    const resolvePartTexture = (part: BakedModelPart, placeholder: boolean): Texture | null => {
        if (!part.texture) return null;
        let tex = textureCache.get(part.texture as object);
        if (!tex) {
            // The placeholder's tiny 3x2 face texture is sampled NEAREST/CLAMP
            // (no mipmap); baseColor textures are LINEAR/REPEAT with mipmaps.
            tex = new Texture(context, part.texture, context.gl.RGBA, {useMipmap: !placeholder, premultiply: true});
            textureCache.set(part.texture as object, tex);
            owned.push(tex);
        }
        return tex;
    };

    const groups: BuiltGroup[] = [];
    const f = mat4.create();
    const p = vec3.create();

    for (const {model, placeholder, instances: groupInstances} of byModel.values()) {
        const ref = groupInstances[0];
        const lat0 = latFromMercatorY(ref.fy);
        const metersPerFraction = EARTH_CIRCUMFERENCE * Math.cos(degreesToRadians(lat0));

        const parts: BuiltPart[] = [];

        for (const part of model.parts) {
            const textured = !!part.texture;
            const texture = resolvePartTexture(part, placeholder);

            const partVertexCount = part.vertices.length / MODEL_VERTEX_FLOATS;
            let vertices = new ModelLayoutArray();
            let indices = new TriangleIndexArray();

            const flush = () => {
                if (vertices.length === 0) return;
                parts.push({
                    mesh: buildMesh(context, vertices, indices),
                    color: part.color,
                    textured,
                    texture,
                    nearest: placeholder
                });
                vertices = new ModelLayoutArray();
                indices = new TriangleIndexArray();
            };

            for (const inst of groupInstances) {
                if (vertices.length + partVertexCount > MAX_CHUNK_VERTICES) flush();

                mat4.identity(f);
                mat4.translate(f, f, [(inst.fx - ref.fx) * metersPerFraction, (inst.fy - ref.fy) * metersPerFraction, 0]);
                mat4.rotateZ(f, f, degreesToRadians(inst.rotation));
                const sxy = inst.scale * inst.footprint;
                mat4.scale(f, f, [sxy, sxy, inst.scale]);

                const base = vertices.length;
                const src = part.vertices;
                for (let vi = 0; vi < partVertexCount; vi++) {
                    const o = vi * MODEL_VERTEX_FLOATS;
                    p[0] = src[o]; p[1] = src[o + 1]; p[2] = src[o + 2];
                    vec3.transformMat4(p, p, f);
                    vertices.emplaceBack(p[0], p[1], p[2], src[o + 3], src[o + 4]);
                }
                const idx = part.indices;
                for (let ii = 0; ii + 2 < idx.length; ii += 3) {
                    indices.emplaceBack(base + idx[ii], base + idx[ii + 1], base + idx[ii + 2]);
                }
            }
            flush();
        }

        // Contact shadows: soft radial ground quads, one merged mesh per group.
        let shadow: Mesh | null = null;
        {
            const sv = new ModelLayoutArray();
            const si = new TriangleIndexArray();
            for (const inst of groupInstances) {
                if (sv.length + 4 > MAX_CHUNK_VERTICES) break;
                const cx = (inst.fx - ref.fx) * metersPerFraction;
                const cy = (inst.fy - ref.fy) * metersPerFraction;
                const half = inst.scale * inst.footprint * 0.78;
                const zLift = Math.max(0.05, inst.scale * 0.004);
                const b = sv.length;
                sv.emplaceBack(cx - half, cy - half, zLift, 0, 0);
                sv.emplaceBack(cx + half, cy - half, zLift, 1, 0);
                sv.emplaceBack(cx + half, cy + half, zLift, 1, 1);
                sv.emplaceBack(cx - half, cy + half, zLift, 0, 1);
                si.emplaceBack(b, b + 1, b + 2);
                si.emplaceBack(b, b + 2, b + 3);
            }
            if (sv.length > 0) {
                if (!shadowTexture) {
                    shadowTexture = new Texture(context, getContactShadowImage(), context.gl.RGBA, {premultiply: true});
                    owned.push(shadowTexture);
                }
                shadow = buildMesh(context, sv, si);
                owned.push(shadow);
            }
        }

        for (const part of parts) owned.push(part.mesh);
        groups.push({anchorFx: ref.fx, anchorFy: ref.fy, lat0, parts, shadow, shadowTexture});
    }

    return {
        groups,
        destroy: () => {
            for (const o of owned) o.destroy();
        }
    };
}

export type {Color};
