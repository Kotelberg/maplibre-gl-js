// Fork-internal (HataHub): tests for the model selection-bloom API surface
// (Style.setModelSelection / getModelSelection, delegated from Map). NOT
// upstreamed — lives on the integration branch only. The bloom render passes
// themselves are verified live in the browser (debug/model.html); here we pin
// the selection-state contract that drives them.
import {describe, test, expect, vi} from 'vitest';
import {Style} from './style';
import {StubMap} from '../util/test/util';

function createStyle(map = new StubMap() as any) {
    const style = new Style(map);
    map.style = style;
    return style;
}

describe('model selection (fork-internal bloom)', () => {
    test('defaults to no selection', () => {
        const style = createStyle();
        expect(style.getModelSelection()).toBeNull();
    });

    test('set/get a numeric feature id and repaints on change', () => {
        const map = new StubMap() as any;
        const repaint = vi.spyOn(map, 'triggerRepaint');
        const style = createStyle(map);

        style.setModelSelection(42);
        expect(style.getModelSelection()).toBe(42);
        expect(repaint).toHaveBeenCalledTimes(1);
    });

    test('set/get a string feature id', () => {
        const style = createStyle();
        style.setModelSelection('house-7');
        expect(style.getModelSelection()).toBe('house-7');
    });

    test('accepts 0 and empty-string as valid ids (not treated as deselect)', () => {
        const style = createStyle();
        style.setModelSelection(0);
        expect(style.getModelSelection()).toBe(0);
        style.setModelSelection('');
        expect(style.getModelSelection()).toBe('');
    });

    test('null and undefined both deselect', () => {
        const style = createStyle();
        style.setModelSelection(5);
        style.setModelSelection(null);
        expect(style.getModelSelection()).toBeNull();

        style.setModelSelection(5);
        style.setModelSelection(undefined as any);
        expect(style.getModelSelection()).toBeNull();
    });

    test('setting the same id again does not repaint (no redundant work)', () => {
        const map = new StubMap() as any;
        const repaint = vi.spyOn(map, 'triggerRepaint');
        const style = createStyle(map);

        style.setModelSelection(7);
        style.setModelSelection(7);
        expect(repaint).toHaveBeenCalledTimes(1);

        // Clearing an already-clear selection is likewise a no-op.
        style.setModelSelection(null);
        style.setModelSelection(null);
        expect(repaint).toHaveBeenCalledTimes(2);
    });
});
