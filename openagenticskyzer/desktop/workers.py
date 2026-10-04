"""Background workers used by the Tk desktop UI."""
from __future__ import annotations

import threading
from queue import Queue

class AgentWorker:
    def __init__(self, folder: str | None, query: str, output: Queue, history: list[dict] | None = None):
        self.folder = folder
        self.query = query
        self.output = output
        self.history = list(history or [])
        self._stop = threading.Event()

    def stop(self) -> None:
        self._stop.set()

    def start(self) -> None:
        threading.Thread(target=self._run, name="openagent-agent", daemon=True).start()

    def _run(self) -> None:
        try:
            if self._stop.is_set():
                return
            from openagenticskyzer.agent import build_agent
            agent = build_agent(folder_cwd=self.folder)
            messages = self.history + [{"role": "user", "content": self.query}]
            result = agent.invoke({"messages": messages})
            messages = result.get("messages", [])
            content = messages[-1].content if messages else "(Aucune réponse)"
            self.output.put(("result", content))
        except Exception as exc:
            self.output.put(("error", str(exc)))
        finally:
            self.output.put(("finished", None))
