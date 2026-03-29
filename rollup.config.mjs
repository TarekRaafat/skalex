import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import terser from "@rollup/plugin-terser";

const input = "src/index.js";

const external = ["fs", "path", "zlib", "crypto", "os", "http"];

const plugins = [
  resolve({ preferBuiltins: true }),
  commonjs(),
];

const minPlugins = [
  ...plugins,
  terser(),
];

export default [
  // ESM build
  {
    input,
    output: {
      file: "dist/skalex.esm.js",
      format: "es",
      sourcemap: true,
    },
    external,
    plugins,
  },
  // ESM minified
  {
    input,
    output: {
      file: "dist/skalex.esm.min.js",
      format: "es",
      sourcemap: true,
    },
    external,
    plugins: minPlugins,
  },
  // CJS build
  {
    input,
    output: {
      file: "dist/skalex.cjs.js",
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
    output: {
      file: "dist/skalex.cjs.min.js",
      format: "cjs",
      sourcemap: true,
      exports: "default",
    },
    external,
    plugins: minPlugins,
  },
];
