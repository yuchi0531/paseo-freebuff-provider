# paseo-freebuff-provider

Freebuff provider plugin for [Paseo](https://paseo.sh). It exposes the free
Freebuff model catalog (MiMo 2.6 Flash, GLM 5.3 Flash, DeepSeek V4.1 Flash,
GPT-6 Luna, Solar Mini/Pro 4, and more) as a Paseo agent provider, reusing
your existing freebuff login on the daemon machine.

## How it works

- The plugin registers a `freebuff` provider with 8 free-tier models.
- Prompts run through `@codebuff/sdk` in a dedicated runner subprocess
  (`server/runner.cjs`), kept outside Paseo's eval bundle so the SDK's
  Node-only initialization (tree-sitter wasm, OIDC interop) works unchanged.
- The daemon-side provider streams timeline snapshots (assistant text,
  reasoning, tool calls, subagent notices) over the standard provider
  boundary. Conversation state persists across agent refreshes.
- Authentication: plugin setting override, `CODEBUFF_API_KEY`, or the
  freebuff CLI login (`~/.config/manicode/credentials.json`).

## Development

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-freebuff-provider
paseo plugin reload freebuff
```

See `OVERVIEW.md` for the user-facing description.
