/**
 * ESLint flat config for Skalex.
 *
 * Deliberately minimal: catches genuine bugs (`no-undef`, unreachable code,
 * duplicate declarations, etc.) without enforcing formatting. Prettier is
 * not part of this config - formatting is handled by convention. The goal
 * is that `npm run lint` catches things like typos and bad imports without
 * generating a code-churn diff across the rest of the tree.
 *
 * Unused identifiers starting with `_` are allowed because the engine uses
 * `_` prefixes for private state and underscore-prefixed catch bindings.
 */
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "dist/**",
      "docs/lib/**",
      "examples/**",
      "tests/smoke/browser.test.js",
      "tests/types/**",
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
      },
    },
    rules: {
      // Allow underscore-prefixed identifiers to go unused (private state,
      // intentionally-ignored destructuring, catch bindings).
      "no-unused-vars": ["error", {
        args: "none",
        caughtErrors: "none",
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
      }],
      // Genuine bug guards - enable them.
      "no-undef": "error",
      "no-undef-init": "error",
      "no-debugger": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      // Recommended has `no-empty: error` which flags `catch {}` blocks
      // used as intentional "ignore" guards throughout the codebase. Allow
      // empty blocks when a comment explains the intent, and allow empty
      // catch blocks unconditionally.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Prefer const for never-reassigned lets.
      "prefer-const": "warn",
      // All logging goes through the configurable `logger` option. Direct
      // console calls bypass the user's logger and are almost always bugs.
      "no-console": "error",
      // async only on methods that await (CLAUDE.md rule). Warn for now;
      // many facade methods return a promise without awaiting (intentional
      // for API consistency). A full sweep is deferred to a later release.
      "require-await": "warn",
    },
  },

  // src/engine/utils.js IS the default logger - allow console there.
  {
    files: ["src/engine/utils.js"],
    rules: { "no-console": "off" },
  },

  // Test harness mocks that mirror real async signatures. The `forTesting`
  // factory in collection-context produces stubs that callers `await`
  // uniformly; forcing sync would break the contract.
  {
    files: ["src/engine/collection-context.js"],
    rules: { "require-await": "off" },
  },

  // Adapter interface contracts: abstract base classes and concrete adapters
  // declare async methods that callers await uniformly. Some concrete
  // implementations are synchronous under the hood but must keep `async` to
  // satisfy the interface contract (StorageAdapter, LLMAdapter,
  // EmbeddingAdapter, MCP transport).
  {
    files: [
      "src/connectors/storage/**/*.js",
      "src/connectors/llm/**/*.js",
      "src/connectors/embedding/**/*.js",
      "src/connectors/mcp/transports/**/*.js",
    ],
    rules: { "require-await": "off" },
  },

  // Test files - vitest globals + relaxed unused-var rules + allow console.
  {
    files: ["tests/**/*.{js,cjs,mjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
      },
    },
    rules: {
      "no-unused-vars": ["error", {
        args: "none",
        caughtErrors: "none",
        varsIgnorePattern: "^_|^[A-Z]",
        argsIgnorePattern: "^_",
      }],
      "no-console": "off",
      "require-await": "off",
    },
  },

  // Smoke tests for non-Node runtimes - declare their runtime globals.
  {
    files: ["tests/smoke/bun*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        Bun: "readonly",
      },
    },
  },
  {
    files: ["tests/smoke/deno*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        Deno: "readonly",
      },
    },
  },
];
