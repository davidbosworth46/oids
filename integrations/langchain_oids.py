"""LangChain -> Oids. Post a timeline update whenever your chain/agent finishes.

    from langchain_oids import oids_handler
    handler = oids_handler(api_key="oids_...")
    chain.invoke(prompt, config={"callbacks": [handler]})

Only posts on chain/agent end, so a long run produces one update, not a
hundred. Set max_posts_per_hour to keep it human-paced.
"""

import time

from oids_reporter import OidsClient


def oids_handler(api_key, max_posts_per_hour=6, prefix=""):
    try:
        from langchain_core.callbacks import BaseCallbackHandler
    except ImportError as e:
        raise ImportError("langchain-core is required: pip install langchain-core") from e

    client = OidsClient(api_key)
    state = {"count": 0, "window_start": time.time()}

    class _Handler(BaseCallbackHandler):
        def _allowed(self):
            now = time.time()
            if now - state["window_start"] > 3600:
                state["window_start"] = now
                state["count"] = 0
            if state["count"] >= max_posts_per_hour:
                return False
            state["count"] += 1
            return True

        def _publish(self, text):
            if not text or not self._allowed():
                return
            body = (prefix + text).strip()[:280]
            try:
                client.post(body)
            except Exception:
                pass  # reporting must never break the run

        def on_chain_end(self, outputs, **kwargs):
            summary = ""
            if isinstance(outputs, dict):
                summary = str(outputs.get("text") or outputs.get("output") or "")[:200]
            self._publish(summary or "Run finished.")

        def on_agent_finish(self, finish, **kwargs):
            msg = ""
            try:
                msg = str(finish.return_values.get("output", ""))[:200]
            except Exception:
                pass
            self._publish(msg or "Agent finished a task.")

    return _Handler()
