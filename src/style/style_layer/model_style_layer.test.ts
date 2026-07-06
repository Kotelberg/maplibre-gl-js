import {describe, test, expect} from 'vitest';
import {createStyleLayer} from '../create_style_layer';
import {ModelStyleLayer, isModelStyleLayer} from './model_style_layer';
import {type LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import {type EvaluationParameters} from '../evaluation_parameters';
import {type TransitionParameters} from '../properties';

const evalParams = {zoom: 0, zoomHistory: {}} as EvaluationParameters;

function makeLayer(overrides: any = {}): ModelStyleLayer {
    const layer = createStyleLayer({
        id: 'm',
        type: 'model',
        source: 'points',
        ...overrides
    } as LayerSpecification, {}) as ModelStyleLayer;
    layer.updateTransitions({} as TransitionParameters);
    layer.recalculate(evalParams, undefined);
    return layer;
}

describe('ModelStyleLayer', () => {
    test('createStyleLayer instantiates a ModelStyleLayer for type "model"', () => {
        const layer = createStyleLayer({id: 'm', type: 'model', source: 'points'} as LayerSpecification, {});
        expect(layer instanceof ModelStyleLayer).toBe(true);
        expect(isModelStyleLayer(layer as any)).toBe(true);
        expect(layer.type).toBe('model');
    });

    test('evaluates the codegen defaults from the style spec', () => {
        const layer = makeLayer();
        // data-constant paint
        expect(layer.paint.get('model-opacity')).toBe(1);
        // data-driven paints, evaluated as their constant defaults
        expect(layer.paint.get('model-scale').evaluate({} as any, {})).toBe(20);
        expect(layer.paint.get('model-rotation').evaluate({} as any, {})).toBe(0);
        expect(layer.paint.get('model-footprint').evaluate({} as any, {})).toBe(1);
        // model-id declares no spec default (verbatim from native v8.json, where the
        // "" default is only a C++ string language-default), so it evaluates to undefined.
        expect(layer.layout.get('model-id').evaluate({} as any, {})).toBeUndefined();
    });

    test('resolves a constant model-id from the layout', () => {
        const layer = makeLayer({layout: {'model-id': 'tower'}});
        expect(layer.layout.get('model-id').evaluate({} as any, {})).toBe('tower');
    });

    test('evaluates data-driven expressions per feature', () => {
        const layer = makeLayer({
            layout: {'model-id': ['get', 'model']},
            paint: {
                'model-scale': ['get', 'height'],
                'model-rotation': ['get', 'angle'],
                'model-footprint': ['get', 'fp']
            }
        });
        const feature = {properties: {model: 'tree', height: 42, angle: 90, fp: 2}, type: 1} as any;
        expect(layer.layout.get('model-id').evaluate(feature, {})).toBe('tree');
        expect(layer.paint.get('model-scale').evaluate(feature, {})).toBe(42);
        expect(layer.paint.get('model-rotation').evaluate(feature, {})).toBe(90);
        expect(layer.paint.get('model-footprint').evaluate(feature, {})).toBe(2);
    });

    test('honors a data-constant zoom expression on model-opacity', () => {
        const layer = createStyleLayer({
            id: 'm',
            type: 'model',
            source: 'points',
            paint: {'model-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 16, 1]}
        } as LayerSpecification, {}) as ModelStyleLayer;
        layer.updateTransitions({} as TransitionParameters);
        layer.recalculate({zoom: 13, zoomHistory: {}} as EvaluationParameters, undefined);
        expect(layer.paint.get('model-opacity')).toBeCloseTo(0.5, 5);
    });

    test('emits an error on an unknown paint property', async () => {
        const layer = createStyleLayer({id: 'm', type: 'model', source: 'points'} as LayerSpecification, {});
        const errorPromise = layer.once('error');
        layer.setPaintProperty('model-bogus', 5);
        await expect(errorPromise).resolves.toBeDefined();
    });

    test('serialize round-trips the spec properties (no runtime state leaks)', () => {
        const layer = createStyleLayer({
            id: 'buildings',
            type: 'model',
            source: 'points',
            layout: {'model-id': 'tower'},
            paint: {'model-scale': 42, 'model-opacity': 0.5}
        } as LayerSpecification, {});
        const serialized = layer.serialize() as any;
        expect(serialized.type).toBe('model');
        expect(serialized.source).toBe('points');
        expect(serialized.layout['model-id']).toBe('tower');
        expect(serialized.paint['model-scale']).toBe(42);
        expect(serialized.paint['model-opacity']).toBe(0.5);

        // Re-instantiating from the serialized style produces an equivalent layer.
        const roundTripped = createStyleLayer(serialized as LayerSpecification, {}) as ModelStyleLayer;
        expect(roundTripped instanceof ModelStyleLayer).toBe(true);
        roundTripped.updateTransitions({} as TransitionParameters);
        roundTripped.recalculate(evalParams, undefined);
        expect(roundTripped.layout.get('model-id').evaluate({} as any, {})).toBe('tower');
        expect(roundTripped.paint.get('model-scale').evaluate({} as any, {})).toBe(42);
        expect(roundTripped.paint.get('model-opacity')).toBe(0.5);
    });
});
