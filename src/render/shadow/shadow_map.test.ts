import {describe, expect, test, vi} from 'vitest';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {Context} from '../../gl/context';
import {ShadowMap, SHADOW_MAP_DEFAULT_SIZE} from './shadow_map';

function getContext(): Context {
    const gl = document.createElement('canvas').getContext('webgl') as WebGL2RenderingContext;
    // The framebuffer completeness check is a no-op under the webgl mock; force COMPLETE so
    // `new Framebuffer(...)` does not throw (mirrors src/gl/render_pool.test.ts).
    vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
    return new Context(gl);
}

describe('ShadowMap', () => {
    test('allocates a color texture + framebuffer with a depth attachment', () => {
        const context = getContext();
        const shadowMap = new ShadowMap(context, 512);

        expect(shadowMap.mapSize).toBe(512);
        expect(shadowMap.texture).toBeTruthy();
        expect(shadowMap.framebuffer).toBeTruthy();
        // withDepth=true: a real depth attachment for the caster's hardware LessEqual test (§3.3.3).
        expect(shadowMap.framebuffer.depthAttachment).toBeTruthy();
    });

    test('defaults to the 1024 cascade map size (spec §3.9)', () => {
        const context = getContext();
        const shadowMap = new ShadowMap(context);
        expect(shadowMap.mapSize).toBe(SHADOW_MAP_DEFAULT_SIZE);
        expect(SHADOW_MAP_DEFAULT_SIZE).toBe(1024);
    });

    test('texelSize is 1 / mapSize (the receiver u_shadow_texel_size)', () => {
        const context = getContext();
        expect(new ShadowMap(context, 1024).texelSize).toBe(1 / 1024);
        expect(new ShadowMap(context, 512).texelSize).toBe(1 / 512);
    });

    test('samples NEAREST + CLAMP_TO_EDGE — no bilinear filtering of packed bytes (spec §3.3.2)', () => {
        const context = getContext();
        const gl = context.gl;
        const texParameteri = vi.spyOn(gl, 'texParameteri');

        new ShadowMap(context, 512);

        const calls = texParameteri.mock.calls;
        expect(calls).toContainEqual([gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST]);
        expect(calls).toContainEqual([gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST]);
        expect(calls).toContainEqual([gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE]);
        expect(calls).toContainEqual([gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]);
    });

    test('depth attachment is a DEPTH_COMPONENT16 renderbuffer at map size', () => {
        const context = getContext();
        const gl = context.gl;
        const renderbufferStorage = vi.spyOn(gl, 'renderbufferStorage');

        new ShadowMap(context, 512);

        expect(renderbufferStorage.mock.calls).toContainEqual(
            [gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 512, 512]);
    });

    test('seeds the packed-depth map to FAR (white == packed 1.0) at allocation (spec §3.3.3)', () => {
        const context = getContext();
        const gl = context.gl;
        const clearColor = vi.spyOn(gl, 'clearColor');
        const clear = vi.spyOn(gl, 'clear');

        new ShadowMap(context, 512);

        // Seed clears the color to (1,1,1,1) — a receiver sampling before the first caster pass then
        // reads "far / lit", not the D3 grey wash.
        expect(clearColor).toHaveBeenCalledWith(1, 1, 1, 1);
        expect(clear).toHaveBeenCalled();
    });

    test('clearToFar re-binds this map and clears color to far-white + depth to 1 (per caster pass)', () => {
        const context = getContext();

        const shadowMap = new ShadowMap(context, 512);

        const bindFramebuffer = vi.spyOn(context.bindFramebuffer, 'set');
        const viewport = vi.spyOn(context.viewport, 'set');
        // gl.clearColor is state-cached (already far-white from the seed), so assert the higher-level
        // clear call instead — it fires every caster pass regardless of cached GL state.
        const clear = vi.spyOn(context, 'clear');

        shadowMap.clearToFar();

        expect(bindFramebuffer).toHaveBeenCalledWith(shadowMap.framebuffer.framebuffer);
        expect(viewport).toHaveBeenCalledWith([0, 0, 512, 512]);
        expect(clear).toHaveBeenCalledWith({color: Color.white, depth: 1});
    });

    test('destroy frees the framebuffer (color texture + depth renderbuffer + fbo)', () => {
        const context = getContext();
        const shadowMap = new ShadowMap(context, 512);
        const destroy = vi.spyOn(shadowMap.framebuffer, 'destroy');

        shadowMap.destroy();

        expect(destroy).toHaveBeenCalled();
    });
});
