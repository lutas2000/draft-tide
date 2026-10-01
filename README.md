# Draft Tide

**Version history for your designs.**

*Let ideas flow. Keep every draft.*

Draft Tide is a planned, local-first design version control tool. It is intended to help designers save iterations, compare versions, restore earlier work safely, and explore ideas without needing to learn Git. A desktop GUI is the primary interface; a CLI, an MCP server, and an installable Skill are planned as optional ways for automation and AI agents to use the same capabilities.

## Why Draft Tide?

Design work changes quickly. Draft Tide aims to keep each saved version available while making it easy to see what changed and return to an earlier direction. It is designed for web interfaces and interactive prototypes created in existing editors or with external agents.

Draft Tide is intended to work without an agent, model API key, cloud account, or network connection for its core local workflows. Agent integrations are optional.

## Status

Early development toward the first local alpha (v0.1). The contracts, the local Engine with its CLI and MCP entry points, and a desktop app skeleton exist. Saving and restoring designs are not built yet.

## Development

Requires Node 24 (pnpm comes through Corepack).

```bash
corepack pnpm install
corepack pnpm run check     # format, lint, typecheck, build, tests
corepack pnpm run desktop   # build and launch the desktop app
```

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.
