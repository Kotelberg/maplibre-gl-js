import {mat4} from 'gl-matrix';
import {Color} from '@maplibre/maplibre-gl-style-spec';

import {DepthMode} from '../../gl/depth_mode';
import {StencilMode} from '../../gl/stencil_mode';
import {ColorMode} from '../../gl/color_mode';
import {CullFaceMode} from '../../gl/cull_face_mode';
import {calculateTileMatrix} from '../../geo/projection/mercator_utils';
import {shadowDepthUniformValues} from '../program/shadow_depth_program';

import type {ShadowMap} from './shadow_map';
import type {Painter} from '../painter';
import type {TileManager} from '../../tile/tile_manager';
import type {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer';
import type {FillExtrusionBucket} from '../../data/bucket/fill_extrusion_bucket';
import type {OverscaledTileID} from '../../tile/tile_id';

/**
 * Render one shadow caster pass into a single cascade's {@link ShadowMap}.
 *
 * Iterates the fill-extrusion layer's covering tiles (the same set the visible FE draw uses) and
 * issues one depth-tested caster draw per tile with the tile's `tile→light-clip` matrix. This is
 * gl-js's analog of native's per-drawable `ShadowDepthTweaker` loop: gl-js has no drawables, so the
 * per-drawable UBO fields become per-tile uniforms (spec §3.1).
 *
 * The caster co-locates with the visible building because it (a) reuses the FE layer's
 * `programConfiguration` — so the `#pragma mapbox` base/height interpolate to the identical values
 * at the same fractional `zoom` — and (b) uses the SAME per-tile world matrix as the FE draw, only
 * swapping the view-projection for `worldToLightClip` (spec §3.11).
 *
 * The `worldToLightClip` (world → light-clip) matrix is supplied by the caller; the light frustum
 * fit + cascade matrices arrive in a later task. This function performs the pass into an
 * already-selected cascade target; the caller (painter orchestration) selects the cascade, drives
 * the per-frame fit, and restores the default framebuffer + viewport afterwards.
 *
 * NOTE (terrain): the caster does not apply gl-js's TERRAIN3D centroid-elevation offset, so shadows
 * are only faithful without 3D terrain. This matches native (no terrain shadows) and is a
 * documented follow-up for the painter-integration task.
 *
 * @param painter - the painter (context, transform, program cache).
 * @param tileManager - the FE layer's tile manager (covering tiles + buckets).
 * @param layer - the fill-extrusion layer casting shadows.
 * @param coords - the covering tile IDs to render (the same set the visible FE draw iterates).
 * @param worldToLightClip - world → light-clip matrix for this cascade.
 * @param shadowMap - the destination cascade's packed-depth render target.
 */
export function drawShadowCasters(
    painter: Painter,
    tileManager: TileManager,
    layer: FillExtrusionStyleLayer,
    coords: Array<OverscaledTileID>,
    worldToLightClip: mat4,
    shadowMap: ShadowMap): void {

    const context = painter.context;
    const gl = context.gl;
    const transform = painter.transform;

    // §3.3.3: clear the packed-depth map to far-white (and depth to 1.0) at the start of every
    // caster pass. Binds the cascade's framebuffer + viewport.
    context.bindFramebuffer.set(shadowMap.framebuffer.framebuffer);
    context.viewport.set([0, 0, shadowMap.mapSize, shadowMap.mapSize]);
    context.clear({color: Color.white, depth: 1});

    // §3.3.3 caster half: depth-tested (LessEqual + write) over the map's full [0,1] depth range, so
    // the nearest-to-light packed color survives via the hardware depth test (not last-write-wins).
    const depthMode = new DepthMode(gl.LEQUAL, DepthMode.ReadWrite, [0, 1]);
    // §3.5: front-face-only caster (cull BACK) — FE meshes are open (walls + roof, no floor); the
    // roof + sun-facing walls are the true occluders. Same winding as the visible FE draw
    // (backCCW). Never flip the cull to hide self-shadow — that is the receiver bias's job (§3.6).
    const cullMode = CullFaceMode.backCCW;
    // Write all RGBA channels of the packed depth, no blending.
    const colorMode = ColorMode.unblended;

    for (const coord of coords) {
        const tile = tileManager.getTile(coord);
        const bucket = tile?.getBucket(layer) as FillExtrusionBucket;
        if (!bucket) continue;

        const programConfiguration = bucket.programConfigurations.get(layer.id);
        // forceSimpleProjection: the caster projects via u_light_matrix (mercator world → light
        // clip), not via the globe projection prelude.
        const program = painter.useProgram('shadowDepth', programConfiguration, true);

        // tile-local → light-clip = worldToLightClip · (tile-local → mercator world). The same tile
        // matrix the visible FE draw builds via getProjectionData, with only the view-projection
        // swapped for the light matrix.
        const tileMatrix = calculateTileMatrix(coord.toUnwrapped(), transform.worldSize);
        const lightTileMatrix = mat4.multiply(new Float64Array(16) as unknown as mat4, worldToLightClip, tileMatrix);

        program.draw(
            context, gl.TRIANGLES, depthMode, StencilMode.disabled, colorMode, cullMode,
            shadowDepthUniformValues(new Float32Array(lightTileMatrix)),
            // No terrain data, no projectionData (u_light_matrix is the caster's own transform).
            null, null,
            // Distinct VAO cache key so the caster's VAO does not collide with the visible FE draw's
            // VAO for the same layer id + segment (they use different programs).
            `${layer.id}$shadowDepth`,
            bucket.layoutVertexBuffer, bucket.indexBuffer, bucket.segments,
            layer.paint, transform.zoom, programConfiguration);
    }
}
