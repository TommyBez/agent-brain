# Agent Brain plugin

Retrieve context about people, clients and projects, and preserve durable knowledge in the owner's private a native brain. This package bundles the portable `brain-memory` skill and a remote MCP connection. It contains no application runtime or database credentials.

## Package

```text
agent-brain/
├── plugin.json
├── mcp.json
├── skills/brain-memory/
│   ├── SKILL.md
│   └── references/writing-pages.md
├── .mcp.json
├── .claude-plugin/plugin.json
├── .codex-plugin/plugin.json
└── .cursor-plugin/plugin.json
```

`plugin.json` and `mcp.json` follow [Agent Plugins 1.0.0](https://agent-plugins.org/plugin-authors/build-an-agent-plugin). The memory skill follows [Agent Skills](https://agentskills.io/specification) and has one canonical copy. The live server's instructions and tool schemas remain authoritative for its behavior.

Codex and Cursor support the portable format. Compatibility manifests also support their native plugin formats. Claude Code uses `.claude-plugin/plugin.json` and discovers `.mcp.json`. The compatibility MCP configuration uses `type: "http"`, while the standard requires `type: "streamable-http"`. Keep server names and URLs in both files aligned; keep names, versions and descriptions aligned across manifests when releasing.

## Install

Run from the repository root to install the current local checkout:

```sh
codex plugin marketplace add .
codex plugin add agent-brain@agent-brain-plugins
```

For Claude Code:

```sh
claude plugin marketplace add .
claude plugin install agent-brain@agent-brain-plugins
```

After committing and pushing the package and catalogs, replace `.` with `TommyBez/agent-brain` to install from GitHub. Private repositories require Git access. Restart the client or reload its plugins after installing.

In Cursor, import the repository through Dashboard → Plugins & MCPs → Team Marketplaces → Import from Repo, then install Agent Brain from Customize. Team marketplaces require a Teams or Enterprise plan. For local development, copy this entire directory to `~/.cursor/plugins/local/agent-brain`. Other clients supporting Agent Plugins use their own installation flow with this directory as the plugin root; the standard defines the package, not a universal install command.

Installing the package adds the server configuration. Sign in through the client's MCP OAuth flow and approve the needed permissions before using the tools. Installation does not grant access by itself. Avoid enabling a second Brain connection or standalone copy of the skill if the same components are already installed separately.

## Endpoint and authentication

The bundled endpoint is `https://agent-brain.vercel.app/mcp`. Authentication uses client-managed OAuth 2.1 with PKCE. There are no embedded tokens or client secrets. A client must support both Streamable HTTP and the server's OAuth flow to use this connection interactively; support for the package format alone does not establish authentication compatibility.

For a self-hosted Brain, copy the package and replace the URL in both `mcp.json` and `.mcp.json` with the canonical URL shown in that instance's **Agents & access** screen. Agent Plugins 1.0.0 does not expand environment placeholders in remote URLs. Browser-hosted clients may also require their origin in the server's `MCP_ALLOWED_ORIGINS` setting.

Use natural-language requests such as “Recover the context and decisions for this project” or “Save the decisions from this conversation, preserving sources and rationale.” Claude Code also supports `/agent-brain:brain-memory`; Codex supports explicit skill invocation with `$brain-memory`. The skill assesses useful memories proactively and saves only when authorized.

## Validate and distribute

Validate the portable JSON documents against their declared [official schemas](https://agent-plugins.org/schemas). From the repository root, validate the Claude adapter, catalog and skill:

```sh
claude plugin validate --strict ./plugins/agent-brain
claude plugin validate --strict ./.claude-plugin/marketplace.json
claude plugin validate --strict ./plugins/agent-brain/skills
```

Distribute only this directory as the plugin package. The repository-level catalogs point here, leaving application source, development skills and local settings outside the installable package. To make a ZIP from the repository root:

```sh
python3 -m zipfile -c /tmp/agent-brain-plugin.zip plugins/agent-brain
```

Schema and manifest validation establish package structure. Verify tool discovery and an authenticated `context` call in each target client before claiming that client's complete installation works. Public directory listing and review are separate from local or private marketplace distribution.

References: [Codex packaging](https://developers.openai.com/plugins/build/plugins), [Claude manifests](https://code.claude.com/docs/en/plugins-reference), [Cursor plugin formats](https://cursor.com/docs/reference/plugins).
