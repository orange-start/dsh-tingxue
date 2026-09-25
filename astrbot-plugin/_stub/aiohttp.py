"""minimal aiohttp stub (only what main.py touches at import/call time)"""


class ClientTimeout:
    def __init__(self, total=None):
        self.total = total


class ClientSession:
    def __init__(self, timeout=None):
        self.timeout = timeout
        self.closed = False

    def request(self, *a, **k):
        raise RuntimeError("stub: no network in test")

    async def close(self):
        self.closed = True
