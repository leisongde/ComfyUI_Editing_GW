from .manifest import check_models, resolve_selected_model


class ModelManifest:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "selected_model": ("STRING", {"default": "", "tooltip": "仅连线选型时使用。不连线时按 UNET 等加载器的最终模型名补齐。"}),
            "manifest": ("STRING", {"default": '{"version":1,"models":[]}', "hidden": True}),
        }}

    # Legacy loader combos use per-folder file lists as their input type.
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("模型名称",)
    FUNCTION = "select_model"
    CATEGORY = "GW"
    DESCRIPTION = "无需连线。登记模型及候选版本的下载地址，在任务校验和排队前按加载器的最终模型名补齐缺失文件。模型名称输出为可选用法。"

    def select_model(self, selected_model, manifest):
        model = resolve_selected_model(selected_model, manifest)
        checked = check_models([model])[0]
        if checked["status"] != "exists":
            raise ValueError(f"模型尚未就绪：{model['relative_path']}，请检查自动补齐错误")
        return (checked["loader_value"],)
