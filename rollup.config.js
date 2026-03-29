import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";

const input = "src/index.js";

const external = ["fs", "path", "zlib", "crypto", "os"];

const plugins = [
  resolve({ preferBuiltins: true }),
  commonjs(),
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
];
