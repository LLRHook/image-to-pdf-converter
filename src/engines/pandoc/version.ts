import versionText from '../../../node_modules/pandoc-wasm/pandoc-version.txt?raw';

/** The pandoc release bundled in pandoc-wasm (read from the package, never hard-coded). */
export const PANDOC_VERSION = versionText.trim();
