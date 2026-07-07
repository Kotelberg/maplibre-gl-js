import {
    createShadowFrustumState,
    updateShadowFrame,
    markShadowMapUsable,
    type ShadowFrustumState,
    type ShadowLightInput
} from './shadow_cache';
import {ShadowMap} from './shadow_map';
import {drawShadowCasters} from './draw_shadow_casters';
import {drawGroundShadow} from './draw_ground_shadow';
import {isFillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer';

import type {mat4} from 'gl-matrix';
import type {Painter} from '../painter';
import type {Context} from '../../gl/context';
import type {TileManager} from '../../tile/tile_manager';
import type {StyleLayer} from '../../style/style_layer';
import type {FillExtrusionStyleLayer} from '../../style/style_layer/fill_extrusion_style_layer';
import type {FillExtrusionBucket} from '../../data/bucket/fill_extrusion_bucket';
import type {OverscaledTileID} from '../../tile/tile_id';

/**
 * fill-extrusion cast-shadow height fade. Verbatim port of native `shadowHeightFade`
 * (`shadow_tweakers.cpp:54-62`, spec §3.11): shadows are a 3D-building effect and must fade in across
 * the `[14,15]` zoom band where extruded buildings rise to full height, so a near-flat low-zoom
 * building does not cast a footprint-shaped blob on the 2D map. Returns `0` below z14, ramps linearly
 * to `1` at z15, holds `1` above.
 */
export function shadowHeightFade(zoom: number): number {
    const lo = 14.0;
    const hi = 15.0;
    if (hi <= lo) return 1.0;
    const t = (zoom - lo) / (hi - lo);
    return t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
}

/** Default shadow overlay color: black (premultiply-safe — `0 * a == 0`). */
const SHADOW_COLOR: [number, number, number, number] = [0, 0, 0, 1];
/** Texture units the (up to four) cascade maps bind to. */
const SHADOWMAP_UNITS: [number, number, number, number] = [0, 1, 2, 3];

/**
 * Per-frame building-receiver inputs, produced by {@link ShadowRenderer.beginFrame} and consumed by
 * `draw_fill_extrusion.ts` when it swaps the stock FE program for the `fillExtrusionShadow` variant.
 */
export type BuildingShadowFrame = {
    /** Per-cascade world-px to light-clip matrices (`liveCascades`), shared with the caster. */
    cascades: mat4[];
    cascadeCount: number;
    texelSize: number;
    /** Evaluated `shadow-intensity` already gated by `shadowHeightFade(zoom)` and `shadowMapUsable`. */
    intensity: number;
    /** The per-cascade packed-depth maps to bind to {@link SHADOWMAP_UNITS}. */
    maps: ShadowMap[];
    shadowmapUnits: [number, number, number, number];
    /** Shipped §3.6 bias pair. */
    bias: number;
    slopeBias: number;
};

/**
 * Painter-owned shadow orchestration (spec §3.1). Encapsulates the whole cast-shadow lifecycle — the
 * sticky frustum cache, the per-cascade shadow maps, the offscreen caster pass, and the per-frame
 * receiver inputs — behind the four gating sites native's `RenderOrchestrator` uses:
 *
 * 1. **Active gate + caster pass** ({@link beginFrame}): shadows run only when the scene light's
 *    evaluated `cast-shadows` is true, `anchor` is `map`, and at least one fill-extrusion layer has
 *    render tiles. On a frustum-cache refit the offscreen caster pass repopulates the maps; on a
 *    cache-hit frame the previously-rendered maps are reused (sticky cache → no flicker under pan).
 * 2. **Runtime teardown** ({@link beginFrame} inactive branch): `cast-shadows` turned off after being
 *    on frees the maps so nothing renders or samples stale casters.
 * 3. **Per-layer hand-off + ground-once ownership** ({@link isGroundOwner}): the first (lowest-index)
 *    fill-extrusion layer with render tiles draws the single ground-shadow overlay; higher FE layers
 *    cast into the shared map but draw no ground (native per-`fill-extrusion`-layer ownership).
 * 4. **`shadowMapUsable` latch** ({@link beginFrame}): the receiver intensity gate latches true only
 *    after a refit frame actually rendered casters, so the first frame after enabling never samples an
 *    un-rendered map (the D3 grey-roof guard, §3.3.3). In gl-js the caster pass runs in the offscreen
 *    phase before the translucent receiver draw, so once latched every settled frame multiplies
 *    intensity by exactly 1 — byte-identical to an un-gated path.
 *
 * The instance is created lazily by the painter the first time `cast-shadows` is requested and held
 * across frames (the sticky cache lives in `frustumState`). While inactive it holds no GPU resources.
 */
export class ShadowRenderer {
    context: Context;
    frustumState: ShadowFrustumState;
    /** Per-cascade packed-depth render targets, persisted across frames (the sticky cache substrate). */
    maps: ShadowMap[] = [];
    private allocatedMapSize = 0;
    private allocatedCascadeCount = 0;
    /** Signature of the covering-tile set the maps were last rendered against (caster-dirty detection). */
    private lastCasterSignature = '';

    // Per-frame state, set by beginFrame(), read by the FE draw. Reset to inactive each frame.
    active = false;
    private frame: BuildingShadowFrame | null = null;
    private groundOwnerLayerId: string | null = null;

    constructor(context: Context) {
        this.context = context;
        this.frustumState = createShadowFrustumState();
    }

    /**
     * Site 1 + 2 + 4. Evaluate the active gate, drive the frustum cache, render the caster pass on a
     * refit, latch `shadowMapUsable`, and precompute the per-frame receiver inputs. Returns whether
     * shadows are active this frame. Called once per frame from `painter.render()` in the offscreen
     * phase, before the opaque/translucent passes.
     *
     * @param painter - the painter (context, transform, program cache).
     * @param layerIds - the style layer order (z-order, low index first).
     * @param tileManagers - the per-source tile managers.
     * @param coords - the covering tile IDs per source (the same set the FE draw iterates).
     */
    beginFrame(
        painter: Painter,
        layerIds: Array<string>,
        tileManagers: {[_: string]: TileManager},
        coords: {[_: string]: Array<OverscaledTileID>}
    ): boolean {
        this.active = false;
        this.frame = null;
        this.groundOwnerLayerId = null;

        const light = painter.style.light;
        const castShadows = light.properties.get('cast-shadows') === true;
        const anchor = light.properties.get('anchor');

        // The fill-extrusion layers in z-order that are visible and have covering tiles.
        const feLayers: Array<{layer: FillExtrusionStyleLayer; coords: Array<OverscaledTileID>; tileManager: TileManager}> = [];
        if (castShadows && anchor === 'map') {
            for (const layerId of layerIds) {
                const layer = painter.style._layers[layerId] as StyleLayer;
                if (!isFillExtrusionStyleLayer(layer)) continue;
                if (layer.isHidden(painter.transform.zoom)) continue;
                if (layer.paint.get('fill-extrusion-opacity') === 0) continue;
                const layerCoords = coords[layer.source];
                if (!layerCoords || layerCoords.length === 0) continue;
                feLayers.push({layer, coords: layerCoords, tileManager: tileManagers[layer.source]});
            }
        }

        // Active gate (site 1): declaratively enabled, world-anchored, and something to cast.
        if (!castShadows || anchor !== 'map' || feLayers.length === 0) {
            // Site 2: teardown if shadows were previously on (frees maps so nothing renders stale casters).
            this.teardown();
            return false;
        }

        const zoom = painter.transform.zoom;

        // Caster-set signature: a change (tiles streamed in/out, layer set changed) forces a refit so
        // newly-loaded buildings cast this frame instead of being missing from a reused map.
        const signature = this.casterSignature(feLayers);
        const castersDirty = signature !== this.lastCasterSignature;

        const lightInput: ShadowLightInput = {
            position: light.properties.get('position'),
            anchor,
            castShadows: true,
            shadowIntensity: light.properties.get('shadow-intensity')
        };

        const frameInfo = updateShadowFrame(this.frustumState, painter.transform, lightInput, {castersDirty});

        // Ensure the per-cascade maps match the active cascade count + map size (reallocate on change).
        this.ensureMaps(frameInfo.cascadeCount, frameInfo.mapSize);

        // On a refit (site 1) repopulate the maps; on a cache-hit frame reuse them (sticky cache).
        if (frameInfo.refitThisFrame) {
            const castersDrawn = this.renderCasterPass(painter, feLayers, frameInfo.cascades);
            this.lastCasterSignature = signature;
            // Site 4: latch the usable gate once a refit actually rendered casters. The caster pass ran
            // just now (offscreen), before this frame's translucent receiver draw, so the receiver may
            // safely sample the freshly-populated map this same frame.
            if (castersDrawn > 0) markShadowMapUsable(this.frustumState);
        }

        const usable = this.frustumState.shadowMapUsable;
        // §3.11 / §3.3.3: strength = evaluated intensity x height-fade x usable-gate.
        const intensity = lightInput.shadowIntensity * shadowHeightFade(zoom) * (usable ? 1 : 0);

        this.frame = {
            cascades: frameInfo.cascades,
            cascadeCount: frameInfo.cascadeCount,
            texelSize: frameInfo.texelSize,
            intensity,
            maps: this.maps,
            shadowmapUnits: SHADOWMAP_UNITS,
            bias: 0.0,
            slopeBias: 0.05
        };

        // Site 3: ground-once ownership — the first FE layer with render tiles owns the ground draw.
        this.groundOwnerLayerId = feLayers[0].layer.id;
        this.active = true;
        return true;
    }

    /** The per-frame building-receiver inputs, or null when shadows are inactive this frame. */
    getBuildingShadowFrame(): BuildingShadowFrame | null {
        return this.active ? this.frame : null;
    }

    /** Whether this layer owns the single ground-shadow draw this frame (site 3). */
    isGroundOwner(layerId: string): boolean {
        return this.active && this.groundOwnerLayerId === layerId;
    }

    /**
     * Draw the ground-shadow overlay once for the owning FE layer (site 3). No-op when inactive, when
     * this layer is not the owner, or when the gated intensity is zero.
     */
    drawGround(painter: Painter, coords: Array<OverscaledTileID>): void {
        if (!this.active || !this.frame || this.frame.intensity <= 0.0) return;
        drawGroundShadow(painter, coords, {
            worldToLightClip: this.frame.cascades,
            shadowMaps: this.frame.maps,
            shadowColor: SHADOW_COLOR,
            intensity: this.frame.intensity,
            bias: this.frame.bias,
            // Fades disabled by default (the shader early-outs on 0); the fit does not yet emit them.
            fadeStart: 0,
            depthFadeStart: 0,
            depthFadeEnd: 0
        });
    }

    /**
     * Render the offscreen caster pass into every active cascade map. Each cascade is cleared to far
     * ONCE (by the first FE layer) then every casting layer accumulates into it — so multiple FE
     * layers share one shadow map (native's single shared map, spec §3.1) without wiping each other.
     * Returns the number of FE layers that actually contributed a caster (the usable-latch input).
     */
    private renderCasterPass(
        painter: Painter,
        feLayers: Array<{layer: FillExtrusionStyleLayer; coords: Array<OverscaledTileID>; tileManager: TileManager}>,
        cascades: mat4[]
    ): number {
        let contributingLayers = 0;
        for (let c = 0; c < this.maps.length && c < cascades.length; c++) {
            const map = this.maps[c];
            const worldToLightClip = cascades[c];
            for (let i = 0; i < feLayers.length; i++) {
                const {layer, coords, tileManager} = feLayers[i];
                drawShadowCasters(painter, tileManager, layer, coords, worldToLightClip, map, /* clearFirst */ i === 0);
                if (c === 0 && this.layerHasCaster(tileManager, layer, coords)) {
                    contributingLayers++;
                }
            }
        }
        return contributingLayers;
    }

    /** Whether any covering tile of this FE layer carries a fill-extrusion bucket (a real caster). */
    private layerHasCaster(
        tileManager: TileManager,
        layer: FillExtrusionStyleLayer,
        coords: Array<OverscaledTileID>
    ): boolean {
        for (const coord of coords) {
            const tile = tileManager.getTile(coord);
            if (tile && (tile.getBucket(layer) as FillExtrusionBucket)) return true;
        }
        return false;
    }

    /** (Re)allocate the per-cascade maps when the active cascade count or map size changed. */
    private ensureMaps(cascadeCount: number, mapSize: number): void {
        if (this.allocatedMapSize === mapSize && this.allocatedCascadeCount === cascadeCount && this.maps.length === cascadeCount) {
            return;
        }
        for (const m of this.maps) m.destroy();
        this.maps = [];
        for (let c = 0; c < cascadeCount; c++) {
            this.maps.push(new ShadowMap(this.context, mapSize));
        }
        this.allocatedMapSize = mapSize;
        this.allocatedCascadeCount = cascadeCount;
        // The freshly-allocated maps are seeded to far but hold no casters yet — force a caster render
        // and drop the usable latch until it repopulates.
        this.lastCasterSignature = '';
    }

    /** A stable string signature of the covering-tile set across all casting FE layers. */
    private casterSignature(
        feLayers: Array<{layer: FillExtrusionStyleLayer; coords: Array<OverscaledTileID>}>
    ): string {
        const parts: Array<string> = [];
        for (const {layer, coords} of feLayers) {
            parts.push(layer.id);
            for (const coord of coords) parts.push(coord.key);
        }
        return parts.join(',');
    }

    /** Site 2: free all GPU resources (maps) and reset the cache to the invalid sentinel. */
    teardown(): void {
        if (this.maps.length === 0 && this.allocatedCascadeCount === 0) return;
        for (const m of this.maps) m.destroy();
        this.maps = [];
        this.allocatedMapSize = 0;
        this.allocatedCascadeCount = 0;
        this.lastCasterSignature = '';
        this.frustumState = createShadowFrustumState();
    }

    /** Free all resources permanently (map removal / painter teardown). */
    destroy(): void {
        this.teardown();
    }
}
