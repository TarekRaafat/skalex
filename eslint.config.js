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
    },
  },

  // Test files - vitest globals + relaxed unused-var rules.
  {
    files: ["tests/**/*.js"],
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
