# @xindong/dsh-client-canvas

DeepSeek Harness Web 的画布显示适配。它不保存第二份画布数据，而是：

1. 在 Host 注册 `/xindong-canvas` HTTP Bridge；
2. 在 Web Client 的 `conversation.view` 注册 `Canvas` 标签；
3. 使用 [PixiBoardSDK](https://github.com/xindong/pixiboardSDK) 渲染当前 Session 的画布；
4. 把用户写入提交回 `@xindong/dsh-canvas`，再由 Core 返回新的 revision。

## 安装

先安装 Core，再安装本适配：

```bash
dsh plugin --profile web add github:xindong/dsh-canvas
dsh plugin --profile web add github:xindong/dsh-client-canvas
dsh web
```

本地开发可把 GitHub spec 换为绝对目录。

## 边界

- `@xindong/dsh-canvas`：文档、revision、持久化、Agent 工具。
- `@xindong/dsh-client-canvas`：Web HTTP 与视图。
- PixiBoard registry：仅用于插件内部的节点渲染，不对外形成“画布插件套插件”的产品模型。

未来桌面端应直接复用 Core，并单独提供 Tauri/Electron/原生 UI 适配。
