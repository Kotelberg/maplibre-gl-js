import {afterEach, describe, expect, test, vi} from 'vitest';
import {LngLat} from '../../geo/lng_lat';
import {MercatorTransform} from '../../geo/projection/mercator_transform';

// Mock the GPU-touching building blocks so the orchestration logic (the four gating sites) runs
// without a real WebGL context. These are exercised for real by Task 6's render/browser battery.
const casterCalls: Array<{layerId: string; clearFirst: boolean}> = [];
const groundCalls: Array<{count: number}> = [];
let allocatedMaps = 0;
let destroyedMaps = 0;

vi.mock('./shadow_map', () => ({
    SHADOW_MAP_DEFAULT_SIZE: 1024,
    ShadowMap: class {
        mapSize: number;
        texelSize: number;
        texture = {bind: () => {}};
        constructor(_context: unknown, mapSize = 1024) { this.mapSize = mapSize; this.texelSize = 1 / mapSize; allocatedMaps++; }
        destroy() { destroyedMaps++; }
    }
}));
vi.mock('./draw_shadow_casters', () => ({
    drawShadowCasters: (_p: unknown, _tm: unknown, layer: {id: string}, _c: unknown, _m: unknown, _map: unknown, clearFirst = true) => {
        casterCalls.push({layerId: layer.id, clearFirst});
    }
}));
vi.mock('./draw_ground_shadow', () => ({
    drawGroundShadow: (_p: unknown, coords: Array<unknown>) => { groundCalls.push({count: coords.length}); }
}));

import {ShadowRenderer, shadowHeightFade} from './shadow_renderer';

function makeTransform(zoom: number): MercatorTransform {
    const t = new MercatorTransform({minZoom: 0, maxZoom: 22, minPitch: 0, maxPitch: 70, renderWorldCopies: true});
    t.resize(1024, 768);
    t.setCenter(new LngLat(30.5234, 50.4501));
    t.setZoom(zoom);
    t.setPitch(55);
    return t;
}

/**
 * A minimal fake fill-extrusion layer + tile carrying a bucket. `heightVaries` models the §3.11
 * height-ramp predicate ({@link FillExtrusionStyleLayer.shadowCasterHeightVariesBetween}); it defaults
 * to `() => false` (the common zoom-constant caster — cache stays sticky).
 */
function feLayer(id: string, hasBucket = true, heightVaries: (a: number, b: number) => boolean = () => false) {
    return {
        id,
        type: 'fill-extrusion',
        source: id,
        isHidden: () => false,
        paint: {get: (k: string) => (k === 'fill-extrusion-opacity' ? 1 : undefined)},
        shadowCasterHeightVariesBetween: heightVaries,
        _hasBucket: hasBucket
    };
}

type LightOpts = {castShadows?: boolean; anchor?: 'map' | 'viewport'; intensity?: number};

function makePainter(zoom: number, layers: Array<ReturnType<typeof feLayer>>, light: LightOpts = {}) {
    const _layers: {[id: string]: unknown} = {};
    const tileManagers: {[id: string]: unknown} = {};
    const coords: {[id: string]: Array<{key: string}>} = {};
    for (const l of layers) {
        _layers[l.id] = l;
        coords[l.id] = [{key: `${l.id}-t0`}];
        tileManagers[l.id] = {
            getTile: () => (l._hasBucket ? {getBucket: () => ({})} : {getBucket: () => null})
        };
    }
    const props: {[k: string]: unknown} = {
        'cast-shadows': light.castShadows ?? true,
        'anchor': light.anchor ?? 'map',
        'position': {x: 0.3, y: -0.5, z: 0.8},
        'shadow-intensity': light.intensity ?? 0.32
    };
    const painter = {
        context: {},
        transform: makeTransform(zoom),
        style: {
            light: {properties: {get: (k: string) => props[k]}},
            _layers,
            map: {terrain: null}
        }
    };
    return {painter: painter as any, tileManagers: tileManagers as any, coords: coords as any, layerIds: layers.map(l => l.id)};
}

afterEach(() => {
    casterCalls.length = 0;
    groundCalls.length = 0;
    allocatedMaps = 0;
    destroyedMaps = 0;
});

describe('shadowHeightFade (spec §3.11, [14,15] ramp)', () => {
    test('0 below z14, linear ramp to 1 at z15, held above', () => {
        expect(shadowHeightFade(13.0)).toBe(0);
        expect(shadowHeightFade(14.0)).toBe(0);
        expect(shadowHeightFade(14.5)).toBeCloseTo(0.5, 6);
        expect(shadowHeightFade(15.0)).toBe(1);
        expect(shadowHeightFade(16.0)).toBe(1);
    });
});

describe('ShadowRenderer active gate (site 1) — default-off invariant', () => {
    test('inactive when cast-shadows is false', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(16, [feLayer('a')], {castShadows: false});
        expect(r.beginFrame(painter, layerIds, tileManagers, coords)).toBe(false);
        expect(r.active).toBe(false);
        expect(allocatedMaps).toBe(0);
        expect(casterCalls.length).toBe(0);
    });

    test('inactive when anchor is viewport (unsupported config, §3.9)', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(16, [feLayer('a')], {anchor: 'viewport'});
        expect(r.beginFrame(painter, layerIds, tileManagers, coords)).toBe(false);
        expect(allocatedMaps).toBe(0);
    });

    test('inactive when no fill-extrusion layer has render tiles', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(16, []);
        expect(r.beginFrame(painter, layerIds, tileManagers, coords)).toBe(false);
        expect(allocatedMaps).toBe(0);
    });
});

describe('ShadowRenderer caster pass + usable latch (sites 1/4) & ground ownership (site 3)', () => {
    test('active frame allocates one cascade map, renders casters, latches usable', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(16, [feLayer('a')]);
        expect(r.beginFrame(painter, layerIds, tileManagers, coords)).toBe(true);
        expect(allocatedMaps).toBe(1); // default 1 cascade
        expect(casterCalls.length).toBe(1);
        expect(casterCalls[0].clearFirst).toBe(true);
        expect(r.frustumState.shadowMapUsable).toBe(true);
        const frame = r.getBuildingShadowFrame();
        expect(frame).not.toBeNull();
        // intensity = 0.32 * heightFade(16=1) * usable(1)
        expect(frame!.intensity).toBeCloseTo(0.32, 6);
        expect(frame!.cascadeCount).toBe(1);
    });

    test('first (lowest-index) FE layer owns the single ground draw; casters accumulate (clearFirst false)', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(16, [feLayer('a'), feLayer('b')]);
        expect(r.beginFrame(painter, layerIds, tileManagers, coords)).toBe(true);
        expect(r.isGroundOwner('a')).toBe(true);
        expect(r.isGroundOwner('b')).toBe(false);
        // One cascade, two FE layers: first clears, second accumulates into the shared map.
        expect(casterCalls.map(c => c.clearFirst)).toEqual([true, false]);
        // The caller (drawFillExtrusion) draws the ground only for the owning layer; when it does, one
        // premultiplied overlay is emitted over the covering tiles.
        r.drawGround(painter, coords['a']);
        expect(groundCalls.length).toBe(1);
    });

    test('height fade zeroes intensity below z14 (no footprint blobs)', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(13, [feLayer('a')]);
        r.beginFrame(painter, layerIds, tileManagers, coords);
        expect(r.getBuildingShadowFrame()!.intensity).toBe(0);
    });
});

describe('ShadowRenderer sticky cache (site 1) — no re-render on a settled frame', () => {
    test('a second settled frame reuses the maps (no caster re-render)', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(16, [feLayer('a')]);
        r.beginFrame(painter, layerIds, tileManagers, coords);
        const firstCasterCount = casterCalls.length;
        expect(firstCasterCount).toBe(1);
        // Same zoom, same tile signature → cache hit → no refit → no new caster draws.
        r.beginFrame(painter, layerIds, tileManagers, coords);
        expect(casterCalls.length).toBe(firstCasterCount);
        expect(r.active).toBe(true);
        // usable stays latched.
        expect(r.getBuildingShadowFrame()!.intensity).toBeCloseTo(0.32, 6);
    });

    test('a changed caster tile-set forces a refit + re-render', () => {
        const r = new ShadowRenderer({} as any);
        const {painter, tileManagers, coords, layerIds} = makePainter(16, [feLayer('a')]);
        r.beginFrame(painter, layerIds, tileManagers, coords);
        expect(casterCalls.length).toBe(1);
        // New tile streamed in → different signature → refit.
        coords['a'] = [{key: 'a-t0'}, {key: 'a-t1'}];
        r.beginFrame(painter, layerIds, tileManagers, coords);
        expect(casterCalls.length).toBe(2);
    });
});

describe('ShadowRenderer height-ramp refit (spec §3.11, native d3/height-ramp-refit)', () => {
    // Two nearby zooms whose natural cache would HIT (no zoom-in / pan-out refit): isolates the
    // height-ramp predicate as the sole cause of the second frame's refit.
    const Z_LO = 14.3;
    const Z_HI = 14.6;

    test('a zoom-constant caster keeps the sticky cache across the ramp band (control — no refit)', () => {
        const r = new ShadowRenderer({} as any);
        // heightVaries === false (the ['get','height']/constant case).
        const first = makePainter(Z_LO, [feLayer('a', true, () => false)]);
        r.beginFrame(first.painter, first.layerIds, first.tileManagers, first.coords);
        expect(casterCalls.length).toBe(1);
        // Zoom moved inside the [14,15] band but the caster geometry is zoom-fixed → cache hit.
        const second = makePainter(Z_HI, [feLayer('a', true, () => false)]);
        r.beginFrame(second.painter, second.layerIds, second.tileManagers, second.coords);
        expect(casterCalls.length).toBe(1);
    });

    test('a zoom-interpolated height forces a per-frame refit inside the ramp', () => {
        const r = new ShadowRenderer({} as any);
        // heightVaries === true whenever the two compared zooms differ (a camera height curve in-band).
        const varies = (a: number, b: number) => a !== b;
        const first = makePainter(Z_LO, [feLayer('a', true, varies)]);
        r.beginFrame(first.painter, first.layerIds, first.tileManagers, first.coords);
        expect(casterCalls.length).toBe(1);
        // Same tile signature, cache would otherwise hit — but the live vs cached zoom extrude to
        // different heights, so the casters MUST re-render at the current (grown) heights.
        const second = makePainter(Z_HI, [feLayer('a', true, varies)]);
        r.beginFrame(second.painter, second.layerIds, second.tileManagers, second.coords);
        expect(casterCalls.length).toBe(2);
    });

    test('heightRampRefitDisabled reproduces the stale-shadow defect (sticky cache not force-refit)', () => {
        const r = new ShadowRenderer({} as any);
        r.heightRampRefitDisabled = true;
        const varies = (a: number, b: number) => a !== b;
        const first = makePainter(Z_LO, [feLayer('a', true, varies)]);
        r.beginFrame(first.painter, first.layerIds, first.tileManagers, first.coords);
        expect(casterCalls.length).toBe(1);
        const second = makePainter(Z_HI, [feLayer('a', true, varies)]);
        r.beginFrame(second.painter, second.layerIds, second.tileManagers, second.coords);
        // Escape hatch on → no forced refit → shadows go stale (the defect the flag reproduces).
        expect(casterCalls.length).toBe(1);
    });
});

describe('ShadowRenderer runtime teardown (site 2)', () => {
    test('turning cast-shadows off after being on frees the maps', () => {
        const r = new ShadowRenderer({} as any);
        const on = makePainter(16, [feLayer('a')]);
        r.beginFrame(on.painter, on.layerIds, on.tileManagers, on.coords);
        expect(allocatedMaps).toBe(1);
        const off = makePainter(16, [feLayer('a')], {castShadows: false});
        expect(r.beginFrame(off.painter, off.layerIds, off.tileManagers, off.coords)).toBe(false);
        expect(destroyedMaps).toBe(1);
        expect(r.maps.length).toBe(0);
    });
});
