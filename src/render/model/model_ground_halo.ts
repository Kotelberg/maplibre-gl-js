// Fork-internal (HataHub): the model-selection GROUND HALO — a soft gold radial
// disc pooled on the ground under the selected model.
//
// NOT upstreamed — a companion to the screen-space selection bloom
// (`model_bloom.ts`). It is the web port of maplibre-native's Vulkan
// ground-projected selection halo (`render_model_layer.cpp` @
// `hatahub/model-selection-bloom`, `makeGroundHaloImage` + the
// `MLN_RENDER_BACKEND_VULKAN` disc block), whose exact tuning constants are
// transcribed below.
//
// Why it exists on the web too: the mobile app grounds a selected building with
// a soft pulsing gold circle beneath it (native draws this disc on Vulkan; the
// RN app draws equivalent GeoJSON `fill` rings on GL/Metal). The web renderer
// previously drew ONLY the screen-space halo, so a selected model floated with
// no ground contact. This disc restores parity: a gold circle hugging the
// building base, drawn AFTER the model bodies with a read-only depth test so the
// building occludes the disc centre and only the ring around the footprint
// shows.
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

// ── Ground-halo tuning — verbatim from native render_model_layer.cpp
//    (`hatahub/model-selection-bloom`, `kGroundHalo*` + `makeGroundHaloImage`) ──
/** Halo half-extent = model footprint size × this (`kGroundHaloRadiusFactor`). */
export const GROUND_HALO_RADIUS_FACTOR = 1.7;
/** Lift off the ground plane, in meters, to dodge z-fighting (`kGroundHaloLiftMeters`). */
export const GROUND_HALO_LIFT_METERS = 0.05;
/** Breathing midpoint (`kGroundHaloBaseIntensity`). */
export const GROUND_HALO_BASE_INTENSITY = 0.55;
/** Breathing amplitude — gentle; peaks 0.71 (`kGroundHaloPulseAmp`). */
export const GROUND_HALO_PULSE_AMP = 0.16;
/** Breathing period in seconds, in phase with the composite (`kGroundHaloPulsePeriod`). */
export const GROUND_HALO_PULSE_PERIOD_S = 4.0;
/** Glow colour #FDB912 (`kBloomColor`). The baked texture is premultiplied gold. */
export const GROUND_HALO_COLOR: [number, number, number] = [0.992, 0.725, 0.071];
/** Peak alpha of the baked profile (`kPeakAlpha`). */
const GROUND_HALO_PEAK_ALPHA = 0.62;
/** Baked-texture resolution (native 256²). */
const GROUND_HALO_TEXTURE_SIZE = 256;

/** Smooth Hermite fade, matching the shader `smoothstep` (native `groundHaloSmoothstep`). */
function smoothstep(e0: number, e1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
}

/**
 * Breathing pulse (native ground-halo tweaker):
 * `intensity = 0.55 + 0.16 * sin(t · 2π / 4s)`.
 */
export function groundHaloPulse(elapsedSeconds: number): number {
    return GROUND_HALO_BASE_INTENSITY +
        GROUND_HALO_PULSE_AMP * Math.sin(elapsedSeconds * (2 * Math.PI / GROUND_HALO_PULSE_PERIOD_S));
}

/**
 * Premultiplied gold radial glow, baked with a smooth analytic falloff (no ring
 * banding), verbatim from native `makeGroundHaloImage`. A soft ring: an inner
 * rise (mostly occluded by the building) plateauing right on the footprint edge
 * (radius factor 1.7 → building rim ≈ r 0.59) then a clean feather to 0 by
 * r≈0.95, so the quad's square corners are fully transparent (reads as a disc,
 * never a box). Cached (the profile is view-independent).
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
            const rise = smoothstep(0.28, 0.55, r);
            const fade = 1 - smoothstep(0.66, 0.95, r);
            const a = GROUND_HALO_PEAK_ALPHA * rise * fade;
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
