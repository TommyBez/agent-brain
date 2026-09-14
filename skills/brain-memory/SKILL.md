---
name: brain-memory
description: Use Agent Brain MCP to retrieve context before work and preserve durable knowledge after conversations in canonical entity pages.
---

# Agent Brain

Connect the user's Agent Brain MCP server. Its instructions and `brain://procedures` resource are the authoritative procedures; do not maintain a separate copy here.

Before work, request the `before_work` prompt with the user's task. After a conversation, request `after_conversation` with the facts and decisions to retain. For authorized nightly maintenance, use `nightly_consolidation` and the maintenance-scoped tools.

Resolve identities and read current versions before writing entity pages and typed links. Report what was actually persisted, with references and unresolved conflicts. If the connection is unavailable, say so; do not claim that knowledge was saved.
