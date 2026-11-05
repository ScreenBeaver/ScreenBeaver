# Contributing to Screen Beaver

Thanks for helping. This guide is enough to run locally, open a PR, and find a first issue.

## Response time

We aim to **reply to every new issue and PR within one business day** (often sooner). A first reply may be a quick triage (“repro needed”, “good first issue”, or “scheduled”) — not always a full fix the same day.

## Development setup (Windows)

Prerequisites:

- Node.js 20+
- Rust via [rustup](https://rustup.rs/)
- WebView2 (Windows)
- Chrome or Edge (recommended for export)

```bash
git clone https://github.com/ScreenBeaver/ScreenBeaver.git
cd ScreenBeaver
npm install
npm run desktop:dev
```

Web UI only (no native cursor / Android USB):

```bash
npm run dev
```

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run desktop:dev` | Tauri desktop app |
| `npm run build` | Frontend production build (also what CI runs) |
| `npm run lint` | ESLint |
| `npm run mcp:build` | Bundle the MCP server |

## Pull requests

1. Fork and branch from `main`.
2. Keep the PR focused — one concern per PR.
3. Do **not** commit `.env`, secrets, `node_modules`, `src-tauri/target`, or MSIX payloads.
4. Prefer clear commit messages that explain **why**.
5. Link related issues.

## Tests / checks

Before opening a PR:

```bash
npm run build
npm run lint
```

CI on `main` and pull requests runs `npm ci` + `npm run build` on Windows.

## Good first issues

Look for the [`good first issue`](https://github.com/ScreenBeaver/ScreenBeaver/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Prefer those when you are new to the codebase.

## Questions vs bugs

- **Questions / ideas** → [GitHub Discussions](https://github.com/ScreenBeaver/ScreenBeaver/discussions)
- **Bugs / concrete defects** → [Issues](https://github.com/ScreenBeaver/ScreenBeaver/issues) (use the bug template)

## License

By contributing, you agree your contributions are licensed under the MIT License (see [LICENSE](./LICENSE)).
