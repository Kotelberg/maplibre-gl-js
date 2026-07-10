// Fork-internal (HataHub): the model-selection GROUND HALO — a gold concentric
// bullseye pooled on the ground under the selected model.
//
// NOT upstreamed — a companion to the screen-space selection bloom
// (`model_bloom.ts`). It reproduces the MOBILE APP's ground selection cue: the
// RN app (`apps/mobile/components/listings/map/model-buildings-layer.tsx`) draws
// THREE nested #FDB912 `fill` discs beneath the selected model (radii
// 105/85/68 m, base opacity 0.08/0.14/0.20, fainter→brighter inward), all
// breathing together on a ~1.8 s sine. That stacked, stepped look is the "several
// disks" the user sees on device; this file bakes the same profile into the web
// halo texture (was previously a single smooth native-engine disc — the visible
// mismatch Sergey reported).
//
// The disc is drawn AFTER the model bodies with a read-only depth test so the
// building occludes the bright core and only the stepped rings around the
// footprint show.
//
// The always-on contact shadow (`model_geometry.ts`, premultiplied black,
// radius 0.78×) is a different, much fainter element — it grounds EVERY model,
// its dark core sits under the footprint, and it is not a selection cue. This
// halo is the selection cue.

import {mat4} from 'gl-matrix';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {ModelLayoutArray, TriangleIndexArray} from '../../data/array_types.g';
import {modelAttributes} from '../../data/bucket/model_attributes';
import {SegmentVector} from '../../data/segment';
import {Texture} from '../texture';
import {Mesh} from '../mesh';
import {RGBAImage} from '../../util/image';
import {DepthMode} from '../../gl/depth_mode';
import {StencilMode} from '../../gl/stencil_mode';
import {CullFaceMode} from '../../gl/cull_face_mode';
import {mercatorZfromAltitude} from '../../geo/mercator_coordinate';
import {modelUniformValues} from '../program/model_program';

import type {Painter} from '../painter';
import type {Context} from '../../gl/context';
import type {ModelStyleLayer} from '../../style/style_layer/model_style_layer';

// ── Ground-halo tuning — the mobile app's concentric selection rings ──
//    (`apps/mobile/.../model-buildings-layer.tsx`, `GLOW_RINGS` + `PULSE_*`) ──
/** Halo half-extent = model footprint size × this. The outer ring rides the quad edge. */
export const GROUND_HALO_RADIUS_FACTOR = 1.7;
/** Lift off the ground plane, in meters, to dodge z-fighting. */
export const GROUND_HALO_LIFT_METERS = 0.05;
/** Breathing midpoint — mobile multiplies each disc's fill-opacity by 1 at rest. */
export const GROUND_HALO_BASE_INTENSITY = 1.0;
/** Breathing amplitude — the mobile app's ±35 % opacity swing. */
export const GROUND_HALO_PULSE_AMP = 0.35;
/** Breathing period in seconds — the mobile app's ~1.8 s pulse. */
export const GROUND_HALO_PULSE_PERIOD_S = 1.8;
/** Glow colour #FDB912. The baked texture is premultiplied gold. */
export const GROUND_HALO_COLOR: [number, number, number] = [0.992, 0.725, 0.071];
/**
 * The mobile app's three concentric discs, as fractions of the OUTER radius and
 * their base fill-opacity — transcribed from `GLOW_RINGS` (radii 0.105/0.085/
 * 0.068 km → fractions of 0.105; opacity 0.08/0.14/0.20 verbatim). Ordered
 * outer→inner so over-compositing them gold-on-gold reproduces the app's stepped
 * bullseye (composite α ≈ 0.08 / 0.21 / 0.37 across the three bands).
 */
export const GROUND_HALO_RINGS: {radius: number; opacity: number}[] = [
    {radius: 1.0, opacity: 0.08},
    {radius: 85 / 105, opacity: 0.14},
    {radius: 68 / 105, opacity: 0.20},
];
/**
 * Feather (in radius fraction) on each disc edge — kept tight (≈1 texel) so the
 * bands stay CRISP like the mobile app's hard-edged `geoJsonCircle` polygons.
 * A wide feather blurs the three discs into one smooth gradient (the "single
 * disk" the web halo used to read as); crisp steps read as several nested discs.
 */
const GROUND_HALO_RING_FEATHER = 0.01;
/** Baked-texture resolution (native 256²). */
const GROUND_HALO_TEXTURE_SIZE = 256;

/** Smooth Hermite fade, matching a shader `smoothstep`. */
function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/**
 * Breathing pulse (the mobile ground-ring tweaker): the app multiplies every
 * disc's fill-opacity by `1 + 0.35·sin(t · 2π / 1.8 s)`, so the whole bullseye
 * breathes ±35 % around its base on a 1.8 s cycle.
 */
export function groundHaloPulse(elapsedSeconds: number): number {
    return GROUND_HALO_BASE_INTENSITY +
        GROUND_HALO_PULSE_AMP * Math.sin(elapsedSeconds * (2 * Math.PI / GROUND_HALO_PULSE_PERIOD_S));
}

/**
 * Premultiplied gold bullseye baked from the mobile app's three concentric discs
 * (`GROUND_HALO_RINGS`). Each disc is a filled circle feathered at its edge; they
 * over-composite gold-on-gold — exactly as the app stacks its translucent `fill`
 * circles — into a stepped profile: a bright core (all three, α ≈ 0.37), a mid
 * band (outer + middle, α ≈ 0.21) and a faint rim (outer only, α ≈ 0.08), fading
 * to 0 by the quad edge so the square corners are fully transparent (reads as
 * nested discs, never a box). At runtime the read-only depth test lets the
 * building occlude the bright core, leaving the stepped rings hugging the
 * footprint — the "several disks" the mobile app shows. Cached (view-independent).
 */
let haloImage: RGBAImage | null = null;
export function getGroundHaloImage(): RGBAImage {
    if (haloImage) return haloImage;
    const size = GROUND_HALO_TEXTURE_SIZE;
    const image = new RGBAImage({width: size, height: size});
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x + 0.5) / size * 2 - 1;
            const dy = (y + 0.5) / size * 2 - 1;
            const r = Math.sqrt(dx * dx + dy * dy);
            // Over-composite the discs (outer→inner) as the app stacks its
            // translucent `fill` circles: each adds `opacity` over what's beneath.
            let a = 0;
            for (const ring of GROUND_HALO_RINGS) {
                const coverage = 1 - smoothstep(ring.radius - GROUND_HALO_RING_FEATHER, ring.radius, r);
                a += ring.opacity * coverage * (1 - a);
            }
            const o = (y * size + x) * 4;
            // Premultiplied gold: rgb already scaled by alpha.
            image.data[o + 0] = Math.round(GROUND_HALO_COLOR[0] * a * 255);
            image.data[o + 1] = Math.round(GROUND_HALO_COLOR[1] * a * 255);
            image.data[o + 2] = Math.round(GROUND_HALO_COLOR[2] * a * 255);
            image.data[o + 3] = Math.round(a * 255);
        }
    }
    haloImage = image;
    return image;
}

/**
 * Owns the shared gold-halo texture and a per-selection ground quad, and draws
 * the disc under the selected model. One instance per model render-state; the
 * quad rebuilds only when the selected model's footprint size changes.
 */
export class ModelGroundHalo {
    private texture: Texture | null = null;
    private mesh: Mesh | null = null;
    private meshHalf = -1;
    /** Wall-clock ms when the current selection's halo first drew (breathing t0). */
    private startTimeMs: number | null = null;

    private ensureMesh(context: Context, half: number): void {
        if (this.mesh && this.meshHalf === half) return;
        if (this.mesh) {
            this.mesh.destroy();
            this.mesh = null;
        }
        const v = new ModelLayoutArray();
        const i = new TriangleIndexArray();
        const z = GROUND_HALO_LIFT_METERS;
        // Anchor-relative ground meters; the per-frame matrix maps meters→pixels.
        v.emplaceBack(-half, -half, z, 0, 0);
        v.emplaceBack(half, -half, z, 1, 0);
        v.emplaceBack(half, half, z, 1, 1);
        v.emplaceBack(-half, half, z, 0, 1);
        i.emplaceBack(0, 1, 2);
        i.emplaceBack(0, 2, 3);
        this.mesh = new Mesh(
            context.createVertexBuffer(v, modelAttributes.members),
            context.createIndexBuffer(i),
            SegmentVector.simpleSegment(0, 0, v.length, i.length)
        );
        this.meshHalf = half;
    }

    /**
     * Draw the gold ground disc under the selected model. Called AFTER the model
     * bodies are drawn (so the depth buffer holds the building/model depth): the
     * read-only `LEQUAL` test lets the geometry occlude the disc centre, leaving
     * the gold ring hugging the footprint. Premultiplied-alpha blended (translucent
     * pass color mode) and breathing on the native 4-second pulse.
     *
     * @param anchorFx - anchor mercator x-fraction of the selected instance
     * @param anchorFy - anchor mercator y-fraction
     * @param lat0 - anchor latitude (meters→pixels scale)
     * @param footprintSize - `model-scale × model-footprint` of the selected instance
     * @param opacity - the layer `model-opacity`
     */
    draw(painter: Painter, layer: ModelStyleLayer, anchorFx: number, anchorFy: number, lat0: number, footprintSize: number, opacity: number): void {
        const context = painter.context;
        const gl = context.gl;
        const transform = painter.transform;
        const worldSize = transform.worldSize;

        const half = footprintSize * GROUND_HALO_RADIUS_FACTOR;
        if (!(half > 0)) return;

        if (!this.texture) {
            this.texture = new Texture(context, getGroundHaloImage(), gl.RGBA, {premultiply: true});
        }
        this.ensureMesh(context, half);

        // Anchor → world pixels; meters → pixels (x/y) at the anchor latitude; z
        // stays meters (fixed lift, z-scale 1.0 — native's halo tweaker uses
        // `scale(pxPerMeter, pxPerMeter, 1.0)`, NOT the model's grow ramp).
        const pxPerMeter = mercatorZfromAltitude(1, lat0) * worldSize;
        const matrix = mat4.create();
        mat4.translate(matrix, transform.modelViewProjectionMatrix as mat4, [anchorFx * worldSize, anchorFy * worldSize, 0]);
        mat4.scale(matrix, matrix, [pxPerMeter, pxPerMeter, 1]);

        // Breathing: t0 latches on the first draw of a selection; cleared on reset().
        const nowMs = performance.now();
        if (this.startTimeMs === null) this.startTimeMs = nowMs;
        const t = (nowMs - this.startTimeMs) / 1000;
        // Premultiplied gold texture × a flat pulse×opacity keeps it premultiplied
        // while pulsing the halo brightness (native scales all four channels).
        const v = groundHaloPulse(t) * opacity;
        const color = new Color(v, v, v, v, true);

        context.activeTexture.set(gl.TEXTURE0);
        this.texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);

        // Read-only LEQUAL: the model/buildings (drawn first, depth-writing) occlude
        // the disc centre; the ring around the footprint survives. No depth write so
        // the disc never occludes anything drawn after it.
        const depthMode = new DepthMode(gl.LEQUAL, DepthMode.ReadOnly, painter.depthRangeFor3D);
        painter.useProgram('model', null, true).draw(
            context, gl.TRIANGLES, depthMode, StencilMode.disabled, painter.colorModeForRenderPass(), CullFaceMode.disabled,
            modelUniformValues(matrix, color, true), null, undefined, layer.id,
            this.mesh!.vertexBuffer, this.mesh!.indexBuffer, this.mesh!.segments,
            layer.paint, transform.zoom
        );
    }

    /** Clear the breathing clock (call when the selection is emptied). */
    reset(): void {
        this.startTimeMs = null;
    }

    destroy(): void {
        if (this.mesh) {
            this.mesh.destroy();
            this.mesh = null;
        }
        if (this.texture) {
            this.texture.destroy();
            this.texture = null;
        }
        this.meshHalf = -1;
        this.startTimeMs = null;
    }
}
