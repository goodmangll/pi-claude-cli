# pi-claude-cli

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that routes LLM calls through the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) as a subprocess. Use your Claude Pro/Max subscription as the LLM backend — no API key, no separate billing.

## How it works

The extension registers as a custom pi provider exposing all Claude models. Each request spawns a `claude -p` subprocess using the stream-json wire protocol, with `--resume` on follow-up turns to reuse the CLI's session state instead of replaying full history. Claude proposes tool calls, pi executes them natively. Custom pi tools are exposed to Claude via a schema-only MCP server.

## Requirements

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on PATH)
- A Claude Pro or Max subscription
- [pi](https://github.com/mariozechner/pi-coding-agent) or [GSD](https://github.com/gsd-build/gsd-2)

## Installation

Add to `~/.gsd/agent/settings.json`:

```json
{
  "packages": ["npm:pi-claude-cli"]
}
```

Then select a Claude model via `/model` in the interactive UI. All Claude models appear under the `pi-claude-cli` provider.

## Features

- Streams text, thinking, and tool call tokens in real-time
- Maps tool names and arguments bidirectionally between Claude and pi
- Exposes custom pi tools to Claude via MCP (schema-only, no execution)
- Break-early pattern prevents Claude CLI from auto-executing tools
- Session resume via `--resume` eliminates history replay on follow-up turns
- Configurable thinking effort with elevated budgets for Opus models
- Cross-platform subprocess management (Windows, macOS, Linux)
- Inactivity timeout and process registry for cleanup

## Claude CLI API mode

By default, pi-claude-cli treats Claude Code CLI as an authenticated Claude API transport: pi owns the agent context and tool execution, while the CLI provides subscription authentication, stream-json, MCP loading, and session persistence.

Default API mode launches Claude CLI with these context controls:

- `--setting-sources ""` so Claude Code does not also load user/project/local settings or CLAUDE.md
- `--system-prompt-file <tempfile>` so pi's generated system prompt is the sole system prompt
- `--tools Read,Write,Edit,Bash,Grep,Glob` to keep only the built-in tools pi maps and executes
- `--disable-slash-commands` to keep slash-command skills out of the model context
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the Claude subprocess environment

Set `PI_CLAUDE_CLI_API_MODE=0` (`false`, `no`, or `off` also work) to restore Claude Code's legacy context behavior. Individual settings can still be overridden before starting pi:

| Variable                               | Effect                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PI_CLAUDE_CLI_API_MODE`               | Enabled by default. Set to `0`, `false`, `no`, or `off` to disable API mode.                              |
| `PI_CLAUDE_CLI_SETTING_SOURCES`        | Passed to `claude --setting-sources`; overrides the API mode default of an empty string.                  |
| `PI_CLAUDE_CLI_TOOLS`                  | Passed to `claude --tools`; overrides the API mode default of `Read,Write,Edit,Bash,Grep,Glob`.           |
| `PI_CLAUDE_CLI_DISABLE_SLASH_COMMANDS` | When truthy (`1`, `true`, `yes`, `on`), passes `--disable-slash-commands` even when API mode is disabled. |
| `PI_CLAUDE_CLI_DISABLE_AUTO_MEMORY`    | When truthy, sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` even when API mode is disabled.                     |

Example legacy mode:

```sh
PI_CLAUDE_CLI_API_MODE=0 pi
```

## License

MIT
