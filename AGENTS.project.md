# Project instruction layer

Inherit the shared global rules. This file contains project additions.

# T3 Code

T3 Code is a multi-surface client for coding agents. Keep changes small, performance-aware, remote-ready, and consistent across web, desktop, and mobile where the feature applies.

## Non-negotiable local protections

- Never kill a process by matching its name, path, or worktree. Stop only a PID you captured or the verified owner of a port.
- Never start a development server against, open read-write, or clean `~/.t3/userdata`. Use this worktree's isolated `.t3` state and one-way copies of test data.
- Never set `VITE_HTTP_URL` or `VITE_WS_URL` for development; Vite proxies the required endpoints.
- Preserve the user's existing data and dirty work. Do not commit, push, or open a PR unless explicitly authorized.

## Detailed contributor workflow

Load the [t3-contributor skill](.agents/skills/t3-contributor/SKILL.md) before changing source, configuration, tests, or documentation. It contains the complete maintainer guidance, including development-server handling, isolated test data, focused validation, provider and surface coverage, documentation rules, and project architecture. User-visible web/desktop and mobile changes also require the matching verification skill described there.

Architecture overview: [docs/internals/overview.md](docs/internals/overview.md). Shared vocabulary: [docs/internals/glossary.md](docs/internals/glossary.md).