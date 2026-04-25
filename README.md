# openagenticskyzer

**Powerful open-source alternative to Claude Code.** An AI coding assistant that works in any folder, powered by your own API keys.

```bash
# Install with your provider (recommended — much faster)
pip install openagenticskyzer[groq]        # Groq
pip install openagenticskyzer[together]    # Together AI
pip install openagenticskyzer[mistral]     # Mistral / Codestral
pip install openagenticskyzer[gemini]      # Google Gemini
pip install openagenticskyzer[openrouter]  # OpenRouter
pip install openagenticskyzer[all]         # every provider at once

# Or plain install (no provider bundled)
pip install openagenticskyzer
```

---

## What it does

`openagent` is a terminal-based AI agent that reads, writes, and edits your code, runs shell commands, searches the web, and navigates your entire codebase — all from a single command.

```bash
cd my-project
openagent "add a dark mode toggle to the navbar"
```

---

## Features

- **Multi-provider** — bring your own API key (Together, Groq, Mistral, Gemini, OpenRouter)
- **Full file access** — create, read, edit, delete files and directories
- **Shell execution** — run any command directly in your project folder
- **Codebase search** — glob patterns, regex grep across all files
- **Internet search** — built-in Tavily-powered web research
- **Smart image sourcing** — keyword-relevant photos via Unsplash or Pexels API; graceful fallback to placeholders
- **Three agent modes** — `ask`, `auto`, `plan`
- **Session memory** — context is persisted and trimmed intelligently across turns
- **Rich TUI** — beautiful terminal interface with live streaming output

---

## Quick start

### 1. Install

**Recommended — install only what you need (much faster):**

```bash
pip install openagenticskyzer[groq]       # Groq (fast, free tier)
pip install openagenticskyzer[together]   # Together AI
pip install openagenticskyzer[mistral]    # Mistral / Codestral
pip install openagenticskyzer[gemini]     # Google Gemini
pip install openagenticskyzer[openrouter] # OpenRouter
pip install openagenticskyzer[all]        # every provider at once
```

**Or plain install + provider separately:**

```bash
pip install openagenticskyzer
pip install langchain-groq   # or langchain-together, langchain-mistralai, etc.
```

Want Langfuse observability too?

```bash
pip install openagenticskyzer[groq,langfuse]
```

### 2. Configure your API key

Create a `.env` file in your project folder (or home directory):

```env
# Pick one provider — the first key found is used

TOGETHER_API_KEY=your_key_here
# GROQ_API_KEY=your_key_here
# MISTRAL_API_KEY=your_key_here
# GEMINI_API_KEY=your_key_here
# OPENROUTER_API_KEY=your_key_here
```

Get a free key:
- [Together AI](https://api.together.xyz/settings/api-keys)
- [Groq](https://console.groq.com/keys)
- [Mistral](https://console.mistral.ai/api-keys)
- [Gemini](https://aistudio.google.com/app/apikey)
- [OpenRouter](https://openrouter.ai/settings/keys)

### 3. Run

```bash
cd your-project
openagent
```

Or pass a query directly:

```bash
openagent "refactor the auth module to use JWT"
openagent --mode plan "migrate the database to PostgreSQL"
```

---

## Supported providers & default models

| Provider | Default model |
|---|---|
| Together AI | `Qwen/Qwen3-Coder-Next-FP8` |
| Groq | `moonshotai/kimi-k2-instruct` |
| Mistral | `codestral-latest` |
| Gemini | `gemini-2.5-pro-preview-03-25` |
| OpenRouter | `kwaipilot/kat-coder-pro-v2` |

Override the model for any provider:

```env
TOGETHER_MODEL=meta-llama/Llama-3-70b-chat-hf
GROQ_MODEL=llama3-70b-8192
GEMINI_MODEL=gemini-2.0-flash
```

---

## Agent modes

| Mode | Behavior |
|---|---|
| `auto` *(default)* | Plans, edits files, and runs commands autonomously |
| `ask` | Read-only — answers questions and explains code, no file changes |
| `plan` | Produces a step-by-step plan and waits for your approval before acting |

```bash
openagent --mode ask "how does the authentication flow work?"
openagent --mode plan "add Stripe payment integration"
```

---

## Environment variables

```env
# Provider API keys (first found is used)
TOGETHER_API_KEY=
GROQ_API_KEY=
MISTRAL_API_KEY=
GEMINI_API_KEY=
OPENROUTER_API_KEY=

# Optional: override default model per provider
TOGETHER_MODEL=
GROQ_MODEL=
MISTRAL_MODEL=
GEMINI_MODEL=
OPENROUTER_MODEL=

# Optional: show full LLM context on each call (debug)
OPENCODE_SHOW_CONTEXT=1

# Optional: Tavily key for internet search
TAVILY_API_KEY=

# Optional: keyword-relevant images (priority: Unsplash → Pexels → placeholder)
UNSPLASH_ACCESS_KEY=   # https://unsplash.com/developers
PEXELS_API_KEY=        # https://www.pexels.com/api/
```

---

## Requirements

- Python >= 3.10
- A valid API key for at least one supported provider (see install extras above)

---

## License

MIT — built by Abdel-Hazim Lawani
