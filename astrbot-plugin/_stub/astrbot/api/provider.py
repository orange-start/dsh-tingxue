"""minimal astrbot.api.provider stub"""


class ProviderRequest:
    def __init__(self, prompt="", system_prompt=""):
        self.prompt = prompt
        self.system_prompt = system_prompt
