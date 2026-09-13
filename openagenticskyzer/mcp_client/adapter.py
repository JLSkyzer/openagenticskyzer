"""Bridge MCP stdio servers to LangChain tools.

The optional MCP dependency is imported lazily. Each invocation opens a short
stdio session, so returned tools remain usable after discovery completes.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor

from langchain_core.tools import StructuredTool

def _run_sync(coro_factory):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro_factory())
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro_factory())).result()

async def _discover(config: dict):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    params = StdioServerParameters(
        command=config["command"],
        args=list(config.get("args") or []),
        env=dict(config.get("env") or {}),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return list(getattr(result, "tools", []) or [])

async def _invoke(config: dict, name: str, arguments: dict):
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    params = StdioServerParameters(command=config["command"], args=list(config.get("args") or []), env=dict(config.get("env") or {}))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(name, arguments=arguments)
            return getattr(result, "content", result)

def load_mcp_tools(server_config: dict) -> tuple[list[StructuredTool], list[str]]:
    """Discover one server's tools, isolating unavailable/broken servers."""
    command = server_config.get("command") if isinstance(server_config, dict) else None
    if not isinstance(command, str) or not command.strip():
        return [], ["MCP: commande absente"]
    try:
        remote_tools = _run_sync(lambda: _discover(server_config))
    except Exception as exc:
        return [], [f"MCP {command}: {exc}"]
    tools = []
    for remote in remote_tools:
        name = getattr(remote, "name", "")
        if not name:
            continue
        description = getattr(remote, "description", "") or f"Outil MCP {name}"
        def make_call(tool_name: str):
            async def call(**kwargs):
                return _run_sync(lambda: _invoke(server_config, tool_name, kwargs))
            call.__name__ = f"mcp_{tool_name}"
            return call
        tools.append(StructuredTool.from_function(make_call(name), name=f"mcp_{name}", description=description))
    return tools, []
