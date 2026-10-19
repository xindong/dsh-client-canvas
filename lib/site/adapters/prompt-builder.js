// Read the committed host settings for every preparation. An unsaved settings
// draft never changes a request, and other browser windows take effect too.
export async function fetchPromptSettings(signal) {
  const response = await fetch('/xindong-canvas/prompt-settings', { credentials: 'same-origin', cache: 'no-store', signal })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error?.message || '无法读取已保存的提示词配置，请稍后重试。')
  if (!payload.settings || typeof payload.defaults?.nodeTemplate !== 'string' || typeof payload.defaults.nodeGuidance !== 'string') throw new Error('提示词配置格式无效。')
  // Node message structure is maintained by the plugin, including for old saved configurations.
  return { ...payload.settings, nodeTemplate: payload.defaults.nodeTemplate, nodeGuidance: payload.defaults.nodeGuidance }
}

export function renderNodePrompt({ instruction, context, resources }, settings) {
  const projectNode = node => {
    const result = { id: node.id, type: node.type, name: node.name }
    if (settings.includeGeometry) {
      for (const field of ['x', 'y', 'width', 'height', 'rotation', 'zIndex', 'locked', 'visible']) result[field] = node[field]
    }
    if (settings.includeNodeContent) result.props = node.props
    if (settings.includeAssets) result.assetRefs = node.assetRefs
    return result
  }
  const data = {
    board_id: context.boardId, node_id: context.node.id, node_ids: context.nodeIds,
    revision: context.revision, nodes: context.nodes.map(projectNode),
    ...(settings.includeAssets ? { assets: context.assets, resources } : {}),
    ...(settings.includeConnections ? { connections: context.connections } : {}),
    truncated: context.truncated,
  }
  const variables = { instruction: instruction.trim(), guidance: settings.nodeGuidance, context: JSON.stringify(data, null, 2) }
  // A single replacement pass leaves any {{...}} inside instructions or data
  // untouched. Templates are text, never executable JavaScript.
  const message = settings.nodeTemplate.replace(/\{\{([^{}]*)\}\}/g, (_, raw) => {
    const key = raw.trim()
    if (!Object.hasOwn(variables, key)) throw new Error(`不支持的提示词变量：${raw}`)
    return variables[key]
  })
  const preferences = settings.nodePreferences?.trim()
  return preferences ? `${message}\n\n[用户的处理偏好]\n${preferences}` : message
}
