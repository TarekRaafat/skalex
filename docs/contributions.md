# Contributions

---

Contributions and suggestions are always more than welcome!

> If you have any ideas, just [open a "discussion"](https://github.com/TarekRaafat/skalex/discussions/new) and share them.

If you'd like to contribute here are the steps:

1.  Fork it (<https://github.com/TarekRaafat/skalex.git>)
2.  Create your feature branch (`git checkout -b feature/name`)
3.  Commit your changes (`git commit -am 'Add some feature'`)
4.  Make sure your branch is not behind
5.  Push to the branch (`git push origin feature/name`)
6.  Create a new Pull Request

> Pull requests are warmly welcome.

## Non-negotiables

Three hard rules protect what Skalex is. A PR that breaks any of them will not be merged:

- **Zero runtime dependencies.** `npm install skalex` installs Skalex and nothing else. Everything ships with `node:*` builtins and `fetch`. Enforced by `npm run deps:zero`: the install-causing `package.json` fields stay empty. Bridge an external system (a database, an embedding provider, an LLM) with an optional adapter the user installs in their own project and Skalex dynamically imports - never a runtime dependency.
- **Runtime agnostic.** One package, one API on Node.js, Bun, Deno, browsers, and edge runtimes. Enforced by the cross-runtime smoke matrix (`npm run smoke:node|bun|deno|browser`, all run in CI) plus the browser-stub guard. A feature that only works on one runtime, or that breaks another, does not ship. Don't reach for a runtime-specific global without an isomorphic fallback.
- **Minimal footprint.** Skalex stays lightweight. The published bundle has a hard byte budget in [`size-budget.json`](../size-budget.json), enforced by `npm run size` (part of `npm run verify`, and gated in CI). If your change pushes the bundle over budget, the build fails - trim the change, or move weight most users will not need behind a subpath export (`skalex/connectors/*`) rather than the core bundle. Raising the budget is a last resort: it needs a clear rationale in the PR, never a silent bump to make the gate pass.

Run `npm run verify` locally before opening a PR - it runs the same gate CI does, size check included.
