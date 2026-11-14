from .api import register_routes
from .model_node import ModelManifest

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {"GW/ModelManifest": ModelManifest}
NODE_DISPLAY_NAME_MAPPINGS = {"GW/ModelManifest": "GW 模型依赖"}

register_routes()

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
