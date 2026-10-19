# DSH 节点连线试验

实现入口：`lib/site/adapters/connections.js`，由 `lib/site/entry.js` 挂载。未修改上游 SDK 源码。

## 操作和数据

选中节点后出现左右端口，从右端口拖向另一节点左端口。三次贝塞尔两端水平，箭头指向目标。端口向外偏移 14 屏幕像素以避开 SDK 的缩放手柄。重复连线和自身连线不创建；锁定节点不能编辑连线。点选曲线，Delete/Backspace 删除，Escape 取消。

`props.from: string[]` 保存来源节点 ID，`props.to: string[]` 保存目标节点 ID。新建节点初始化为空；旧节点缺失字段按空数组读取，建立关系时补齐。两端更新放在 SDK 同一 transaction 内，沿用现有保存与撤销/重做。仅双向索引互相匹配且端点存在时显示连线，节点隐藏时连线也隐藏。删除节点时在同一事务清理相邻引用，撤销时一起恢复。复制节点暂不重映射选区内部连线；原始关系字段保留，但只有互相匹配的端点才显示。

SVG 是 DSH 浏览器覆盖层，订阅 SDK change/viewport:change/selection:change，并合并到动画帧更新。当前连线不会出现在 SDK 导出图片中；大量边、自动避障和多端口尚未实现。

## SDK 迁移

当前 SDK 无 edge/connector 专用 API，节点顶层 patch 字段固定，自定义数据放 JSON props。现有 viewport、transaction、节点 CRUD 和 overlay 能支持插件原型。

后续可在 SDK 定义稳定的连接模型、端口定义与 connect/disconnect 命令，统一端点删除、复制、导出和关系校验；将 SVG 曲线替换为 Pixi connector renderer，把端口和交互保留在 overlay 层。避免把 DSH transport 或持久化服务带入 SDK。

本轮遵循项目约定，不执行前端测试、构建或类型检查。

## 端口和连线样式更新

悬停节点时仅显示右侧小连接点。拖到目标节点矩形内部即可连接，不显示左侧端口。曲线直接贴合源节点右侧和目标节点左侧，不带箭头，以起点到终点的颜色渐变表达方向。点击连线打开样式栏，支持两端颜色、线宽、实线/虚线/点线。样式保存在源节点 `props.connectionStyles[targetNodeId]`，与画布一同保存并支持撤销。
