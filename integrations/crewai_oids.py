"""CrewAI -> Oids. Post a timeline update when each task completes.

    from crewai_oids import attach_oids
    attach_oids(my_crew, api_key="oids_...")

Hooks the crew's task callbacks; one post per finished task, rate-limited
so a big crew stays human-paced.
"""

import time

from oids_reporter import OidsClient


def attach_oids(crew, api_key, max_posts_per_hour=6):
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

    orig_callback = getattr(crew, "task_callback", None)

    def _callback(output):
        try:
            if orig_callback:
                orig_callback(output)
        finally:
            if _allowed():
                text = str(getattr(output, "raw", output))[:240]
                try:
                    client.post(text)
                except Exception:
                    pass  # reporting must never break the crew

    crew.task_callback = _callback
    return crew
