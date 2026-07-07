import {getArrayBuffer} from '../util/ajax';
import {ResourceType} from '../util/request_manager';
import {loadGlbMesh} from '../render/model/glb_loader';

import type {RequestManager} from '../util/request_manager';
import type {BakedModel} from '../render/model/glb_loader';

type ModelStatus = 'loading' | 'loaded' | 'error';

type ModelEntry = {
    status: ModelStatus;
    model: BakedModel | null;
    abortController: AbortController | null;
};

/**
 * Runtime registry mapping a short `model-id` to a decoded, baked glTF/GLB
 * mesh. Modeled on the `addImage` precedent (`ImageManager`): a style references
 * models by id only; the host registers the actual asset at runtime via
 * `map.addModel(id, urlOrData)`. The registry is never serialized into the
 * style — round-tripping a `model` layer carries no model bytes or paths.
 *
 * URL loading is async (an improvement over native's synchronous disk parse):
 * the mesh resolves through gl-js's existing request stack. `getModel` returns
 * null for any id that isn't a loaded, valid mesh (still loading, failed, or
 * never registered) — callers needing to tell those apart use `getStatus`.
 * The render layer draws nothing for a feature whose model is still loading
 * (native has no such window, so drawing the placeholder there would be a
 * web-only flash) and falls back to the placeholder cube only once the id is
 * known to be unresolvable (`'error'` or unregistered). `version` bumps on
 * every state change so the render layer knows to re-bake once a mesh
 * finishes loading (or fails).
 */
export class ModelManager {
    _models: {[id: string]: ModelEntry};
    _requestManager: RequestManager;
    _onChange: () => void;
    /** Incremented whenever a model is added, finishes loading, fails, or is removed. */
    version: number;

    constructor(requestManager: RequestManager, onChange: () => void) {
        this._models = {};
        this._requestManager = requestManager;
        this._onChange = onChange;
        this.version = 0;
    }

    hasModel(id: string): boolean {
        return !!this._models[id];
    }

    /** The loaded, valid mesh for `id`, or null while loading / on failure / if unregistered. */
    getModel(id: string): BakedModel | null {
        const entry = this._models[id];
        return entry && entry.status === 'loaded' ? entry.model : null;
    }

    /**
     * Resolution state for `id`: `'loading'`/`'loaded'`/`'error'` mirror the
     * registry entry; `'missing'` means the id was never registered (or was
     * removed). The render layer uses this to distinguish "still loading"
     * (draw nothing this frame) from "unresolvable" (`'error'` or `'missing'`,
     * draw the placeholder cube) — `getModel` alone can't tell those apart
     * since it returns null for all three.
     */
    getStatus(id: string): ModelStatus | 'missing' {
        const entry = this._models[id];
        return entry ? entry.status : 'missing';
    }

    listModels(): Array<string> {
        return Object.keys(this._models);
    }

    /**
     * Register a model under `id`, from either an already-decoded GLB
     * `ArrayBuffer` or a URL the map fetches through its request machinery.
     * Resolves once the mesh is baked (or has failed to parse).
     */
    async addModel(id: string, urlOrData: string | ArrayBuffer): Promise<void> {
        if (this._models[id]) {
            this.removeModel(id);
        }

        const entry: ModelEntry = {status: 'loading', model: null, abortController: null};
        this._models[id] = entry;
        this._bump();

        try {
            let buffer: ArrayBuffer;
            if (typeof urlOrData === 'string') {
                const abortController = new AbortController();
                entry.abortController = abortController;
                const request = this._requestManager.transformRequest(urlOrData, ResourceType.Model);
                const response = await getArrayBuffer(request, abortController);
                buffer = response.data;
            } else {
                buffer = urlOrData;
            }

            // The id may have been removed/replaced while the fetch was in flight.
            if (this._models[id] !== entry) return;

            const model = await loadGlbMesh(buffer);
            if (this._models[id] !== entry) return;

            entry.status = model.valid ? 'loaded' : 'error';
            entry.model = model.valid ? model : null;
            entry.abortController = null;
            this._bump();
        } catch (err) {
            if (this._models[id] === entry) {
                entry.status = 'error';
                entry.model = null;
                entry.abortController = null;
                this._bump();
            }
            throw err;
        }
    }

    removeModel(id: string) {
        const entry = this._models[id];
        if (!entry) return;
        if (entry.abortController) entry.abortController.abort();
        delete this._models[id];
        this._bump();
    }

    _bump() {
        this.version++;
        this._onChange();
    }
}
