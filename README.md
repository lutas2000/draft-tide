# Draft Tide

**Version history for your designs.**

*Let ideas flow. Keep every draft.*

Draft Tide is a planned, local-first design version control tool. It is intended to help designers save iterations, compare versions, restore earlier work safely, and explore ideas without needing to learn Git. A desktop GUI is the primary interface; a CLI, an MCP server, and an installable Skill are planned as optional ways for automation and AI agents to use the same capabilities.

## Why Draft Tide?

Design work changes quickly. Draft Tide aims to keep each saved version available while making it easy to see what changed and return to an earlier direction. It is designed for web interfaces and interactive prototypes created in existing editors or with external agents.

Draft Tide is intended to work without an agent, model API key, cloud account, or network connection for its core local workflows. Agent integrations are optional.

## Status

Early development toward the first local alpha (v0.1). In the desktop app you can connect a design folder, review what will be saved, save versions, see unsaved changes, browse the history (including commits made by other tools) and compare two versions file by file and line by line. The CLI and MCP server can do the same once agent access is turned on in the app, except connecting a folder: they can only ask the user to. Versions are commits in the project's own Git repository. Any version can be restored, from the app or by an agent: unsaved changes are kept as a protection version first, and history only grows. An operation cut short (a crash, a file changed meanwhile) is completed or rolled back from a recovery screen. Each version's entry page is rendered offline in an isolated preview process: the history shows thumbnails, and a comparison puts two versions' pictures (or a changed PNG or JPEG) side by side. GitHub sync is not available yet.

## Development

Requires Node 24 (pnpm comes through Corepack).

```bash
corepack pnpm install
corepack pnpm run check     # format, lint, typecheck, build, tests
corepack pnpm run desktop   # build and launch the desktop app
```

## License

This project is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full text.
