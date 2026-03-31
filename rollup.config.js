import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import terser from "@rollup/plugin-terser";

const input = "src/index.js";

const external = ["node:fs", "node:path", "node:zlib", "node:crypto", "node:os", "node:http"];

/**
 * Replaces node:* built-in imports with empty stubs for browser builds.
 * Code that actually uses these (FsAdapter, MCP HTTP transport) is never
 * reached in browser environments, so the stubs are safe.
 */
function nodeBrowserStubs() {
  return {
    name: "node-browser-stubs",
    resolveId(id) {
      if (id.startsWith("node:")) return `\0node-stub:${id}`;
    },
    load(id) {
      if (id.startsWith("\0node-stub:")) return "export default {};\n";
    },
  };
}

const plugins = [
  resolve({ preferBuiltins: true }),
  commonjs(),
];

const minPlugins = [
  ...plugins,
  terser(),
];

const treeshake = { moduleSideEffects: false };

export default [
  // ESM build (Node.js / Deno / Bun)
  {
    input,
    treeshake,
    output: {
      file: "dist/skalex.esm.js",
      format: "es",
      sourcemap: true,
    },
    external,
    plugins,
  },
  // ESM browser build — node:* built-ins stubbed out
  {
    input,
    treeshake,
    output: {
      file: "dist/skalex.browser.js",
      format: "es",
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [nodeBrowserStubs(), ...plugins],
  },
  // ESM minified
  {
    input,
    treeshake,
    output: {
      file: "dist/skalex.esm.min.js",
      format: "es",
      sourcemap: true,
    },
    external,
    plugins: minPlugins,
  },
  // UMD/IIFE minified
  {
    input,
    treeshake,
    output: {
      file: "dist/skalex.umd.min.js",
      format: "iife",
      name: "Skalex",
      sourcemap: true,
      inlineDynamicImports: true,
    },
    plugins: [nodeBrowserStubs(), ...minPlugins],
  },
  // CJS build
  {
    input,
    treeshake,
    output: {
      file: "dist/skalex.cjs",
      format: "cjs",
      sourcemap: true,
      exports: "default",
    },
    external,
    plugins,
  },
  // CJS minified
  {
    input,
    treeshake,
    output: {
      file: "dist/skalex.min.cjs",
      format: "cjs",
      sourcemap: true,
      exports: "default",
    },
    external,
    plugins: minPlugins,
  },
];
