import {mat4} from 'gl-matrix';

import {DepthMode} from '../../gl/depth_mode';
import {StencilMode} from '../../gl/stencil_mode';
import {ColorMode} from '../../gl/color_mode';
import {CullFaceMode} from '../../gl/cull_face_mode';
import {calculateTileMatrix} from '../../geo/projection/mercator_utils';
import {groundShadowUniformValues} from '../program/ground_shadow_program';

import type {ShadowMap} from './shadow_map';
import type {Painter} from '../painter';
import type {OverscaledTileID} from '../../tile/tile_id';

/**
 * The per-frame inputs the ground receiver draw needs from Tasks 4/5 (the light frustum fit + the
 * per-frame orchestration). `worldToLightClip` are the concentric cascade matrices in mercator
 * world-px space (near→far; `refreshShadowFrustum`'s `liveCascades`); `shadowMaps` are their packed
 * -depth targets. `intensity` is the evaluated `shadow-intensity` ALREADY gated by
 * `shadowHeightFade(zoom)` and `shadowMapUsable` (§3.11 / §3.3.3). `bias` is the ground receiver's
 * constant-only bias (§3.6). The `*fade*` scalars come from the frustum fit; pass `0` to disable.
 */
export type GroundShadowRenderParams = {
    worldToLightClip: mat4[];
    shadowMaps: ShadowMap[];
    shadowColor: [number, number, number, number];
    intensity: number;
    bias: number;
    fadeStart: number;
    depthFadeStart: number;
    depthFadeEnd: number;
};

/**
 * Draw the ground shadow overlay (spec §3.1): one premultiplied-alpha quad per covering tile that
 * samples the packed-depth cascade map(s) and darkens the ground where a building occludes the sun.
 *
 * gl-js has no drawables and no light-owned render node, so — exactly like the caster
 * (`drawShadowCasters`) — the per-drawable UBO becomes per-tile uniforms: for each cascade the
 * per-tile `tile-local → light-clip` matrix is `worldToLightClip[c] * calculateTileMatrix(coord)`,
 * the SAME tile matrix the visible draw and the caster use, so the sampled position matches where the
 * caster wrote depth.
 *
 * This is a building block for the painter orchestration (Task 5): the caller selects the render pass
 * (translucent, after the opaque FE draw), decides the covering-tile set, owns the sticky-cache
 * refit, and draws the ground receiver ONCE for the first qualifying FE layer in z-order (native's
 * per-`fill-extrusion`-layer ownership). Shadows are a mercator / `anchor:"map"` feature; the quad is
 * drawn with a forced simple mercator projection (matching the caster).
 *
 * @param painter - the painter (context, transform, program cache, tile-extent quad buffers).
 * @param coords - the covering tile IDs to lay ground quads over.
 * @param params - the per-frame cascade matrices, packed-depth maps, and shadow controls.
 */
export function drawGroundShadow(
    painter: Painter,
    coords: Array<OverscaledTileID>,
    params: GroundShadowRenderParams): void {

    const cascadeCount = params.worldToLightClip.length;
    if (cascadeCount === 0 || params.intensity <= 0.0) {
        return;
    }

    const context = painter.context;
    const gl = context.gl;
    const transform = painter.transform;

    // The four cascade samplers bind to texture units 0..cascadeCount-1 (unused slots reuse 0).
    const shadowmapUnits: [number, number, number, number] = [0, 0, 0, 0];
    for (let c = 0; c < cascadeCount && c < 4; c++) {
        shadowmapUnits[c] = c;
        context.activeTexture.set(gl.TEXTURE0 + c);
        // NEAREST + CLAMP_TO_EDGE (§3.3.2): bilinear filtering of packed bytes is meaningless — the
        // soft edge comes from the in-shader PCF, never texture filtering.
        params.shadowMaps[c].texture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
    }

    // Premultiplied-alpha overlay (§3.1); ground quads are flat so cull is irrelevant. Depth-test
    // read-only against the already-drawn opaque scene so buildings occlude the ground shadow behind
    // them, but the overlay never writes depth.
    const depthMode = new DepthMode(gl.LEQUAL, DepthMode.ReadOnly, painter.depthRangeFor3D);
    const colorMode = ColorMode.alphaBlended;

    const program = painter.useProgram('groundShadow', null, /* forceSimpleProjection */ true);
    const texelSize = params.shadowMaps[0].texelSize;

    for (const coord of coords) {
        // Per-cascade per-tile `tile-local -> light-clip`, flattened into a single mat4[cascadeCount].
        const tileMatrix = calculateTileMatrix(coord.toUnwrapped(), transform.worldSize);
        const lightMatrices = new Float32Array(16 * cascadeCount);
        const scratch = new Float64Array(16) as unknown as mat4;
        for (let c = 0; c < cascadeCount; c++) {
            mat4.multiply(scratch, params.worldToLightClip[c], tileMatrix);
            lightMatrices.set(scratch as unknown as ArrayLike<number>, c * 16);
        }

        // The ground quad projects via u_projection_matrix (mercator per-tile clip), supplied here.
        const projectionData = transform.getProjectionData({overscaledTileID: coord, applyGlobeMatrix: false, applyTerrainMatrix: true});

        const uniformValues = groundShadowUniformValues({
            lightMatrices,
            cascadeCount,
            shadowColor: params.shadowColor,
            intensity: params.intensity,
            texelSize,
            bias: params.bias,
            fadeStart: params.fadeStart,
            depthFadeStart: params.depthFadeStart,
            depthFadeEnd: params.depthFadeEnd,
            shadowmapUnits,
        });

        program.draw(
            context, gl.TRIANGLES, depthMode, StencilMode.disabled, colorMode, CullFaceMode.disabled,
            // Constant VAO key: every tile draws the SAME shared tile-extent quad buffers (only the
            // uniforms differ per tile), so one VAO entry is correct and avoids per-tile VAO churn.
            uniformValues, null, projectionData, 'groundShadow',
            painter.tileExtentBuffer, painter.quadTriangleIndexBuffer, painter.tileExtentSegments);
    }
}
