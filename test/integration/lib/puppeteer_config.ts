import puppeteer, {type Browser} from 'puppeteer';

export async function launchPuppeteer(headless: boolean | 'shell' = true): Promise<Browser> {
    return puppeteer.launch({
        // Chrome's "new" headless mode (puppeteer's `headless: true`) never fires
        // requestAnimationFrame on this environment's Chrome for Testing build
        // (reproduced with a bare `requestAnimationFrame` loop on `about:blank`,
        // no maplibre involved) -- every map hangs at `TIMEOUT_LOAD` because the
        // render loop that drives `load`/`idle` never ticks. Legacy headless
        // (`headless: 'shell'`) does not have this regression. Falling back to
        // it when the caller didn't explicitly request `false` (headed) keeps
        // CI/local render+query+browser tests working across Chrome versions.
        headless: headless === true ? 'shell' : headless,
        args: [
            '--disable-gpu',
            '--enable-features=AllowSwiftShaderFallback,AllowSoftwareGLFallbackDueToCrashes',
            '--enable-unsafe-swiftshader'
        ],
    });
}