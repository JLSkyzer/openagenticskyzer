# Electron Desktop GUI Implementation Plan

> **OBSOLETE — 2026-09-14. Do not execute.** This plan retained a Python backend,
> contrary to the approved full JavaScript/TypeScript migration. Kept only as a
> record of the prototype's scope, not as the current implementation instructions.
> Current contract: `../specs/2026-09-14-electron-autonomous-design.md`.
> Feature inventory: `2026-09-14-electron-parity.md`.
> Current progress and ordered work: `tasks/todo.md` at repository root.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the incomplete Tk/NiceGUI shell with a single modern Electron desktop application backed by the existing Python agent.

**Architecture:** Electron main process owns one secure BrowserWindow and a Python JSON-lines worker. The renderer is a self-contained HTML/CSS/JS interface; all filesystem, provider, session, plugin and agent operations remain in Python.

**Tech Stack:** Electron, vanilla HTML/CSS/JavaScript initially (no framework bootstrapping required), Node.js LTS/npm, Python 3.14 backend.

**Spec:** `docs/superpowers/specs/2026-09-14-electron-gui-design.md`

## Tasks

### Task 1 — Electron project and secure main process

- Create `electron/package.json`, `electron/main.cjs`, `electron/preload.cjs`, and `electron/renderer/`.
- Configure one `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, and external navigation blocked.
- Add `npm start` and `npm run dev` scripts.
- Test with `node --check` and a renderer smoke test.

### Task 2 — Python JSON-lines bridge

- Create `openagenticskyzer/desktop/backend.py` with request/response envelopes.
- Implement operations for project activation, history, settings, plugins, MCP, index status, agent send and stop.
- Keep long-running agent calls off the Electron UI thread and emit `event` messages.
- Test protocol parsing and error isolation without a GUI.

### Task 3 — Visual shell and project sidebar

- Build the responsive renderer layout with design tokens, top bar, sidebar, history, knowledge section, and single-window state.
- Wire open-folder and project activation through preload IPC.
- Match the existing visual hierarchy with polished spacing, typography, hover states, and empty/loading/error states.

### Task 4 — Conversation and agent controls

- Implement message cards, Markdown-safe rendering, input composer, provider/model status, send/stop, streaming events, and keyboard shortcuts.
- Load/save existing sessions through the Python bridge.
- Add regeneration/edit/fork controls using the existing branching backend where possible.

### Task 5 — Project settings and integrations

- Implement a real project settings page for provider, API key, model, base URL, agent mode, context limits, ignored patterns, custom prompt, plugins and MCP.
- Implement global settings, appearance, permissions, memory and danger actions.
- Persist with existing storage and `.env` conventions.

### Task 6 — Feature parity panels

- Add command palette, exports, downloads/model catalog entry points, artifact panel, compaction action, index progress and permission prompts.
- Ensure every action has a visible success/error state.

### Task 7 — Launch migration and verification

- Add a documented `npm install` / `npm start` workflow and optional Python launcher delegation.
- Keep a clearly named legacy NiceGUI command only for rollback during development.
- Run protocol tests, Node syntax checks, and a Windows manual smoke test; update todo/lessons and commit/push.
