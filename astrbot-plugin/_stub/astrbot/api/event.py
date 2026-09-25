"""minimal astrbot.api.event stub: filter namespace + AstrMessageEvent"""


class AstrMessageEvent:
    pass


class _FilterNamespace:
    class EventMessageType:
        GROUP_MESSAGE = "group"
        PRIVATE_MESSAGE = "private"
        OTHER_MESSAGE = "other"
        ALL = "all"

    class PermissionType:
        ADMIN = "admin"

    def event_message_type(self, t):
        def deco(fn):
            fn._message_type = t
            return fn

        return deco

    def on_llm_request(self):
        def deco(fn):
            return fn

        return deco

    def command(self, name):
        def deco(fn):
            fn._command = name
            return fn

        return deco

    def permission_type(self, p):
        def deco(fn):
            return fn

        return deco


filter = _FilterNamespace()
