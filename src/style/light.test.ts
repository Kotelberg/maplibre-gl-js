import {describe, test, expect, vi} from 'vitest';
import {Light} from './light';
import {Color, latest as styleSpec, type LightSpecification, type StyleSpecification} from '@maplibre/maplibre-gl-style-spec';
import {sphericalToCartesian} from '../util/util';
import {type EvaluationParameters} from './evaluation_parameters';
import {type TransitionParameters} from './properties';
import {validateStyle} from './validate_style';

const spec = styleSpec.light;

test('a style with light.cast-shadows and light.shadow-intensity validates (no "unknown property" error)', () => {
    const style: StyleSpecification = {
        version: 8,
        sources: {},
        layers: [],
        light: {
            'cast-shadows': true,
            'shadow-intensity': 0.5
        }
    } as StyleSpecification;

    const errors = validateStyle(style);
    expect(errors).toHaveLength(0);
});

test('Light with defaults', () => {
    const light = new Light({});
    light.recalculate({zoom: 0, zoomHistory: {}} as EvaluationParameters);

    expect(light.properties.get('anchor')).toEqual(spec.anchor.default);
    expect(light.properties.get('position')).toEqual(sphericalToCartesian(spec.position.default as any as [number, number, number]));
    expect(light.properties.get('intensity')).toEqual(spec.intensity.default);
    expect(light.properties.get('color')).toEqual(Color.parse(spec.color.default));
    expect(light.properties.get('cast-shadows')).toEqual(spec['cast-shadows'].default);
    expect(light.properties.get('shadow-intensity')).toEqual(spec['shadow-intensity'].default);
});

test('Light with options', () => {
    const light = new Light({
        anchor: 'map',
        position: [2, 30, 30],
        intensity: 1,
        'cast-shadows': true,
        'shadow-intensity': 0.6
    } as LightSpecification);
    light.recalculate({zoom: 0, zoomHistory: {}} as EvaluationParameters);

    expect(light.properties.get('anchor')).toBe('map');
    expect(light.properties.get('position')).toEqual(sphericalToCartesian([2, 30, 30]));
    expect(light.properties.get('intensity')).toBe(1);
    expect(light.properties.get('color')).toEqual(Color.parse(spec.color.default));
    expect(light.properties.get('cast-shadows')).toBe(true);
    expect(light.properties.get('shadow-intensity')).toBe(0.6);
});

test('Light with stops function', () => {
    const light = new Light({
        intensity: {
            stops: [[16, 0.2], [17, 0.8]]
        }
    } as LightSpecification);
    light.recalculate({zoom: 16.5, zoomHistory: {}} as EvaluationParameters);

    expect(light.properties.get('intensity')).toBe(0.5);
});

test('Light.getLight', () => {
    const defaults = {};
    for (const key in spec) {
        defaults[key] = spec[key].default;
    }

    expect(new Light(defaults).getLight()).toEqual(defaults);
});

test('Light.getLight round-trips cast-shadows and shadow-intensity', () => {
    const light = new Light({
        'cast-shadows': true,
        'shadow-intensity': 0.75
    } as LightSpecification);

    const serialized = light.getLight();
    expect(serialized['cast-shadows']).toBe(true);
    expect(serialized['shadow-intensity']).toBe(0.75);
});

describe('Light.setLight', () => {
    test('sets light', () => {
        const light = new Light({});
        light.setLight({color: 'red', 'color-transition': {duration: 3000}} as LightSpecification);
        light.updateTransitions({transition: true} as any as TransitionParameters);
        light.recalculate({zoom: 16, zoomHistory: {}, now: 1500} as EvaluationParameters);
        expect(light.properties.get('color')).toEqual(new Color(1, 0.5, 0.5, 1));
    });

    test('sets cast-shadows and shadow-intensity (validates and instantiates with no "unknown property" error)', () => {
        const light = new Light({});
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        light.setLight({'cast-shadows': true, 'shadow-intensity': 0.8} as LightSpecification);
        light.updateTransitions({transition: false} as any as TransitionParameters);
        light.recalculate({zoom: 16, zoomHistory: {}, now: 0} as EvaluationParameters);
        expect(light.properties.get('cast-shadows')).toBe(true);
        expect(light.properties.get('shadow-intensity')).toBe(0.8);
        expect(console.error).not.toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    test('transitions shadow-intensity (transition: true on this property)', () => {
        const light = new Light({'shadow-intensity': 0} as LightSpecification);
        light.updateTransitions({transition: false} as any as TransitionParameters);
        light.recalculate({zoom: 16, zoomHistory: {}, now: 0} as EvaluationParameters);
        expect(light.properties.get('shadow-intensity')).toBe(0);

        light.setLight({'shadow-intensity': 1, 'shadow-intensity-transition': {duration: 1000}} as LightSpecification);
        light.updateTransitions({transition: true} as any as TransitionParameters);
        light.recalculate({zoom: 16, zoomHistory: {}, now: 500} as EvaluationParameters);
        expect(light.properties.get('shadow-intensity')).toBeCloseTo(0.5, 5);

        light.recalculate({zoom: 16, zoomHistory: {}, now: 1000} as EvaluationParameters);
        expect(light.properties.get('shadow-intensity')).toBe(1);
    });

    test('rejects cast-shadows-transition (transition: false on this property, matches style-spec validation)', () => {
        const light = new Light({});
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        light.setLight({'cast-shadows': true, 'cast-shadows-transition': {duration: 300}} as LightSpecification);
        light.updateTransitions({transition: false} as any as TransitionParameters);
        light.recalculate({zoom: 16, zoomHistory: {}, now: 0} as EvaluationParameters);
        // validation fails (unknown property "cast-shadows-transition"), so the whole setLight call
        // is rejected and cast-shadows keeps its prior (default) value.
        expect(light.properties.get('cast-shadows')).toBe(false);
        expect(console.error).toHaveBeenCalled();
        consoleErrorSpy.mockRestore();
    });

    test('validates by default', () => {
        const light = new Light({});
        const lightSpy = vi.spyOn(light, '_validate');
        vi.spyOn(console, 'error').mockImplementation(() => { });
        light.setLight({color: 'notacolor'});
        light.updateTransitions({transition: false} as any as TransitionParameters);
        light.recalculate({zoom: 16, zoomHistory: {}, now: 10} as EvaluationParameters);
        expect(lightSpy).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(lightSpy.mock.calls[0][2]).toEqual({});
    });

    test('respects validation option', () => {
        const light = new Light({});

        const lightSpy = vi.spyOn(light, '_validate');
        light.setLight({color: [999]} as any, {validate: false});
        light.updateTransitions({transition: false} as any as TransitionParameters);
        light.recalculate({zoom: 16, zoomHistory: {}, now: 10} as EvaluationParameters);

        expect(lightSpy).toHaveBeenCalledTimes(1);
        expect(lightSpy.mock.calls[0][2]).toEqual({validate: false});
        expect(light.properties.get('color')).toEqual([999]);
    });
});
