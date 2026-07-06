// Fork-internal (HataHub): the model-layer selection bloom post-process.
//
// NOT upstreamed — lives on `hatahub/integration` only. A from-scratch WebGL2
// reimplementation of maplibre-native's `render_model_layer.cpp` bloom block
// (@ b5a5db128be0), which the native version only ever ran as WIP. The native
// code is the DESIGN reference: the algorithm and its exact tuning constants,
// transcribed below. The native render-graph ordering bug (a one-frame blank
// mask when the offscreen target had not rendered before the main-group
// composite sampled it) is MOOT here — gl-js drives both passes explicitly and
// in order inside `drawModel`, so the composite always samples a fresh mask.
//
// Pipeline (per frame, only while a model is selected):
//   1. Silhouette pass  — the selected instance's baked mesh parts, drawn solid
//      white into a HALF-RES offscreen RGBA8 target that clears to opaque black
//      (0,0,0,1). Coverage lands in the RED channel. (Drawn in draw_model.ts,
//      reusing the `model` program + the per-frame group matrix.)
//   2. Composite pass   — a fullscreen quad sampling that mask: a 16-tap × 3-ring
//      disk blur, gated to OUTSIDE the geometry, premultiplied #FDB912, breathing
//      on a 4-second pulse. Composited UNDER the models (drawn before them, in
//      the translucent pass), premultiplied-alpha blended so the halo reads on a
//      bright basemap.

import {Color} from '@maplibre/maplibre-gl-style-spec';
import {DepthMode} from '../../gl/depth_mode';
import {StencilMode} from '../../gl/stencil_mode';
import {ColorMode} from '../../gl/color_mode';
import {CullFaceMode} from '../../gl/cull_face_mode';
import {modelBloomUniformValues} from '../program/model_bloom_program';

import type {vec4} from 'gl-matrix';
import type {Painter} from '../painter';
import type {Context} from '../../gl/context';
import type {Framebuffer} from '../../gl/framebuffer';

// ── Bloom tuning — verbatim from native render_model_layer.cpp @ b5a5db128be0 ──
/** Peak halo opacity (`kBloomIntensity`). */
export const BLOOM_INTENSITY = 0.62;
/** Breathing amplitude — slow, clearly visible (`kBloomPulseAmp`). */
export const BLOOM_PULSE_AMP = 0.34;
/** Breathing period in seconds (`kBloomPulsePeriod`). */
export const BLOOM_PULSE_PERIOD_S = 4.0;
/** Disk-blur radius in mask texels (`kBloomRadiusTexels`). */
export const BLOOM_RADIUS_TEXELS = 7.0;
/** Glow colour #FDB912 (`kBloomColor`), passed raw (the shader premultiplies). */
export const BLOOM_COLOR: [number, number, number] = [0.992, 0.725, 0.071];
/** Half-resolution mask (native `maskSize = viewport / 2`). */
export const BLOOM_MASK_SCALE = 0.5;

/**
 * Breathing pulse (native `BloomCompositeTweaker`):
 * `intensity = 0.62 + 0.34 * sin(t · 2π / 4s)`. `t` is seconds since the halo
 * first became active.
 */
export function bloomPulse(elapsedSeconds: number): number {
    return BLOOM_INTENSITY + BLOOM_PULSE_AMP * Math.sin(elapsedSeconds * (2 * Math.PI / BLOOM_PULSE_PERIOD_S));
}

/** Opaque-black clear for the silhouette mask target (native RenderTarget default). */
const MASK_CLEAR_COLOR = new Color(0, 0, 0, 1);

/**
 * Owns the half-res silhouette mask target and drives the two bloom passes. One
 * instance per model render-state; torn down when the layer's geometry is
 * destroyed or the target size changes.
 */
export class ModelBloom {
    private fbo: Framebuffer | null = null;
    private maskTexture: WebGLTexture | null = null;
    private maskWidth = 0;
    private maskHeight = 0;
    /** Wall-clock ms when the current selection's halo first drew (breathing t0). */
    private startTimeMs: number | null = null;

    /** Half-res mask dimensions for the current viewport (min 1×1). */
    maskSize(painter: Painter): [number, number] {
        return [
            Math.max(1, Math.floor(painter.width * BLOOM_MASK_SCALE)),
            Math.max(1, Math.floor(painter.height * BLOOM_MASK_SCALE))
        ];
    }

    /**
     * (Re)allocate the half-res RGBA8 mask target for `width`×`height`. LINEAR
     * sampling so the disk blur reads smoothly between texels; CLAMP_TO_EDGE so
     * taps past the mask edge do not wrap coverage in.
     */
    private ensureTarget(context: Context, width: number, height: number): void {
        if (this.fbo && this.maskWidth === width && this.maskHeight === height) return;
        this.destroyTarget();

        const gl = context.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        const fbo = context.createFramebuffer(width, height, false, false);
        fbo.colorAttachment.set(texture);

        this.fbo = fbo;
        this.maskTexture = texture;
        this.maskWidth = width;
        this.maskHeight = height;
    }

    /**
     * Begin the silhouette pass: allocate/bind the half-res target, clear it to
     * opaque black, and point the viewport at it. Returns the previously-bound
     * framebuffer + viewport so `endSilhouette` can restore the main target
     * (robust to terrain / render-to-texture). The caller then draws the selected
     * instance's geometry solid white with the `model` program.
     */
    beginSilhouette(painter: Painter): {prevFbo: WebGLFramebuffer | null; prevViewport: [number, number, number, number]} {
        const context = painter.context;
        const gl = context.gl;
        const [w, h] = this.maskSize(painter);

        // Capture the caller's framebuffer/viewport BEFORE ensureTarget: allocating
        // the mask FBO binds it, so reading bindFramebuffer.current afterwards would
        // capture the mask itself — and endSilhouette would then "restore" the mask
        // as the composite target, drawing into it while sampling it (a feedback
        // loop on the first frame). Capture first, then allocate.
        const prevFbo = context.bindFramebuffer.current;
        const prevViewport = context.viewport.current;

        this.ensureTarget(context, w, h);

        context.bindFramebuffer.set(this.fbo!.framebuffer);
        context.viewport.set([0, 0, w, h]);

        // Defense in depth against a feedback loop: clear TEXTURE0 (the model
        // program's `u_texture` unit) before rendering INTO the mask target, so no
        // sampler references the mask texture while it is the draw target. The
        // composite also unbinds after sampling, so in steady state unit 0 is
        // already clear here.
        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, null);

        context.clear({color: MASK_CLEAR_COLOR});

        return {prevFbo, prevViewport};
    }

    /** Depth/stencil/cull/color modes for the silhouette draw: flat coverage, no
     * depth, no cull (baked house winding is flipped by the axis remap), overwrite
     * (Replace) so any covered texel becomes solid white. */
    readonly silhouetteDepthMode = DepthMode.disabled;
    readonly silhouetteStencilMode = StencilMode.disabled;
    readonly silhouetteColorMode = ColorMode.unblended;
    readonly silhouetteCullMode = CullFaceMode.disabled;
    /** Premultiplied solid white — the silhouette fill colour. */
    readonly silhouetteColor = new Color(1, 1, 1, 1, true);

    /** Restore the main framebuffer + viewport after the silhouette pass. */
    endSilhouette(painter: Painter, prev: {prevFbo: WebGLFramebuffer | null; prevViewport: [number, number, number, number]}): void {
        const context = painter.context;
        context.bindFramebuffer.set(prev.prevFbo);
        context.viewport.set(prev.prevViewport);
    }

    /**
     * Composite pass: draw the breathing halo as a fullscreen quad onto the
     * now-restored main framebuffer, premultiplied-alpha blended (so it reads on a
     * bright basemap) and UNDER the models (the caller draws this before the model
     * groups). `opacity` folds in the layer's `model-opacity`.
     */
    composite(painter: Painter, opacity: number): void {
        if (!this.fbo || !this.maskTexture) return;
        const context = painter.context;
        const gl = context.gl;

        // Breathing: t0 latches on the first composite of a selection; cleared on
        // deselect via reset().
        const nowMs = performance.now();
        if (this.startTimeMs === null) this.startTimeMs = nowMs;
        const t = (nowMs - this.startTimeMs) / 1000;
        const intensity = bloomPulse(t) * opacity;

        const color: vec4 = [BLOOM_COLOR[0], BLOOM_COLOR[1], BLOOM_COLOR[2], intensity];
        const texel: [number, number] = [1 / this.maskWidth, 1 / this.maskHeight];

        context.activeTexture.set(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);

        // forceSimpleProjection (like the sibling `model` program): the composite
        // vertex shader writes clip-space directly and uses no projection prelude.
        painter.useProgram('modelBloom', null, true).draw(
            context, gl.TRIANGLES,
            DepthMode.disabled, StencilMode.disabled, ColorMode.alphaBlended, CullFaceMode.disabled,
            modelBloomUniformValues(0, color, texel, BLOOM_RADIUS_TEXELS),
            null, undefined, 'modelBloom',
            painter.viewportBuffer, painter.quadTriangleIndexBuffer, painter.viewportSegments
        );

        // Defensive: don't leave the mask texture bound on TEXTURE0. If the next
        // frame's silhouette pass bound the mask FBO while its own texture were
        // still on an active sampler unit, GL flags a feedback loop and drops the
        // draw. beginSilhouette also unbinds, but clearing here keeps every frame
        // clean regardless of draw order.
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /** Clear the breathing clock (call when the selection is emptied) so the next
     * selection's halo starts its pulse from the peak-approaching phase, not
     * mid-breath. */
    reset(): void {
        this.startTimeMs = null;
    }

    private destroyTarget(): void {
        if (this.fbo) {
            // Framebuffer.destroy() also deletes the attached color texture.
            this.fbo.destroy();
            this.fbo = null;
            this.maskTexture = null;
            this.maskWidth = 0;
            this.maskHeight = 0;
        }
    }

    destroy(): void {
        this.destroyTarget();
        this.startTimeMs = null;
    }
}
