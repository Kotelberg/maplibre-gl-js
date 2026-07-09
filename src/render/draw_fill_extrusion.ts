import {mat4} from 'gl-matrix';

import {DepthMode} from '../gl/depth_mode';
import {StencilMode} from '../gl/stencil_mode';
import {ColorMode} from '../gl/color_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {
    fillExtrusionUniformValues,
    fillExtrusionPatternUniformValues,
    fillExtrusionShadowUniformValues,
} from './program/fill_extrusion_program';
import {lightTileWorldMatrix, shadowPixelsPerMeter} from './shadow/shadow_frustum';

import type {Painter, RenderOptions} from './painter';
import type {TileManager} from '../tile/tile_manager';
import type {FillExtrusionStyleLayer} from '../style/style_layer/fill_extrusion_style_layer';
import type {FillExtrusionBucket} from '../data/bucket/fill_extrusion_bucket';
import type {OverscaledTileID} from '../tile/tile_id';
import type {BuildingShadowFrame} from './shadow/shadow_renderer';

import {updatePatternPositionsInProgram} from './update_pattern_positions_in_program';
import {translatePosition} from '../util/util';

export function drawFillExtrusion(painter: Painter, tileManager: TileManager, layer: FillExtrusionStyleLayer, coords: Array<OverscaledTileID>, renderOptions: RenderOptions) {
    const opacity = layer.paint.get('fill-extrusion-opacity');
    if (opacity === 0) {
        return;
    }

    const {isRenderingToTexture} = renderOptions;
    if (painter.renderPass === 'translucent') {
        // Shadow receiver inputs for this frame (spec §3.1), or null when shadows are inactive.
        const shadowRenderer = painter.shadowRenderer;
        const shadowFrame = shadowRenderer && shadowRenderer.active ? shadowRenderer.getBuildingShadowFrame() : null;

        // Ground-shadow overlay: drawn ONCE by the first (lowest-index) qualifying fill-extrusion
        // layer in z-order (native per-layer ground ownership, spec §3.1), before its buildings so
        // they naturally overdraw it. No-op unless this layer owns the ground draw this frame.
        if (shadowRenderer && shadowRenderer.isGroundOwner(layer.id) && !isRenderingToTexture) {
            shadowRenderer.drawGround(painter, coords);
        }

        const depthMode = new DepthMode(painter.context.gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D);

        if (opacity === 1 && !layer.paint.get('fill-extrusion-pattern').constantOr(1 as any)) {
            const colorMode = painter.colorModeForRenderPass();
            drawExtrusionTiles(painter, tileManager, layer, coords, depthMode, StencilMode.disabled, colorMode, isRenderingToTexture, shadowFrame);

        } else {
            // Draw transparent buildings in two passes so that only the closest surface is drawn.
            // First draw all the extrusions into only the depth buffer. No colors are drawn.
            drawExtrusionTiles(painter, tileManager, layer, coords, depthMode,
                StencilMode.disabled,
                ColorMode.disabled, isRenderingToTexture, shadowFrame);

            // Then draw all the extrusions a second type, only coloring fragments if they have the
            // same depth value as the closest fragment in the previous pass. Use the stencil buffer
            // to prevent the second draw in cases where we have coincident polygons.
            drawExtrusionTiles(painter, tileManager, layer, coords, depthMode,
                painter.stencilModeFor3D(),
                painter.colorModeForRenderPass(), isRenderingToTexture, shadowFrame);
        }
    }
}

function drawExtrusionTiles(
    painter: Painter,
    tileManager: TileManager,
    layer: FillExtrusionStyleLayer,
    coords: OverscaledTileID[],
    depthMode: DepthMode,
    stencilMode: Readonly<StencilMode>,
    colorMode: Readonly<ColorMode>,
    isRenderingToTexture: boolean,
    shadowFrame: BuildingShadowFrame | null) {
    const context = painter.context;
    const gl = context.gl;
    const fillPropertyName = 'fill-extrusion-pattern';
    const patternProperty = layer.paint.get(fillPropertyName);
    const image = patternProperty.constantOr(1 as any);
    const crossfade = layer.getCrossfadeParameters();
    const opacity = layer.paint.get('fill-extrusion-opacity');
    const constantPattern = patternProperty.constantOr(null);
    const transform = painter.transform;

    // The building shadow receiver is a `#define RENDER_SHADOWS` variant of the FE program. It samples
    // the packed-depth cascade maps on texture units 0..N — which the patterned path uses for its
    // image atlas — so shadows apply to the non-patterned FE path only (patterned buildings keep the
    // stock program). Terrain is the documented unsupported config (the caster carries no centroid
    // elevation), so the receiver stays off under 3D terrain too.
    const useShadowReceiver = !!shadowFrame && !image && !painter.style.map.terrain;
    // World-pixels-per-meter for the receiver's building HEIGHT axis (§4 / native
    // matrixForLightTileWorld): constant across this frame's tiles, computed once at the live zoom so
    // the receiver samples the shadow map at the SAME z-scaled world position the caster wrote depth.
    const shadowPixelsPerMeterValue = useShadowReceiver ? shadowPixelsPerMeter(transform) : 0;
    if (useShadowReceiver) {
        // Bind the cascade maps NEAREST/CLAMP to their sampler units (spec §3.3.2) before the draws.
        for (let c = 0; c < shadowFrame.cascadeCount && c < 4; c++) {
            context.activeTexture.set(gl.TEXTURE0 + shadowFrame.shadowmapUnits[c]);
            shadowFrame.maps[c].texture.bind(gl.NEAREST, gl.CLAMP_TO_EDGE);
        }
    }

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        const bucket: FillExtrusionBucket = (tile.getBucket(layer) as any);
        if (!bucket) continue;

        const terrainData = painter.style.map.terrain && painter.style.map.terrain.getTerrainData(coord);
        const programConfiguration = bucket.programConfigurations.get(layer.id);
        const programName = image ? 'fillExtrusionPattern' : (useShadowReceiver ? 'fillExtrusionShadow' : 'fillExtrusion');
        const program = painter.useProgram(programName, programConfiguration, false, useShadowReceiver ? ['#define RENDER_SHADOWS'] : []);

        if (image) {
            painter.context.activeTexture.set(gl.TEXTURE0);
            tile.imageAtlasTexture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
            programConfiguration.updatePaintBuffers(crossfade);
        }

        const projectionData = transform.getProjectionData({overscaledTileID: coord, applyGlobeMatrix: !isRenderingToTexture, applyTerrainMatrix: true});
        updatePatternPositionsInProgram(programConfiguration, fillPropertyName, constantPattern, tile, layer);

        const translate = translatePosition(
            transform,
            tile,
            layer.paint.get('fill-extrusion-translate'),
            layer.paint.get('fill-extrusion-translate-anchor')
        );

        const shouldUseVerticalGradient = layer.paint.get('fill-extrusion-vertical-gradient');
        let uniformValues;
        if (image) {
            uniformValues = fillExtrusionPatternUniformValues(painter, shouldUseVerticalGradient, opacity, translate, coord, crossfade, tile);
        } else if (useShadowReceiver) {
            uniformValues = fillExtrusionShadowUniformValues(painter, shouldUseVerticalGradient, opacity, translate, {
                lightMatrices: composeTileLightMatrices(coord, transform.worldSize, shadowPixelsPerMeterValue, shadowFrame.cascades),
                cascadeCount: shadowFrame.cascadeCount,
                intensity: shadowFrame.intensity,
                texelSize: shadowFrame.texelSize,
                bias: shadowFrame.bias,
                slopeBias: shadowFrame.slopeBias,
                shadowmapUnits: shadowFrame.shadowmapUnits,
            });
        } else {
            uniformValues = fillExtrusionUniformValues(painter, shouldUseVerticalGradient, opacity, translate);
        }

        program.draw(context, context.gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.backCCW,
            uniformValues, terrainData, projectionData, layer.id, bucket.layoutVertexBuffer, bucket.indexBuffer,
            bucket.segments, layer.paint, painter.transform.zoom,
            programConfiguration, painter.style.map.terrain && bucket.centroidVertexBuffer);
    }
}

/**
 * Per-cascade per-tile `tile-local → light-clip` matrices, flattened into a single `Float32Array` of
 * `16 * cascadeCount` for `u_light_matrix[4]`. Each is `worldToLightClip[c] · lightTileWorldMatrix(coord)`
 * — the SAME z-scaled tile matrix the caster uses, so the receiver samples exactly where the caster
 * wrote depth (spec §3.1). The z-scale (METERS→world-px) MUST match the caster or the roof/wall
 * receiver would sample the wrong shadow-map location.
 */
function composeTileLightMatrices(coord: OverscaledTileID, worldSize: number, pixelsPerMeter: number, cascades: mat4[]): Float32Array {
    const cascadeCount = cascades.length;
    const tileMatrix = lightTileWorldMatrix(coord.toUnwrapped(), worldSize, pixelsPerMeter);
    const out = new Float32Array(16 * cascadeCount);
    const scratch = new Float64Array(16) as unknown as mat4;
    for (let c = 0; c < cascadeCount; c++) {
        mat4.multiply(scratch, cascades[c], tileMatrix);
        out.set(scratch as unknown as ArrayLike<number>, c * 16);
    }
    return out;
}
