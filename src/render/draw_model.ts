import {mat4} from 'gl-matrix';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {DepthMode} from '../gl/depth_mode';
import {StencilMode} from '../gl/stencil_mode';
import {CullFaceMode} from '../gl/cull_face_mode';
import {mercatorZfromAltitude} from '../geo/mercator_coordinate';
import {clamp} from '../util/util';
import {modelUniformValues} from './program/model_program';
import {coverSignature, readModelPlacements} from './model/model_placement';
import {buildModelGeometry} from './model/model_geometry';

import type {Painter, RenderOptions} from './painter';
import type {TileManager} from '../tile/tile_manager';
import type {ModelStyleLayer} from '../style/style_layer/model_style_layer';
import type {OverscaledTileID} from '../tile/tile_id';
import type {BuiltModels, BuiltGroup, BuiltPart} from './model/model_geometry';
import type {Mesh} from './mesh';
import type {Context} from '../gl/context';
import type {Texture, TextureFilter, TextureWrap} from './texture';

// Grow/fade zoom band, verbatim from native `building_extrusion_zoom_ramp.hpp`:
// models rise from the ground over [14, 15] (z-scale) so they stay in sync with
// the fill-extrusion height reveal, with a shorter alpha fade over [14, 14.6]
// (a mesh collapsed onto the ground plane at grow~0 has coplanar, z-fighting
// faces and must fade in). Both ends are integer-aligned deliberately.
const GROW_ZOOM_START = 14.0;
const GROW_ZOOM_END = 15.0;
const FADE_ZOOM_END = 14.6;

function growFactor(zoom: number): number {
    return clamp((zoom - GROW_ZOOM_START) / (GROW_ZOOM_END - GROW_ZOOM_START), 0, 1);
}
function fadeFactor(zoom: number): number {
    return clamp((zoom - GROW_ZOOM_START) / (FADE_ZOOM_END - GROW_ZOOM_START), 0, 1);
}

/**
 * Test/determinism knob (the web analogue of native's `MLN_MODEL_NO_DEBOUNCE`):
 * when true, the one-frame rebuild debounce is disabled so a placement rebuild
 * happens the same frame the cover changes. Not style surface — render tests and
 * demos set it for deterministic screenshots.
 */
let modelNoDebounce = false;
export function setModelNoDebounce(value: boolean) {
    modelNoDebounce = value;
}

type ModelRenderState = {
    built: BuiltModels | null;
    builtCoverSig: string | null;
    lastCoverSig: string | null;
    placementKey: string | null;
    featureCount: number;
    registryVersion: number;
};

const renderStates = new WeakMap<ModelStyleLayer, ModelRenderState>();

function getState(layer: ModelStyleLayer): ModelRenderState {
    let state = renderStates.get(layer);
    if (!state) {
        state = {built: null, builtCoverSig: null, lastCoverSig: null, placementKey: null, featureCount: 0, registryVersion: -1};
        renderStates.set(layer, state);
    }
    return state;
}

export function drawModel(painter: Painter, tileManager: TileManager, layer: ModelStyleLayer, coords: Array<OverscaledTileID>, _renderOptions: RenderOptions) {
    // Only ever draws in the translucent (depth-correct 3D) pass.
    if (painter.renderPass !== 'translucent') return;

    const opacity = layer.paint.get('model-opacity');
    if (opacity <= 0) return;

    const modelManager = painter.style.modelManager;
    const state = getState(layer);
    const registryVersion = modelManager.version;

    ensureGeometry(painter, tileManager, layer, coords, state, registryVersion);

    if (!state.built || state.built.groups.length === 0) return;

    drawGroups(painter, layer, state.built, opacity);
}

/**
 * Rebuild the baked geometry only when it can have changed: a different cover
 * (FNV early-out), a different placement set, or a registry change (a model
 * finished loading). A cover still churning under fast camera motion debounces
 * one frame — the existing world-anchored geometry keeps rendering meanwhile.
 */
function ensureGeometry(
    painter: Painter,
    tileManager: TileManager,
    layer: ModelStyleLayer,
    coords: Array<OverscaledTileID>,
    state: ModelRenderState,
    registryVersion: number
) {
    const coverSig = coverSignature(coords);
    const sourceSame = registryVersion === state.registryVersion;

    // Nothing changed since the last build — draw the cached geometry.
    if (state.built && coverSig === state.builtCoverSig && sourceSame) return;

    // Debounce: cover is still moving and the registry is unchanged — hold the
    // existing (world-anchored, still-correct) geometry one more frame.
    if (!modelNoDebounce && sourceSame && state.built && coverSig !== state.lastCoverSig) {
        state.lastCoverSig = coverSig;
        return;
    }
    state.lastCoverSig = coverSig;

    const placements = readModelPlacements(coords, tileManager, layer, painter.style._availableImages || []);
    const changed = !state.built ||
        placements.placementKey !== state.placementKey ||
        placements.instances.length !== state.featureCount ||
        registryVersion !== state.registryVersion;

    if (changed) {
        if (state.built) state.built.destroy();
        state.built = buildModelGeometry(painter.context, placements.instances, painter.style.modelManager);
        state.placementKey = placements.placementKey;
        state.featureCount = placements.instances.length;
    }
    state.builtCoverSig = coverSig;
    state.registryVersion = registryVersion;
}

function drawGroups(painter: Painter, layer: ModelStyleLayer, built: BuiltModels, opacity: number) {
    const context = painter.context;
    const gl = context.gl;
    const transform = painter.transform;
    const zoom = transform.zoom;
    const worldSize = transform.worldSize;
    const grow = growFactor(zoom);
    const fade = fadeFactor(zoom);

    const program = painter.useProgram('model', null, true);
    const colorMode = painter.colorModeForRenderPass();
    const stencilMode = StencilMode.disabled;
    const depthModelParts = new DepthMode(gl.LEQUAL, DepthMode.ReadWrite, painter.depthRangeFor3D);
    // Contact shadows test depth (so terrain/buildings occlude them) but do not
    // write it, so they never occlude the models drawn on top.
    const depthShadow = new DepthMode(gl.LEQUAL, DepthMode.ReadOnly, painter.depthRangeFor3D);

    for (const group of built.groups) {
        const matrix = groupMatrix(mat4.create(), transform.modelViewProjectionMatrix as mat4, group, worldSize, grow);

        // Contact shadow first (premultiplied black, deepening on the grow ramp).
        if (group.shadow && group.shadowTexture) {
            bindTexture(context, group.shadowTexture, gl.LINEAR, gl.CLAMP_TO_EDGE);
            const shadowColor = new Color(grow, grow, grow, grow, true);
            drawMesh(program, context, painter, layer, group.shadow, matrix, shadowColor, true, depthShadow, stencilMode, colorMode);
        }

        for (const part of group.parts) {
            let color: Color;
            if (part.textured) {
                bindTexture(context, part.texture, part.nearest ? gl.NEAREST : gl.LINEAR, part.nearest ? gl.CLAMP_TO_EDGE : gl.REPEAT, part.nearest ? null : gl.LINEAR_MIPMAP_NEAREST);
                color = new Color(fade, fade, fade, opacity * fade, true);
            } else {
                const c = part.color;
                color = new Color(c[0] * fade, c[1] * fade, c[2] * fade, c[3] * opacity * fade, true);
            }
            drawMesh(program, context, painter, layer, part.mesh, matrix, color, part.textured, depthModelParts, stencilMode, colorMode);
        }
    }
}

/**
 * Per-frame group matrix: baked ground-meters (relative to the group anchor)
 * → clip. Anchor → world pixels via `worldSize`; meters → world pixels (x/y)
 * via `pxPerMeter` at the anchor latitude; z stays meters (the MVP matrix bakes
 * the meters→clip z scale) and is scaled by the grow ramp so the model rises.
 * Ported from native's per-frame tweaker in `render_model_layer.cpp`.
 */
function groupMatrix(out: mat4, viewProj: mat4, group: BuiltGroup, worldSize: number, grow: number): mat4 {
    const pxPerMeter = mercatorZfromAltitude(1, group.lat0) * worldSize;
    mat4.translate(out, viewProj, [group.anchorFx * worldSize, group.anchorFy * worldSize, 0]);
    mat4.scale(out, out, [pxPerMeter, pxPerMeter, grow]);
    return out;
}

function bindTexture(context: Context, texture: Texture, filter: TextureFilter, wrap: TextureWrap, minFilter?: TextureFilter | null) {
    context.activeTexture.set(context.gl.TEXTURE0);
    texture.bind(filter, wrap, minFilter);
}

function drawMesh(
    program: ReturnType<Painter['useProgram']>,
    context: Painter['context'],
    painter: Painter,
    layer: ModelStyleLayer,
    mesh: Mesh,
    matrix: mat4,
    color: Color,
    textured: boolean,
    depthMode: Readonly<DepthMode>,
    stencilMode: Readonly<StencilMode>,
    colorMode: ReturnType<Painter['colorModeForRenderPass']>
) {
    const uniforms = modelUniformValues(matrix, color, textured);
    program.draw(
        context, context.gl.TRIANGLES, depthMode, stencilMode, colorMode, CullFaceMode.disabled,
        uniforms, null, undefined, layer.id, mesh.vertexBuffer, mesh.indexBuffer, mesh.segments,
        layer.paint, painter.transform.zoom
    );
}

// Keep the linter aware these BuiltPart fields are used above.
export type {BuiltPart};
