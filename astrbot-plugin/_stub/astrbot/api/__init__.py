"""minimal astrbot.api stub for offline handler tests"""


class _Logger:
    def _p(self, level, msg):
        print(f"[{level}] {msg}")

    def info(self, msg):
        self._p("info", msg)

    def warning(self, msg):
        self._p("warn", msg)

    def error(self, msg):
        self._p("error", msg)

    def debug(self, msg):
        self._p("debug", msg)


logger = _Logger()
