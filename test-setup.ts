import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Task 9: registers a happy-dom `window`/`document` onto globalThis before any
 * frontend test file's top-level imports run (bunfig.toml's [test].preload).
 * @testing-library/react's render()/renderHook() need a real DOM (they call
 * ReactDOM.createRoot against `document`), and bun:test has no DOM built in —
 * this is the minimal shim that makes that work without pulling in a whole
 * separate test runner (vitest) for one hook test file.
 */
GlobalRegistrator.register();
