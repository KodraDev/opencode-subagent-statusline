# Contributing

Bug reports, documentation improvements, and focused pull requests are welcome. Discuss larger changes in an issue first.

## Local setup

Requirements: Node.js 24, pnpm 11.9.0, and OpenCode >=2.0.23 and <3.

Fork and clone the repository, then run from its root:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build
```

Open OpenCode from this directory after building. The repository-local wrappers in `.opencode/plugins/kodradev-subagent-statusline-dev/` load `dist/` under separate development IDs. The included `opencode.jsonc` disables the production plugin here, so other projects keep using the globally configured npm package.

For automatic rebuilds, run this in a separate terminal and leave it running:

```sh
pnpm run dev
```

The watcher builds once and rebuilds when `src/` changes. OpenCode reloads changed local modules; reopen the TUI if a change is not picked up.

To use npm globally alongside local development, install with `opencode plugin add kodradev-opencode-subagent-statusline@latest`. Do not also configure the package in `cli.json`: terminal-level entries take precedence and would re-enable the production plugin in this checkout.

## Project structure

- `src/tui.tsx`: sidebar rendering, plugin registration, and options.
- `src/subagents.ts`: session discovery, event tracking, execution time, and token formatting.
- `src/index.ts`: no-op server entrypoint for automatic discovery of the TUI plugin.
- `.opencode/plugins/kodradev-subagent-statusline-dev/`: repository-local development wrappers.
- `script/build-tui.mjs`: Solid/OpenTUI JSX transformation.
- `script/dev.mjs`: local development build watcher.
- `.github/workflows/publish.yml`: npm publishing.

The build compiles TypeScript and transforms JSX into `dist/`. Renderer dependencies remain external so the plugin uses OpenCode's instances. Bun is not required to build.

## Pull requests

- Keep changes focused and follow the existing TypeScript style.
- Use public OpenCode V2 APIs; do not add model tools for UI-only features.
- Update documentation when behavior or options change.
- Run `pnpm run typecheck` and `pnpm run build` for code changes.
- Check UI changes in a real OpenCode terminal: running and completed subagents, nested sessions, expansion, navigation, and switching sessions. There is currently no automated test suite.
- Describe the change, link relevant issues, and list the checks you performed. Include a screenshot for visual changes.
- Do not commit generated `dist/`, `node_modules/`, package archives, or unrelated changes. Leave version bumps to maintainers.

## Reporting bugs

Open an [issue](https://github.com/KodraDev/opencode-subagent-statusline/issues) with:

- OpenCode and plugin versions, operating system, and terminal.
- Steps to reproduce, expected behavior, and actual behavior.
- Relevant plugin options and a screenshot or error message, if available.

Remove credentials and private session content before sharing logs or screenshots.

## Releases (maintainers)

Set a new stable version in `package.json` and push to `main`. The publishing workflow checks npm, installs dependencies, checks types, builds and packs the package, then publishes through npm trusted publishing (OIDC). Existing versions are skipped; prereleases are rejected. No tags or releases are required.

To retry, use **Actions → Publish to npm → Run workflow** on `main`. The npm trusted publisher must reference GitHub owner `KodraDev`, repository `opencode-subagent-statusline`, and workflow `publish.yml`, with no environment name.

## License

Contributions are provided under the project's [MIT license](LICENSE).
