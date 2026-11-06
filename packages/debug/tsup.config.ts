import { defineConfig } from 'tsup';

export default defineConfig( {
    entry: {
        index: 'src/index.ts',
        // What adapter packages import: the adapter contract and `defineAdapter`.
        adapter: 'src/adapter/index.ts',
        // What adapter packages import in their tests: `fakeAdapter` and the conformance suite.
        testkit: 'src/adapter/testkit.ts'
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    // Stylesheets are real .css files that end up inlined as strings.
    loader: { '.css': 'text' }
} );
