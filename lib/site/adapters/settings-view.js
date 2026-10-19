// Presentation and explanations stay separate from settings storage/application.
const INFO_ICON = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7" stroke="currentColor" stroke-width="1.4"/><path d="M10 9v5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="10" cy="6" r=".9" fill="currentColor"/></svg>'
const CHEVRON_ICON = '<svg class="settings-chevron" width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))

const HELP = {
  'canvas.minZoom': ['最小缩放', '当前浏览器 · 修改后立即生效', '限制画布能缩小到的比例，20% 表示原始尺寸的五分之一。用于滚轮、缩放快捷键、适应视图及视图恢复；如果当前比例超出新范围，会立即调整到允许范围。只影响浏览视图，不改变节点尺寸或导出数据。'],
  'canvas.maxZoom': ['最大缩放', '当前浏览器 · 修改后立即生效', '限制画布能放大到的比例，500% 表示放大到五倍。当前比例超过新上限时会立即调整。与最小缩放一起约束滚轮、快捷键和恢复视图。'],
  'canvas.background': ['画布背景', '当前浏览器 · 修改后立即生效', '设置画布浏览区域的底色，所有画布沿用此浏览器偏好。它不创建背景节点，也不会写进画布文档；SDK 截图不保证包含这个页面背景。'],
  'canvas.grid': ['显示网格', '当前浏览器 · 修改后立即生效', '点阵以画布世界原点为基准，随平移和缩放移动；缩放时会自适应网格间距以保持清晰。这只是视觉参考，不提供吸附，也不会保存到画布数据。'],
  'connections.enabled': ['开启连线', '当前浏览器 · 修改后立即生效', '控制连线、右侧连接点和拖线交互。关闭后已有关系保留，重新开启即可显示。节点 Agent 的上下游采集也会停止沿这些连线扩展；DSH 画布工具仍可查询已保存的关系，这不是权限开关。'],
  'connections.startColor': ['起点颜色', '当前浏览器 · 统一应用到全部连线', '源节点右侧是起点，线条从这个颜色渐变到目标节点左侧的终点颜色。已有连线和之后创建的连线统一使用，不提供单条线覆盖。'],
  'connections.endColor': ['终点颜色', '当前浏览器 · 统一应用到全部连线', '控制目标节点左侧的颜色，与起点颜色形成方向渐变。连线没有箭头，源 → 目标方向由连接关系决定，改变颜色不会反转关系。'],
  'connections.startOpacity': ['起点不透明度', '当前浏览器 · 修改后立即生效', '0% 为完全透明，100% 为完全不透明。透明度沿线逐渐过渡到终点值，只影响显示，不会删除关系。'],
  'connections.endOpacity': ['终点不透明度', '当前浏览器 · 修改后立即生效', '控制线条到达目标节点时的不透明度。与起点值一起形成渐变；即使设为 0%，关系仍然保留。'],
  'connections.width': ['线宽', '当前浏览器 · 修改后立即生效', '统一调整全部连线的基础宽度。连线在画布世界坐标中绘制，会随画布缩放一起变化；选中时会额外高亮，便于定位和用 Delete / Backspace 删除。'],
  'connections.lineType': ['线型', '当前浏览器 · 修改后立即生效', '可选择实线、虚线或点线，统一应用到已有及新建连线。线型仅影响外观，不影响连线方向和 Agent 的上下游查询。'],
  'agent.enabled': ['节点中的 [agent操作] 按钮', '点击保存后应用到当前浏览器', '控制节点工具栏中的 [agent操作] 按钮是否显示。关闭时会取消尚未完成的上下文准备并关闭节点输入框；不会停止已经发送到 DSH 的模型任务。'],
  'agent.scope': ['参考哪些节点', '保存后，下次节点预览或发送时使用', '当前节点：仅采集正在操作的节点。上游：沿入边查找来源节点；下游：沿出边查找目标节点；相连节点：两个方向都查找。采集遵守层数和预算限制，循环关系会去重。关闭“连线”后不再扩展邻居。'],
  'agent.maxDepth': ['上下游层数', '保存后，下次采集时使用', '从当前节点出发最多沿连线走几层。0 只包含当前节点，1 包含直接相邻节点，2 可继续包含相邻节点的邻居。选择“当前节点”范围时，此项不扩展采集。'],
  'agent.maxNodes': ['最多包含节点', '保存后，下次采集时使用', '限制本次上下文中节点的总数，当前节点也计入。超过上限会停止扩展，并在上下文中记录截断原因。它不是画布最多节点数，也不限制 Agent 之后通过工具继续读取。'],
  'agent.maxResources': ['最多包含资源引用', '保存后，下次采集时使用', '限制随节点上下文采集的资源描述数量。0 表示不附带资源描述和原文件引用。当前附带的是描述与 original_url 等引用，不会在发送时自动上传所有原文件。资源内容还受下方“附带资源引用”开关控制。'],
  'agent.maxChars': ['上下文字符上限', '保存后，下次采集时使用', '限制采集节点、资源和关系的序列化字符预算，不是 token 数，也不是模型上下文窗口大小。超限时会省略或精简内容并记录截断原因。用户指令、指导语和自定义模板本身不计入这项采集预算。消息字段开关在采集后才应用，关闭字段不会回收已占用的采集预算。'],
  nodePreferences: ['处理偏好', '保存后，每次节点操作都会附带', '填写你希望 AI 遵守的处理习惯，例如保持原图比例、先给建议、不要修改原文。它会作为用户要求附加到每次从节点发起的消息中。与本次输入的操作指令一起使用，不会单独发送消息。留空则不添加额外要求。'],
  systemEnabled: ['系统提示词', '本机 DSH · 保存后参与后续模型步骤', '在 DSH 的系统提示词后面追加的内容，告诉 Agent 如何使用画布。通常保留默认，也可填写先读后写、处理版本冲突等操作规则。按原文注入，不替换模板变量；关闭后保留文本。'],
  contextEnabled: ['动态提示词', '本机 DSH · 准备模型步骤时采样', '用户发送消息后，自动向 AI 提供当前画布概况；后续模型步骤也会检查，动态上下文变化时追加更新。可用变量：{{board_id}} 画布 ID、{{revision}} 已保存版本、{{node_count}} 节点数、{{connection_count}} 连线数，必须保留 {{board_id}}。仅描述已保存状态，具体内容仍需通过画布工具读取；关闭后保留文本。'],
  includeNodeContent: ['附带节点正文', '本机 DSH · 节点消息生成时应用', '控制 {{context}} 中是否包含节点 props，例如文本正文及节点类型的业务字段。关闭后仍会包含节点身份和类型；它控制本次消息附带内容，不限制 Agent 通过 canvas_read 读取节点。'],
  includeGeometry: ['附带位置与尺寸', '本机 DSH · 节点消息生成时应用', '控制 {{context}} 是否包含节点的位置、宽高、旋转、层级及锁定/可见状态，适合布局类任务。关闭后这些字段不附带在节点消息中；画布本身不会发生变化。'],
  includeAssets: ['附带资源引用', '本机 DSH · 节点消息生成时应用', '控制节点 assetRefs、资源描述和解析出的原文件 URL 是否写入 {{context}}。同时受资源数量和字符预算限制。关闭只减少本次消息内容，不删除资源，也不改变画布工具的读取权限。'],
  includeConnections: ['附带连线关系', '本机 DSH · 节点消息生成时应用', '控制是否将本次已采集节点之间的关系写入 {{context}}。选择“当前节点”时不自动采集邻接边；图范围下只附带两端都已纳入上下文的边。关闭此项不会阻止按所选范围采集上游/下游节点，范围由上方采集设置决定。'],
  timing: ['三种内容在什么时候进入模型？', '保存配置 ≠ 发送消息', '系统说明：每个模型步骤前重新组装，同一步重试复用该次结果。动态概况：每步读取已保存画布，全部动态上下文文本变化时才追加新快照。节点消息：只有提交节点指令才发送到当前对话；“预览提示词”会先保存画布、准备并展示本次消息，不调用模型。保存配置不主动发起模型请求，已经组装或发出的请求不会被改写。'],
  'action.reload': ['重新载入', '读取服务端 · 会替换当前提示词草稿', '重新读取本机 DSH 已保存的处理偏好和高级提示词，覆盖这部分草稿；保留当前浏览器的参考范围和读取限制草稿。多窗口同时保存导致冲突时可以先导出草稿，再重新载入并合并修改。不会重置浏览器的视图或采集偏好。'],
  'action.defaults': ['恢复 Agent 默认设置', '恢复到草稿，保存后应用', '恢复节点入口、参考范围、读取限制、处理偏好及高级提示词的默认值。不会修改画布和连线设置。点击“保存设置”后才应用，关闭弹窗会保留这份草稿。'],
  'action.import': ['导入 Agent 配置', '导入到草稿，保存后应用', '从 JSON 文件导入参考范围、读取限制、处理偏好和高级提示词。兼容之前导出的提示词配置；旧格式只覆盖提示词部分。导入不会执行代码或立即改变已保存设置。'],
  'action.export': ['导出 Agent 配置', '下载当前草稿', '导出节点入口、参考范围、读取限制、处理偏好和高级提示词，包含尚未保存的编辑。不包含画布节点、资源文件、视图或连线偏好。'],
  'action.save': ['保存节点与提示词设置', '保存成功后应用', '同时应用当前浏览器的节点操作偏好，以及本机 DSH 共享的处理偏好和高级提示词。提示词会在后续模型步骤或下次节点消息准备时使用。保存不会调用模型，也不改写历史消息。'],
  'action.localReset': ['重置浏览器偏好', '当前浏览器 · 立即恢复默认', '恢复画布缩放、背景、网格、连线样式，以及节点 Agent 入口和采集预算的默认值。不会重置本机共享的系统说明或提示词模板；后者可在 “提示词”页的“配置备份与恢复”中恢复默认。'],
}

function info(key, label = HELP[key]?.[0] ?? '设置') {
  return `<button type="button" class="settings-info" data-setting-help="${escape(key)}" aria-label="${escape(label)}，查看详细说明" aria-expanded="false">${INFO_ICON}</button>`
}
function row(key, title, control, text = false) {
  const id = `dsh-setting-${key.replaceAll('.', '-')}`
  let markup = control.replace(/^<(input|select|textarea)/, `<$1 id="${id}"`)
  const unit = { 'canvas.minZoom': '%', 'canvas.maxZoom': '%', 'connections.startOpacity': '%', 'connections.endOpacity': '%', 'connections.width': 'px', 'agent.maxDepth': '层', 'agent.maxNodes': '个', 'agent.maxResources': '项', 'agent.maxChars': '字符' }[key]
  if (unit) markup = `<span class="settings-input-unit">${markup}<span>${unit}</span></span>`
  return `<div class="settings-row${text ? ' settings-text-row' : ''}"><div class="settings-field-label"><label for="${id}">${title}</label>${info(key, title)}</div>${markup}</div>`
}
const local = (key, title, type, rest = '') => row(key, title, `<input name="${key}" type="${type}" ${rest}>`)
const toggle = (key, title) => row(key, title, `<input data-prompt="${key}" type="checkbox" role="switch">`)
const text = (key, title, max, rows = 4) => row(key, title, `<textarea data-prompt="${key}" maxlength="${max}" rows="${rows}" spellcheck="false"></textarea>`, true)
const choice = (name, value, title, type = 'radio') => `<label class="node-choice"><input type="${type}" ${type === 'checkbox' ? `data-prompt="${name}"` : `name="${name}" value="${value}"`}><span>${title}</span></label>`
function group(title, badge, contents) {
  return `<section class="settings-group"><h4 class="settings-group-heading"><span class="settings-group-title">${title}</span></h4><div class="settings-group-body">${contents}</div></section>`
}
function action(attribute, title, key) {
  return `<span class="settings-action-pair"><button type="button" ${attribute}>${title}</button></span>`
}

export const settingsMarkup = `<header><div><h2 id="dsh-settings-title">画布设置</h2><p>按你的习惯设置画布</p></div><button type="button" data-close aria-label="关闭设置">×</button></header>
  <div class="settings-layout"><nav aria-label="设置分类"><button type="button" data-tab="canvas" aria-pressed="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 9v12"/></svg><span>画布</span></button><button type="button" data-tab="connections" aria-pressed="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a3 3 0 0 1 3 3v6a3 3 0 0 0 3 3"/></svg><span>连线</span></button><button type="button" data-tab="agent" aria-pressed="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="2"/><rect x="13" y="13" width="8" height="7" rx="2"/><path d="M7 11v5a1 1 0 0 0 1 1h5"/></svg><span>节点</span></button><button type="button" data-tab="prompts" aria-pressed="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M7 8h10M7 12h7"/></svg><span>提示词</span></button><button type="button" data-tab="config" aria-pressed="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/></svg><span>配置</span></button></nav>
  <form method="dialog" class="settings-pages">
    <section data-page="canvas">
      <div class="settings-page-heading"><h3>画布视图</h3><p>只调整浏览方式，保存在当前浏览器并应用到全部画布。</p></div>
      ${group('缩放范围', '立即应用', local('canvas.minZoom', '最小缩放', 'number', 'min="5" max="100" step="5" aria-description="百分比"') + local('canvas.maxZoom', '最大缩放', 'number', 'min="20" max="1000" step="25" aria-description="百分比"') + '<p class="settings-help">单位为 %，同时约束滚轮、快捷键和视图恢复。</p>', true)}
      ${group('背景与辅助', '浏览器偏好', local('canvas.background', '画布背景', 'color') + local('canvas.grid', '显示网格', 'checkbox', 'role="switch"'), true)}
    </section>
    <section data-page="connections" class="settings-connections-page" hidden>
      <div class="settings-page-heading"><h3>节点连线</h3><p>样式统一应用到已有和新建连线。选中后按 Delete / Backspace 删除。</p></div>
      ${group('显示与交互', '立即应用', local('connections.enabled', '开启连线', 'checkbox', 'role="switch"'), true)}
      ${group('方向与渐变', '统一样式', local('connections.startColor', '起点颜色', 'color') + local('connections.endColor', '终点颜色', 'color') + local('connections.startOpacity', '起点不透明度', 'number', 'min="0" max="100" step="5" aria-description="百分比"') + local('connections.endOpacity', '终点不透明度', 'number', 'min="0" max="100" step="5" aria-description="百分比"') + '<p class="settings-help">源节点右侧 → 目标节点左侧。不透明度单位为 %。</p>', true)}
      ${group('线条外观', '统一样式', local('connections.width', '线宽', 'number', 'min="0.5" max="6" step="0.1"') + `<div class="settings-row"><div class="settings-field-label"><span>线型</span>${info('connections.lineType')}</div><div class="line-type-options">${choice('connections.lineType', 'solid', '实线')}${choice('connections.lineType', 'dashed', '虚线')}${choice('connections.lineType', 'dotted', '点线')}</div></div>`)}
    </section>
    <section data-page="agent" class="settings-agent-page" hidden>
      <div class="settings-page-heading"><h3>节点</h3><p>配置从画布节点发起的 AI 操作。</p></div>
      <div class="node-agent-group">
        <div class="node-enable-row"><div class="node-enable-copy"><div><strong>节点中的 [agent操作] 按钮</strong>${info('agent.enabled')}</div></div><input id="dsh-setting-agent-enabled" name="agent.enabled" type="checkbox" role="switch" aria-label="节点中的 [agent操作] 按钮"></div>
        <div class="agent-settings-content"><div class="agent-common">
        <div class="node-choice-section"><div class="node-choice-title">参考哪些节点</div><div class="node-choice-options">${choice('agent.scope', 'node', '当前节点')}${choice('agent.scope', 'upstream', '来源节点')}${choice('agent.scope', 'downstream', '后续节点')}${choice('agent.scope', 'connected', '相连节点')}</div></div>
        <div class="node-choice-section"><div class="node-choice-title">携带的节点信息</div><div class="node-choice-options">${choice('includeNodeContent', 'true', '文字与内容', 'checkbox')}${choice('includeGeometry', 'true', '位置尺寸', 'checkbox')}${choice('includeAssets', 'true', '文件信息', 'checkbox')}${choice('includeConnections', 'true', '连线关系', 'checkbox')}</div></div>
        ${row('nodePreferences', '处理偏好（选填）', '<textarea data-prompt="nodePreferences" maxlength="4000" rows="2" placeholder="例如：保持图片比例；先给出建议，不直接修改。"></textarea>', true)}
        </div>
        <section class="agent-advanced settings-group"><h4 class="settings-group-heading"><span class="settings-group-title">参考节点上限</span></h4><div class="settings-group-body">
        ${local('agent.maxDepth', '沿连线参考几层', 'number', 'min="0" max="10" step="1"')}${local('agent.maxNodes', '最多参考节点数', 'number', 'min="1" max="100" step="1"')}${local('agent.maxResources', '最多附带文件数', 'number', 'min="0" max="100" step="1"')}${local('agent.maxChars', '资料字数预算', 'number', 'min="1000" max="100000" step="1000"')}
        </div></section></div>
      </div>
    </section>
    <section data-page="prompts" class="settings-prompts-page" hidden>
      <div class="settings-page-heading"><h3>提示词</h3><p>为 DSH 补充画布操作说明和当前画布概况。</p></div>
      <fieldset data-prompt-fields>
        <div class="prompt-injection-block">${toggle('systemEnabled', '系统提示词')}<div class="prompt-injection-editor"><textarea id="dsh-setting-systemText" data-prompt="systemText" aria-label="系统提示词内容" maxlength="12000" rows="5" spellcheck="false"></textarea></div></div>
        <div class="prompt-injection-block">${toggle('contextEnabled', '动态提示词')}<div class="prompt-injection-editor"><textarea id="dsh-setting-contextTemplate" data-prompt="contextTemplate" aria-label="动态提示词内容" maxlength="20000" rows="4" spellcheck="false"></textarea></div></div>
      </fieldset>
      <div class="agent-timing-help prompt-timing"><h4>这些提示词什么时候注入？</h4><dl><div><dt>系统提示词</dt><dd>每一步模型请求前，追加到 DSH 的系统提示词中。同一步重试复用当次结果。</dd></div><div><dt>动态提示词</dt><dd>每步读取已保存的画布概况；动态上下文变化时，追加更新后的快照。</dd></div></dl><p>在当前 Agent 可以使用画布工具时生效，无需从节点发起操作。配置在本机 DSH 的各对话间共享，保存不会改写已经发出的请求。</p></div>
    </section>
    <section data-page="config" class="settings-config-page" hidden>
      <div class="settings-page-heading"><h3>配置</h3><p>管理画布保存目录，以及节点与提示词设置。</p></div>
      ${group('保存目录', '', `<div class="settings-text-row settings-row"><input id="dsh-storage-root" data-storage-root type="text" aria-label="保存目录" spellcheck="false" autocomplete="off" placeholder="填写绝对路径或 ~/目录" aria-describedby="dsh-storage-status" disabled></div>
        <div class="prompt-actions"><button type="button" data-storage-choose disabled>选择目录</button><button type="button" data-storage-open disabled>打开目录</button></div>
        <p class="settings-help" id="dsh-storage-status" data-storage-status role="status" aria-live="polite"></p>`)}
      ${group('配置备份与恢复', '', '<div class="prompt-actions">' + action('data-prompt-defaults', '恢复默认', 'action.defaults') + action('data-prompt-import', '导入配置', 'action.import') + action('data-prompt-export', '导出配置', 'action.export') + action('data-prompt-reload', '重新载入', 'action.reload') + '</div><input type="file" data-prompt-file accept="application/json,.json" hidden>')}
    </section>
  </form></div>
  <footer data-view-footer><span class="settings-action-pair"><button type="button" data-reset>重置浏览器偏好</button>${info('action.localReset')}</span><button type="button" data-close class="primary">完成</button></footer>
  <footer data-agent-footer hidden><p data-prompt-status role="status" aria-live="polite">正在读取设置…</p><div class="agent-footer-actions"><button type="button" data-close>关闭</button><button type="button" data-prompt-save class="primary">保存设置</button></div></footer>`

export const settingsStyles = `
.dsh-canvas-settings .storage-current{margin:4px 0 12px;overflow-wrap:anywhere;color:#263247}.dsh-canvas-settings [data-storage-root]{width:100%;max-width:none}.dsh-canvas-settings [data-storage-status]{color:#505b6d}
.dsh-canvas-settings{box-sizing:border-box;width:min(680px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:0;border:1px solid #dce2ec;border-radius:18px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#263247);box-shadow:0 24px 80px #15244426;font:13px/1.6 system-ui;overflow:visible}
.dsh-canvas-settings[open]{display:flex;flex-direction:column}.dsh-canvas-settings::backdrop{background:#16253f38;backdrop-filter:blur(3px)}
.dsh-canvas-settings header,.dsh-canvas-settings nav,.dsh-canvas-settings footer{flex-shrink:0}.dsh-canvas-settings header{display:flex;justify-content:space-between;align-items:flex-start;padding:22px 24px 16px}.dsh-canvas-settings h2{font-size:19px;margin:0;font-weight:650}.dsh-canvas-settings header p{font-size:12px;color:#778399;margin:5px 0 0}.dsh-canvas-settings button{font:inherit;cursor:pointer;border:0;background:transparent;color:inherit;border-radius:7px;padding:7px 12px}.dsh-canvas-settings [data-close][aria-label]{font-size:23px;padding:0 6px;color:#7c879b}.dsh-canvas-settings button:disabled{opacity:.5;cursor:default}.dsh-canvas-settings button:focus-visible,.dsh-canvas-settings summary:focus-visible{outline:2px solid #6e89e3;outline-offset:2px}
.dsh-canvas-settings nav{display:flex;gap:6px;padding:0 24px 12px;border-bottom:1px solid #edf0f5}.dsh-canvas-settings nav button[aria-pressed=true]{background:#edf2fc;color:#4763be;font-weight:600}.dsh-canvas-settings .settings-pages{min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:20px 24px;scrollbar-gutter:stable}.dsh-canvas-settings section[hidden]{display:none}
.settings-page-heading{margin:0 0 16px}.settings-page-heading h3{font-size:15px;margin:0 0 4px}.settings-page-heading p{font-size:12px;color:#778399;margin:0}.settings-group{border:0;border-radius:10px;margin:20px 0 0;background:transparent}.settings-group-heading{display:flex;align-items:center;gap:10px;margin:0;padding:0 0 8px;border-bottom:1px solid #e1e5ec}.settings-group-title{font-size:14px;font-weight:600}.settings-group-badge{margin-left:auto;font-size:11px;color:#7b879b}.settings-group-body{padding:8px 0 0}
.settings-row{display:flex;justify-content:space-between;align-items:center;gap:18px;min-height:43px}.settings-field-label{display:flex;align-items:center;gap:6px;min-width:0}.settings-field-label label{cursor:pointer}.settings-input-unit{position:relative;display:block;flex-shrink:0}.settings-input-unit>span{position:absolute;top:50%;right:9px;transform:translateY(-50%);min-width:0;color:#7b879a;font-size:11px;pointer-events:none}.dsh-canvas-settings input,.dsh-canvas-settings select{box-sizing:border-box;font:inherit;color:inherit;border:1px solid #dfe4ee;border-radius:7px;padding:5px 8px;background:inherit;max-width:205px}.dsh-canvas-settings input[type=number]{width:112px;padding-right:30px}.dsh-canvas-settings input[type=color]{padding:3px;width:38px;height:29px;cursor:pointer}.dsh-canvas-settings input[type=checkbox]{accent-color:#5674d9;width:16px;height:16px;cursor:pointer;flex-shrink:0}.dsh-canvas-settings .settings-info{display:inline-grid;place-items:center;flex:0 0 auto;width:24px;height:24px;padding:3px;border-radius:50%;color:#8b97aa;vertical-align:middle}.dsh-canvas-settings .settings-info:hover,.dsh-canvas-settings .settings-info[aria-expanded=true]{color:#4763be;background:#edf2fc}.dsh-canvas-settings .settings-help{font-size:12px;color:#7b879a;margin:8px 0 0;line-height:1.7}
.dsh-canvas-settings .settings-text-row{align-items:stretch;flex-direction:column;gap:7px;margin:10px 0}.dsh-canvas-settings textarea{box-sizing:border-box;width:100%;resize:vertical;min-height:88px;padding:10px 12px;border:1px solid #dfe4ee;border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;font:12px/1.7 ui-monospace,monospace}.dsh-canvas-settings fieldset{min-width:0;padding:0;margin:0;border:0}
.settings-action-pair{display:inline-flex;align-items:center;gap:1px}.dsh-canvas-settings .primary{background:#526fd0;color:white}.prompt-actions{display:flex;gap:8px;flex-wrap:wrap}
.dsh-canvas-settings footer{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-top:1px solid #edf0f5}.dsh-canvas-settings footer .primary{min-width:70px}
.settings-info-popover{box-sizing:border-box;position:fixed;z-index:5;width:min(380px,calc(100vw - 24px));max-height:calc(100dvh - 32px);overflow:auto;padding:16px 18px;border:1px solid #d8e1ee;border-radius:12px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#263247);box-shadow:0 10px 40px #152b4c24;font:12px/1.8 system-ui;pointer-events:auto}.settings-info-popover[hidden]{display:none}.settings-info-popover strong{display:block;font-size:13px}.settings-info-popover .settings-info-timing{font-size:11px;color:#526fb1;margin:5px 0 8px}.settings-info-popover p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:560px){.dsh-canvas-settings{width:calc(100vw - 20px);max-height:calc(100dvh - 20px)}.dsh-canvas-settings header{padding:16px}.dsh-canvas-settings nav{padding:0 16px 10px}.dsh-canvas-settings .settings-pages{padding:16px}.dsh-canvas-settings footer{padding:12px 16px}.settings-row{gap:8px}.settings-group-badge{font-size:10px}.dsh-canvas-settings select{max-width:156px}}

.dsh-canvas-settings footer[hidden]{display:none}.dsh-canvas-settings [data-agent-footer]{gap:16px}.dsh-canvas-settings [data-agent-footer]>p{margin:0;font-size:12px;color:#66748a;overflow-wrap:anywhere}.agent-footer-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}
.agent-common .settings-text-row{gap:10px}.agent-field-description{margin:3px 0 0;font-size:12px;line-height:1.6;color:#657188}.agent-common textarea{font-family:inherit;font-size:13px;line-height:1.7;min-height:90px}.agent-common textarea::placeholder{color:#707b8d}.agent-advanced{margin-top:18px;padding-top:14px;border-top:1px solid #e1e5ec}.agent-advanced>.settings-group-heading{border:0;padding-bottom:4px}.agent-advanced>.settings-group-body{padding:0}.agent-advanced .settings-group{margin-top:8px}.agent-timing-help{margin-top:20px;padding-top:14px;border-top:1px solid #e1e5ec;font-size:12px;color:#657188}.agent-timing-help dl{margin:0}.agent-timing-help dl>div{margin:8px 0}.agent-timing-help dt{font-weight:550;color:#3b4c65}.agent-timing-help dd{margin:2px 0 0}.agent-timing-help p{margin:12px 0}
@media(max-width:560px){.dsh-canvas-settings [data-agent-footer]{align-items:flex-start}.agent-footer-actions{gap:2px}.dsh-canvas-settings [data-agent-footer]>p{max-width:50%;font-size:11px}}

.dsh-canvas-settings{width:min(960px,calc(100vw - 32px));height:min(740px,calc(100dvh - 32px));border-radius:16px;background:#f6f7f9}
.dsh-canvas-settings header{padding:22px 24px 18px}.dsh-canvas-settings header p{display:none}
.settings-layout{display:flex;flex:1;min-height:0;overflow:hidden}
.dsh-canvas-settings .settings-layout>nav{box-sizing:border-box;display:flex;flex-direction:column;gap:6px;width:152px;flex:0 0 152px;padding:8px 12px 20px;border:0;overflow-y:auto}
.dsh-canvas-settings nav button{display:flex;align-items:center;gap:10px;padding:11px 14px;text-align:left;border-radius:9px;color:#505b6d}
.dsh-canvas-settings nav button:hover{background:#e9ecf1}.dsh-canvas-settings nav button[aria-pressed=true]{background:#e5e8ee;color:#263247;font-weight:600}
.dsh-canvas-settings nav svg{flex-shrink:0}
.dsh-canvas-settings .settings-pages{box-sizing:border-box;flex:1;min-width:0;padding:8px 24px 24px 12px}
.settings-page-heading{margin-bottom:16px}.settings-page-heading h3{font-size:17px;font-weight:600}.settings-page-heading p{color:#637087;line-height:1.7}
.dsh-canvas-settings .settings-group{border:0;border-radius:12px;background:#fff;margin:0 0 14px;padding:14px 18px}.dsh-canvas-settings .settings-group-heading{padding-bottom:8px;border-bottom:1px solid #edf0f5}.dsh-canvas-settings .settings-group-body{padding:8px 0 0}
.agent-common{padding:0;background:transparent;border-radius:0}.node-agent-group{margin-top:0;padding:0 16px 16px;border-radius:12px;background:#fff}.node-agent-group>.node-enable-row{margin:0;padding:14px 2px;border-bottom:1px solid #e1e5ec;border-radius:0;background:transparent}.node-agent-group>.agent-settings-content{padding-top:4px}.node-agent-group .node-choice-section{margin:12px 0;padding:0;border-radius:0;background:transparent}.node-agent-group .node-choice-options{max-width:620px}.node-agent-group .settings-group-heading{border:0}.node-agent-group .settings-group-body{padding:4px 0 0}
.node-agent-group>.agent-settings-content>.agent-advanced{margin:12px 0 0;padding:14px 0 0;border-top:1px solid #e1e5ec;border-radius:0;background:transparent}
.settings-prompts-page>.settings-group{margin:0 0 14px}.settings-prompts-page .settings-group-body{padding-top:12px}
.settings-prompts-page>[data-prompt-fields]>.prompt-injection-block{margin:0 0 14px;padding:14px 18px}
.settings-prompts-page>[data-prompt-fields]>.prompt-injection-block:first-child{margin-top:0}
.settings-prompts-page .prompt-backup-block{margin:0 0 14px;padding:14px 18px;border-radius:12px;background:#fff}
.settings-prompts-page .prompt-backup-block h4{padding-bottom:8px;border-bottom:1px solid #edf0f5;font-size:14px}
.settings-connections-page:has(> .settings-group input[name="connections.enabled"]:not(:checked))>.settings-group:not(:first-of-type){display:none}
.dsh-canvas-settings footer{padding:12px 24px;background:#fff;border-radius:0 0 16px 16px}.dsh-canvas-settings textarea{font-family:inherit}
.dsh-canvas-settings input[role=switch]{appearance:none;position:relative;flex:0 0 auto;width:36px;height:22px;padding:0;border:0;border-radius:12px;background:#c5cbd5;cursor:pointer}
.dsh-canvas-settings input[role=switch]::before{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:left .15s}
.dsh-canvas-settings input[role=switch]:checked{background:#526fd0}.dsh-canvas-settings input[role=switch]:checked::before{left:17px}
.dsh-canvas-settings input[role=switch]:focus-visible{outline:2px solid #6e89e3;outline-offset:3px}
@media(max-width:620px){.dsh-canvas-settings .settings-layout>nav{width:98px;flex-basis:98px;padding:6px}.dsh-canvas-settings nav button{gap:7px;padding:10px 8px}.dsh-canvas-settings .settings-pages{padding:6px 12px 16px 6px}.settings-group-body{padding:6px 12px 12px}.agent-common{padding:12px}.settings-row{gap:8px;flex-wrap:wrap}.settings-field-label{flex:1}.dsh-canvas-settings select{max-width:100%}.dsh-canvas-settings footer{padding:12px}.dsh-canvas-settings header{padding:16px}.settings-action-pair{flex-wrap:wrap}}
.node-enable-row{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:12px 0;padding:16px 18px;border-radius:12px;background:#fff}
.node-enable-copy>div{display:flex;align-items:center;gap:5px}.node-enable-copy strong{font-size:14px;font-weight:600}.node-enable-copy p{margin:4px 0 0;color:#637087;font-size:12px;line-height:1.6}
.dsh-canvas-settings .node-enable-row input[role=switch]{appearance:none;position:relative;flex:0 0 auto;width:36px;height:22px;padding:0;border:0;border-radius:12px;background:#c5cbd5;cursor:pointer}
.dsh-canvas-settings .node-enable-row input[role=switch]::before{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transition:left .15s}
.dsh-canvas-settings .node-enable-row input[role=switch]:checked{background:#526fd0}.dsh-canvas-settings .node-enable-row input[role=switch]:checked::before{left:17px}
.dsh-canvas-settings .node-enable-row input[role=switch]:focus-visible{outline:2px solid #6e89e3;outline-offset:3px}
.agent-settings-content{display:block}
.settings-agent-page:has(>.node-enable-row input:not(:checked))>.agent-settings-content{display:none}
.node-choice-section{margin:12px 0;padding:14px 18px;border-radius:12px;background:#fff}.node-choice-title{margin-bottom:10px;font-size:13px;font-weight:400}
.node-choice-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.node-choice{position:relative;display:block;min-width:0;cursor:pointer}
.line-type-options{display:flex;align-items:center;gap:6px;width:min(290px,55%)}.line-type-options .node-choice{flex:1}
.node-choice input{position:absolute;width:1px;height:1px;opacity:0}.node-choice span{display:flex;align-items:center;justify-content:center;min-height:36px;padding:5px 6px;border:1px solid #d9dfe8;border-radius:7px;background:#fff;text-align:center;font-size:12px;line-height:1.35;overflow-wrap:anywhere}
.node-choice input:checked+span{border-color:#9db1e4;background:#eaf0fc;color:#3555a2;font-weight:600}.node-choice input:focus-visible+span{outline:2px solid #6e89e3;outline-offset:2px}
.node-choice-section .agent-field-description{margin-top:8px}
@media(max-width:620px){.node-choice-section{padding:12px}.node-choice-options{gap:5px}.node-choice span{font-size:11px;padding:4px 3px}}

.prompt-injection-block{margin:12px 0;padding:12px 18px 16px;border-radius:12px;background:#fff}
.prompt-injection-block>.settings-row .settings-field-label label{font-size:14px;font-weight:600}
.prompt-injection-block:not(:has(> .settings-row input:checked))>.prompt-injection-editor{display:none}
.prompt-injection-editor{margin-top:8px}.prompt-injection-block textarea{font-family:inherit;font-size:13px;line-height:1.7}
.prompt-backup-block h4,.prompt-timing h4{font-size:13px;font-weight:600;margin:0 0 10px}.prompt-timing{padding-top:16px;margin-top:24px}

.dsh-canvas-settings .prompt-actions{gap:10px 14px}
.dsh-canvas-settings .prompt-actions .settings-action-pair{gap:4px}
.dsh-canvas-settings .prompt-actions button:not(.settings-info){border:1px solid #cdd5e1;background:#fff;border-radius:7px;padding:7px 12px;min-height:34px;font-weight:500;box-shadow:0 1px 2px #172b4d08}
.dsh-canvas-settings .prompt-actions button:not(.settings-info):hover:not(:disabled){background:#edf2fa;border-color:#9eafcb;color:#304d90}
.dsh-canvas-settings .prompt-actions button:not(.settings-info):active:not(:disabled){background:#e1e8f4;box-shadow:inset 0 1px 2px #172b4d14}
@media(prefers-reduced-motion:reduce){.settings-chevron{transition:none}}
`

export function attachSettingsHelp(modal) {
  const bubble = document.createElement('div')
  bubble.className = 'settings-info-popover'
  bubble.id = 'dsh-setting-help'
  bubble.setAttribute('role', 'tooltip')
  bubble.hidden = true
  modal.append(bubble)
  let active, pinned = false, timer
  const buttons = [...modal.querySelectorAll('[data-setting-help]')]
  function hide() {
    clearTimeout(timer)
    active?.setAttribute('aria-expanded', 'false')
    active?.removeAttribute('aria-describedby')
    active = undefined
    pinned = false
    bubble.hidden = true
  }
  function position() {
    if (!active || bubble.hidden) return
    const anchor = active.getBoundingClientRect(), rect = bubble.getBoundingClientRect()
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight
    const left = Math.max(12, Math.min(width - rect.width - 12, anchor.left - 12))
    const below = anchor.bottom + 8
    const top = below + rect.height <= height - 12 ? below : Math.max(12, anchor.top - rect.height - 8)
    bubble.style.left = `${left}px`; bubble.style.top = `${top}px`
  }
  function show(button, pin = false) {
    clearTimeout(timer)
    if (active !== button) {
      hide()
      active = button
      const entry = HELP[button.dataset.settingHelp]
      if (!entry) return hide()
      const title = document.createElement('strong'), timing = document.createElement('p'), body = document.createElement('p')
      title.textContent = entry[0]; timing.textContent = entry[1]; body.textContent = entry[2]
      timing.className = 'settings-info-timing'
      bubble.replaceChildren(title, timing, body)
      bubble.hidden = false
      button.setAttribute('aria-expanded', 'true')
      button.setAttribute('aria-describedby', bubble.id)
    }
    pinned = pin || pinned
    position()
  }
  const laterHide = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { if (!pinned && document.activeElement !== active && !bubble.matches(':hover')) hide() }, 150)
  }
  const onEnter = event => { if (!pinned || active === event.currentTarget) show(event.currentTarget) }
  const onFocus = event => show(event.currentTarget)
  const onBlur = () => { pinned = false; laterHide() }
  const onClick = event => {
    event.preventDefault(); event.stopPropagation()
    const button = event.currentTarget
    if (active === button && pinned) hide()
    else show(button, true)
  }
  for (const button of buttons) {
    button.addEventListener('pointerenter', onEnter)
    button.addEventListener('pointerleave', laterHide)
    button.addEventListener('focus', onFocus)
    button.addEventListener('blur', onBlur)
    button.addEventListener('click', onClick)
  }
  const onOutside = event => { if (!bubble.contains(event.target) && !event.target.closest?.('[data-setting-help]')) hide() }
  const onKey = event => {
    if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); hide() }
  }
  const onScroll = event => {
    if (bubble.contains(event.target)) return
    if (active && document.activeElement === active) position()
    else hide()
  }
  bubble.addEventListener('pointerenter', () => clearTimeout(timer))
  bubble.addEventListener('pointerleave', laterHide)
  modal.addEventListener('pointerdown', onOutside, true)
  modal.addEventListener('keydown', onKey, true)
  modal.addEventListener('scroll', onScroll, true)
  modal.addEventListener('close', hide)
  window.addEventListener('resize', hide)
  return () => {
    hide()
    for (const button of buttons) {
      button.removeEventListener('pointerenter', onEnter); button.removeEventListener('pointerleave', laterHide)
      button.removeEventListener('focus', onFocus); button.removeEventListener('blur', onBlur); button.removeEventListener('click', onClick)
    }
    modal.removeEventListener('pointerdown', onOutside, true); modal.removeEventListener('keydown', onKey, true)
    modal.removeEventListener('scroll', onScroll, true); modal.removeEventListener('close', hide)
    window.removeEventListener('resize', hide); bubble.remove()
  }
}
