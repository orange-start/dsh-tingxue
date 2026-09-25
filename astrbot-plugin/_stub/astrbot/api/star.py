"""minimal astrbot.api.star stub"""


class Context:
    pass


class Star:
    def __init__(self, context=None):
        self.context = context


def register(*args, **kwargs):
    def deco(cls):
        cls._reg = (args, kwargs)
        return cls

    return deco
