import {Color} from '@maplibre/maplibre-gl-style-spec';
import {Texture} from '../texture';

import type {Context} from '../../gl/context';
import type {Framebuffer} from '../../gl/framebuffer';

/**
 * Default per-cascade shadow-map size (spec §3.9, `shadow_pass.cpp:13-26`).
 */
export const SHADOW_MAP_DEFAULT_SIZE = 1024;

/**
 * @internal
 * A single cascade's offscreen shadow-map render target: an RGBA8 packed-depth color texture plus a
 * real depth attachment for the caster's own hardware depth test.
 *
 * The color texture stores light-space depth as RGBA8-**packed color** (not a hardware depth
 * texture) — the substrate the D3 sample-time guards are defined on (spec §3.2). It is sampled
 * `NEAREST` + `CLAMP_TO_EDGE` because bilinear filtering of packed bytes is meaningless — soft
 * shadow edges come from in-shader PCF, never from texture filtering (spec §3.3.2, the
 * `Linear→Nearest` fix).
 *
 * The depth **renderbuffer** exists so the caster draw runs depth-tested (`LessEqual` + write) and
 * the nearest-to-light packed color survives, rather than last-write-wins — reliable inter-building
 * occlusion (spec §3.3.3 caster half; mirrors native `ShadowMap::ensure` `withDepth=true`).
 *
 * The color texture is seeded to FAR (white == packed depth `1.0`) at allocation and cleared to FAR
 * at the start of every caster pass, so a receiver that samples before/without a caster render reads
 * "nothing casts / everything lit" instead of the D3 grey-roof wash (spec §3.3.3).
 */
export class ShadowMap {
    context: Context;
    mapSize: number;
    /** UV texel size (`1 / mapSize`) — the receiver's `u_shadow_texel_size`. */
    texelSize: number;
    texture: Texture;
    framebuffer: Framebuffer;

    constructor(context: Context, mapSize: number = SHADOW_MAP_DEFAULT_SIZE) {
        this.context = context;
        this.mapSize = mapSize;
        this.texelSize = 1 / mapSize;

        const gl = context.gl;

        // RGBA8 packed-depth color target. NEAREST min/mag + CLAMP_TO_EDGE (spec §3.3.2).
        this.texture = new Texture(context, {width: mapSize, height: mapSize, data: null}, gl.RGBA, {premultiply: false});
        this.texture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);

        // Color + real depth attachment (spec §3.3.3 caster half). Mirrors the terrain
        // render-to-texture idiom (`src/render/terrain.ts`): color texture + DEPTH_COMPONENT16
        // renderbuffer.
        this.framebuffer = context.createFramebuffer(mapSize, mapSize, true, false);
        this.framebuffer.depthAttachment.set(context.createRenderbuffer(gl.DEPTH_COMPONENT16, mapSize, mapSize));
        this.framebuffer.colorAttachment.set(this.texture.texture);

        // Seed the packed-depth texture to FAR at allocation (spec §3.3.3).
        this.seedToFar();
    }

    /**
     * Clear the packed-depth color to far-white (`(1,1,1,1)` == packed depth `1.0`) and the depth
     * buffer to `1.0`. Called at allocation (seed) and at the start of every caster pass (spec
     * §3.3.3). Binds this map's framebuffer + viewport as a side effect; the caller restores the
     * default target afterwards.
     */
    clearToFar(): void {
        const context = this.context;
        context.bindFramebuffer.set(this.framebuffer.framebuffer);
        context.viewport.set([0, 0, this.mapSize, this.mapSize]);
        context.clear({color: Color.white, depth: 1});
    }

    /** Alias of {@link clearToFar} used at allocation — the seed-to-far step (spec §3.3.3). */
    seedToFar(): void {
        this.clearToFar();
    }

    /** Frees the color texture, depth renderbuffer, and framebuffer. */
    destroy(): void {
        // Framebuffer.destroy() deletes the attached color texture + depth renderbuffer + fbo; the
        // Texture wrapper shares that same GL texture, so we do not also call texture.destroy()
        // (double-free).
        this.framebuffer.destroy();
    }
}
