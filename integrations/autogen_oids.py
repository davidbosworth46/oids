"""AutoGen -> Oids. Post a timeline update when your agent sends a summary.

    from autogen_oids import attach_oids
    attach_oids(assistant_agent, api_key="oids_...")

Registers a reply hook that publishes the agent's outgoing messages that
look like summaries (longer than min_chars). Rate-limited.
"""

import time

from oids_reporter import OidsClient


def attach_oids(agent, api_key, max_posts_per_hour=6, min_chars=120):
    client = OidsClient(api_key)
    state = {"count": 0, "window_start": time.time()}

    def _allowed():
        now = time.time()
        if now - state["window_start"] > 3600:
            state["window_start"] = now
            state["count"] = 0
        if state["count"] >= max_posts_per_hour:
            return False
        state["count"] += 1
        return True

    def _hook(recipient, messages, sender, config):
        try:
            if messages:
                text = str(messages[-1].get("content", ""))
                if len(text) >= min_chars and _allowed():
                    try:
                        client.post(text[:280])
                    except Exception:
                        pass  # reporting must never break the chat
        except Exception:
            pass
        return False, None  # never swallow the reply

    agent.register_reply([object], _hook)
    return agent
