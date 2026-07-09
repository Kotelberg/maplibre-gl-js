import {describe, expect, test} from 'vitest';
import {createStyleLayer} from '../create_style_layer';
import {type FillExtrusionStyleLayer} from './fill_extrusion_style_layer';

function feLayer(paint: Record<string, unknown>): FillExtrusionStyleLayer {
    return createStyleLayer({
        id: 'building',
        type: 'fill-extrusion',
        source: 'source',
        paint
    } as any, {}) as FillExtrusionStyleLayer;
}

// The sticky shadow-map cache (render/shadow/shadow_cache) reuses a depth map across frames on the
// assumption that caster geometry depends only on world position. A zoom-interpolated
// fill-extrusion-height violates that: while the camera zooms through the height ramp the cached map
// holds the last refit frame's heights, so live (growing) buildings render against stale caster
// depths and their shadows do not grow with them. `shadowCasterHeightVariesBetween` is the predicate
// the shadow orchestration uses to force a refit — assert it fires INSIDE the ramp and stays silent
// (cache stays sticky) outside it and for zoom-constant heights. Mirrors the native
// `FillExtrusionShadowRefit` suite (branch d3/height-ramp-refit).
describe('FillExtrusionStyleLayer.shadowCasterHeightVariesBetween (spec §3.11)', () => {
    test('a zoom-interpolated height invalidates the sticky cache inside the ramp', () => {
        // The common style shape: height interpolates 0 → 30 m across z14 → z15.
        const layer = feLayer({
            'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 30]
        });

        // Two distinct zooms inside the ramp evaluate to different heights → must refit.
        expect(layer.shadowCasterHeightVariesBetween(14.2, 14.8)).toBe(true);
        // Descending through the ramp (the exact stale-shadow trigger).
        expect(layer.shadowCasterHeightVariesBetween(15.0, 14.0)).toBe(true);
        // Straddling the top of the ramp from above still crosses varying heights.
        expect(layer.shadowCasterHeightVariesBetween(14.5, 16.0)).toBe(true);

        // Entirely ABOVE the ramp (height clamps to 30 m) → no variation → cache stays sticky.
        expect(layer.shadowCasterHeightVariesBetween(16.0, 18.0)).toBe(false);
        // Entirely BELOW the ramp (height clamps to 0) → no variation.
        expect(layer.shadowCasterHeightVariesBetween(10.0, 13.0)).toBe(false);
        // A settled camera (equal zooms) never refits.
        expect(layer.shadowCasterHeightVariesBetween(14.5, 14.5)).toBe(false);
    });

    test('a zoom-interpolated base is an equally valid caster-geometry invalidator', () => {
        const layer = feLayer({
            'fill-extrusion-height': 30,
            'fill-extrusion-base': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 10]
        });
        expect(layer.shadowCasterHeightVariesBetween(14.2, 14.8)).toBe(true);
        expect(layer.shadowCasterHeightVariesBetween(16.0, 18.0)).toBe(false);
    });

    test('a constant height keeps the cache fully sticky at every zoom (zero added refits)', () => {
        const layer = feLayer({'fill-extrusion-height': 30});
        expect(layer.shadowCasterHeightVariesBetween(14.0, 18.0)).toBe(false);
        expect(layer.shadowCasterHeightVariesBetween(14.2, 14.8)).toBe(false);
        expect(layer.shadowCasterHeightVariesBetween(10.0, 22.0)).toBe(false);
    });

    test('a data-driven but zoom-constant height (["get","height"]) keeps the cache sticky', () => {
        // Feature-dependent but NOT zoom-dependent: caster geometry is world-fixed, so a zoom change
        // must NOT force a refit (native `isZoomConstant()` short-circuit).
        const layer = feLayer({'fill-extrusion-height': ['get', 'height']});
        expect(layer.shadowCasterHeightVariesBetween(14.2, 14.8)).toBe(false);
        expect(layer.shadowCasterHeightVariesBetween(14.0, 18.0)).toBe(false);
    });

    test('a composite (zoom-AND-data) height refits conservatively for any zoom change', () => {
        // Can't evaluate a single height without a feature → treat any zoom change as a variation.
        const layer = feLayer({
            'fill-extrusion-height': [
                'interpolate', ['linear'], ['zoom'],
                14, ['get', 'h14'],
                15, ['get', 'h15']
            ]
        });
        expect(layer.shadowCasterHeightVariesBetween(14.2, 14.8)).toBe(true);
        // Even outside a nominal ramp we conservatively refit — we cannot prove the heights are equal.
        expect(layer.shadowCasterHeightVariesBetween(16.0, 18.0)).toBe(true);
        // A settled camera still never refits.
        expect(layer.shadowCasterHeightVariesBetween(15.0, 15.0)).toBe(false);
    });
});
