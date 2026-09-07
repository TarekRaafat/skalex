import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import terser from "@rollup/plugin-terser";

const input = "src/index.js";

const external = ["node:fs", "node:path", "node:zlib", "node:crypto", "node:http"];
const isLazyMcpModule = id => id.endsWith("/mcp/transports/http.js") || id.endsWith("/mcp/tools.js");
const isExternal = id => external.includes(id) || isLazyMcpModule(id);
// Optional HTTP transport and tool handling load from source modules shipped in the package.
const paths = id => isLazyMcpModule(id) ? "../src/connectors/mcp/" + id.split("/mcp/")[1] : id;

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
      paths,
      file: "dist/skalex.esm.js",
      format: "es",
      sourcemap: true,
    },
    external: isExternal,
    plugins,
  },
  // ESM browser build  -  node:* built-ins stubbed out
  {
    input,
    treeshake,
    output: {
      paths,
      file: "dist/skalex.browser.js",
      format: "es",
      sourcemap: true,
      inlineDynamicImports: true,
    },
    external: isLazyMcpModule,
    plugins: [nodeBrowserStubs(), ...plugins],
  },
  // ESM minified
  {
    input,
    treeshake,
    output: {
      paths,
      file: "dist/skalex.esm.min.js",
      format: "es",
      sourcemap: true,
    },
    external: isExternal,
    plugins: minPlugins,
  },
  // UMD/IIFE minified
  {
    input,
    treeshake,
    output: {
      paths,
      file: "dist/skalex.umd.min.js",
      format: "iife",
      name: "Skalex",
      sourcemap: true,
      inlineDynamicImports: true,
      exports: "named",
      // Unwrap so window.Skalex is the constructor, not { default, ... }
      footer: "Skalex=Skalex.default;",
    },
    external: isLazyMcpModule,
    plugins: [nodeBrowserStubs(), ...minPlugins],
  },
  // CJS build
  {
    input,
    treeshake,
    output: {
      paths,
      file: "dist/skalex.cjs",
      format: "cjs",
      sourcemap: true,
      exports: "named",
      // Unwrap so require("skalex") returns the constructor directly,
      // while require("skalex").SkalexError etc. still work.
      footer: "module.exports=Object.assign(exports.default,exports);delete module.exports.default;",
    },
    external: isExternal,
    plugins,
  },
  // CJS minified
  {
    input,
    treeshake,
    output: {
      paths,
      file: "dist/skalex.min.cjs",
      format: "cjs",
      sourcemap: true,
      exports: "named",
      footer: "module.exports=Object.assign(exports.default,exports);delete module.exports.default;",
    },
    external: isExternal,
    plugins: minPlugins,
  },
];
