import { parse as parseYaml } from 'yaml'

const formatDisplayTime = (value) => {
  if (!value) return '--'

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

const normalizeApiUrl = (value = '') => {
  if (!value) return ''

  try {
    const target = new URL(value)
    target.pathname = target.pathname.replace(/\/$/, '') || '/'
    return target.toString().replace(/\/$/, '')
  } catch {
    return value.replace(/\/$/, '')
  }
}

export const buildChatApiCandidates = (host = '') => {
  if (!host) return []

  const variants = [`https://${host}/v1`]

  return [...new Set(variants.map(normalizeApiUrl).filter(Boolean))]
}

export const buildCherryStudioChatApiUrl = (value = '') => {
  const normalized = normalizeApiUrl(value)
  if (!normalized) return ''

  try {
    const target = new URL(normalized)
    target.pathname = target.pathname.replace(/\/$/, '') || '/'

    if (target.pathname === '/v1') {
      return target.toString().replace(/\/$/, '')
    }

    if (target.pathname.endsWith('/v1/chat/completions')) {
      target.pathname = '/v1'
      return target.toString().replace(/\/$/, '')
    }

    return target.toString().replace(/\/$/, '')
  } catch {
    return normalized
  }
}

export const buildChatApiUrl = (host = '') => buildChatApiCandidates(host)[0] || ''

const toKubeconfigScalar = (value) => {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^['"]|['"]$/g, '')
}

const parseKubeconfigStruct = (kubeconfig = '') => {
  if (!kubeconfig) return {}

  try {
    const parsed = parseYaml(kubeconfig) || {}
    const contexts = Array.isArray(parsed.contexts) ? parsed.contexts : []
    const users = Array.isArray(parsed.users) ? parsed.users : []
    const clusters = Array.isArray(parsed.clusters) ? parsed.clusters : []

    const currentContextName = parsed['current-context']
    const selectedContext = contexts.find((item) => item?.name === currentContextName) || contexts[0]

    const namespace = toKubeconfigScalar(selectedContext?.context?.namespace)
    const userName = selectedContext?.context?.user
    const clusterName = selectedContext?.context?.cluster

    const selectedUser = users.find((item) => item?.name === userName) || users[0]
    const selectedCluster = clusters.find((item) => item?.name === clusterName) || clusters[0]

    return {
      namespace,
      token: toKubeconfigScalar(selectedUser?.user?.token),
      server: toKubeconfigScalar(selectedCluster?.cluster?.server),
    }
  } catch (error) {
    console.warn('[k8s-api] parse kubeconfig with yaml failed, fallback to line parser', {
      message: error?.message,
    })
    return {}
  }
}

const parseKubeconfigValue = (kubeconfig = '', key) => {
  if (!kubeconfig || !key) return ''

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = kubeconfig.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(new RegExp(`^(\\s*)${escapedKey}:\\s*(.*)$`))
    if (!match) continue

    const baseIndent = match[1].length
    const rawValue = (match[2] || '').trim()

    if (rawValue && !['>-', '>', '|-', '|'].includes(rawValue)) {
      return rawValue.replace(/^['"]|['"]$/g, '')
    }

    const blockLines = []
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextLine = lines[next]
      if (!nextLine.trim()) continue

      const nextIndent = nextLine.match(/^\s*/)?.[0]?.length || 0
      if (nextIndent <= baseIndent) {
        break
      }

      blockLines.push(nextLine.trim())
    }

    if (blockLines.length) {
      return blockLines.join('')
    }

    return ''
  }

  return ''
}

const getNow = () => {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, options)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = new Error(text || `请求失败: ${response.status}`)
    error.status = response.status
    error.payload = text
    throw error
  }

  if (response.status === 204) {
    return null
  }

  return response.json()
}

const createApiError = async (response) => {
  const text = await response.text().catch(() => '')
  const error = new Error(text || `请求失败: ${response.status}`)
  error.status = response.status
  error.payload = text
  return error
}

const requestMaybeConflict = async (url, options = {}) => {
  const response = await fetch(url, options)

  if (response.status === 409) {
    return { conflict: true, data: null }
  }

  if (!response.ok) {
    throw await createApiError(response)
  }

  if (response.status === 204) {
    return { conflict: false, data: null }
  }

  return {
    conflict: false,
    data: await response.json(),
  }
}

export const createClusterContext = (session) => {
  const kubeconfig = session?.kubeconfig || ''
  const parsedKubeconfig = parseKubeconfigStruct(kubeconfig)
  const server = parsedKubeconfig.server || parseKubeconfigValue(kubeconfig, 'server')
  const namespace = parsedKubeconfig.namespace || parseKubeconfigValue(kubeconfig, 'namespace')
  const token = parsedKubeconfig.token || parseKubeconfigValue(kubeconfig, 'token')
  const sessionToken = session?.token || ''
  const operator = session?.user?.id || session?.user?.name || ''
  const agentLabel = operator

  if (!server) {
    throw new Error('未从 kubeconfig 中解析到 API Server 地址')
  }

  if (!namespace) {
    throw new Error('未从 sdk session 中解析到 namespace')
  }

  if (!token && !sessionToken) {
    throw new Error('未从 sdk session / kubeconfig 中解析到可用 token')
  }

  if (!agentLabel) {
    throw new Error('未从 sdk session 中解析到 user.id，无法生成 agent.sealos.io/name label')
  }

  return {
    server,
    namespace,
    token,
    sessionToken,
    operator,
    agentLabel,
    kubeconfig,
  }
}

const buildHeaders = (clusterContext, tokenOverride = '') => {
  const authToken = tokenOverride || clusterContext.token || clusterContext.sessionToken || ''
  const headers = {
    Authorization: `Bearer ${authToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  if (clusterContext.server) {
    headers['X-K8s-Server'] = clusterContext.server
  }

  return headers
}

const getAuthTokenCandidates = (clusterContext) => {
  const entries = [
    { source: 'kubeconfig', token: clusterContext.token },
    { source: 'session', token: clusterContext.sessionToken },
  ].filter((entry) => Boolean(entry.token))

  const seen = new Set()
  return entries.filter((entry) => {
    if (seen.has(entry.token)) return false
    seen.add(entry.token)
    return true
  })
}

const isUnauthorizedError = (error) => error?.status === 401

const requestJsonWithAuthRetry = async (url, clusterContext, options = {}) => {
  const tokenCandidates = getAuthTokenCandidates(clusterContext)
  let lastError = null

  for (const candidate of tokenCandidates) {
    try {
      return await requestJson(url, {
        ...options,
        headers: buildHeaders(clusterContext, candidate.token),
      })
    } catch (error) {
      lastError = error
      if (!isUnauthorizedError(error)) {
        throw error
      }
      console.warn(`[k8s-api] ${candidate.source} token unauthorized, retry next candidate`, {
        status: error.status,
        url,
      })
    }
  }

  throw lastError || new Error('请求失败: 未找到可用认证 token')
}

const requestMaybeConflictWithAuthRetry = async (url, clusterContext, options = {}) => {
  const tokenCandidates = getAuthTokenCandidates(clusterContext)
  let lastError = null

  for (const candidate of tokenCandidates) {
    try {
      return await requestMaybeConflict(url, {
        ...options,
        headers: buildHeaders(clusterContext, candidate.token),
      })
    } catch (error) {
      lastError = error
      if (!isUnauthorizedError(error)) {
        throw error
      }
      console.warn(`[k8s-api] ${candidate.source} token unauthorized, retry next candidate`, {
        status: error.status,
        url,
      })
    }
  }

  throw lastError || new Error('请求失败: 未找到可用认证 token')
}

const buildProxyUrl = (path, searchParams) => {
  const query = searchParams?.toString()
  return `/k8s-api${path}${query ? `?${query}` : ''}`
}

export const findExecPodForApp = async (appName, clusterContext) => {
  if (!appName) {
    throw new Error('缺少应用名，无法查找 Pod')
  }

  const searchParams = new URLSearchParams({
    labelSelector: withLabelSelector(clusterContext, { app: appName }),
  })

  const data = await requestJsonWithAuthRetry(buildProxyUrl(`/api/v1/namespaces/${clusterContext.namespace}/pods`, searchParams), clusterContext, {
    method: 'GET',
  })

  const pods = data?.items || []
  if (!pods.length) {
    throw new Error(`未找到应用 ${appName} 对应的 Pod`)
  }

  const sortedPods = [...pods].sort((a, b) => {
    const phaseOrder = { Running: 0, Pending: 1 }
    const phaseA = phaseOrder[a?.status?.phase] ?? 99
    const phaseB = phaseOrder[b?.status?.phase] ?? 99
    if (phaseA !== phaseB) return phaseA - phaseB

    const timeA = new Date(a?.metadata?.creationTimestamp || 0).getTime()
    const timeB = new Date(b?.metadata?.creationTimestamp || 0).getTime()
    return timeB - timeA
  })

  const selected = sortedPods[0]
  const podName = selected?.metadata?.name
  const containerName = selected?.spec?.containers?.[0]?.name || ''

  if (!podName) {
    throw new Error(`应用 ${appName} 的 Pod 名称为空`)
  }

  return {
    podName,
    containerName,
    namespace: clusterContext.namespace,
    status: selected?.status?.phase || '--',
  }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

const resolveBrowserOrigin = (clusterServer = '') => {
  if (typeof window === 'undefined') {
    return 'http://localhost'
  }

  const currentUrl = new URL(window.location.href)
  const currentHost = currentUrl.hostname
  const isLocalHost = LOCAL_HOSTS.has(currentHost)

  if (!isLocalHost) {
    return currentUrl.origin
  }

  const candidates = []

  if (document.referrer) {
    candidates.push(document.referrer)
  }

  const ancestorOrigin = window.location.ancestorOrigins?.[0]
  if (ancestorOrigin) {
    candidates.push(ancestorOrigin)
  }

  if (clusterServer) {
    try {
      const clusterUrl = new URL(clusterServer)
      // K8s API 常见是 6443，不适合作为前端 ingress 端口，保留域名改成 https 默认端口
      candidates.push(`https://${clusterUrl.hostname}`)
    } catch {
      // ignore
    }
  }

  for (const value of candidates) {
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' && !LOCAL_HOSTS.has(url.hostname)) {
        return url.origin
      }
    } catch {
      // ignore invalid candidate
    }
  }

  return currentUrl.origin
}

export const buildPodExecWsCandidates = ({
  namespace,
  podName,
  containerName,
  token,
  clusterServer = '',
  commands = ['sh', '-lc', 'hermes'],
  localProxyOnly = false,
}) => {
  const params = new URLSearchParams()

  commands.forEach((command) => params.append('command', command))

  if (containerName) {
    params.set('container', containerName)
  }

  params.set('stdin', '1')
  params.set('stdout', '1')
  params.set('stderr', '1')
  params.set('tty', '1')

  if (token) {
    params.set('k8sToken', token)
  }

  const query = params.toString()
  const list = []

  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : ''
  const browserOrigin = localProxyOnly && currentOrigin ? currentOrigin : resolveBrowserOrigin(clusterServer)
  const browserBase = new URL(browserOrigin)
  browserBase.protocol = browserBase.protocol === 'https:' ? 'wss:' : 'ws:'

  list.push(
    `${browserBase.toString().replace(/\/$/, '')}/k8s-api/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/exec?${query}`,
  )

  if (localProxyOnly) {
    return [...new Set(list)]
  }

  list.push(
    `${browserBase.toString().replace(/\/$/, '')}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/exec?${query}`,
  )

  if (clusterServer) {
    try {
      const clusterUrl = new URL(clusterServer)
      clusterUrl.protocol = clusterUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      list.push(
        `${clusterUrl.toString().replace(/\/$/, '')}/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(podName)}/exec?${query}`,
      )
    } catch {
      // ignore invalid cluster server
    }
  }

  return [...new Set(list)]
}

export const buildPodExecWsUrl = (options) => buildPodExecWsCandidates(options)[0] || ''

const buildAgentLabels = (clusterContext, extraLabels = {}) => ({
  ...extraLabels,
  'agent.sealos.io/name': clusterContext.agentLabel,
})

const buildAppLabels = (clusterContext, appName, extraLabels = {}) => ({
  ...extraLabels,
  app: appName,
  'agent.sealos.io/name': clusterContext.agentLabel,
})

const withLabelSelector = (clusterContext, extraLabels = {}) => {
  const labels = buildAgentLabels(clusterContext, extraLabels)
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(',')
}

const mapDevboxItem = (item, operator) => {
  const metadata = item?.metadata || {}
  const spec = item?.spec || {}
  const config = spec?.config || {}
  const appPort = config?.appPorts?.[0] || spec?.network?.extraPorts?.[0] || {}

  return {
    id: metadata.uid || metadata.name,
    name: metadata.name || '--',
    owner: operator || '--',
    port: appPort.port || appPort.targetPort || appPort.containerPort || '--',
    status: spec?.state || item?.status?.phase || '--',
    updatedAt: formatDisplayTime(metadata.creationTimestamp || metadata.managedFields?.[0]?.time),
    desc: `DevBox / ${metadata.namespace || '--'}`,
    apiKey: config?.env?.find((env) => env.name === 'API_SERVER_KEY')?.value || '',
    apiUrl: '',
    yaml: item,
  }
}

const mapServiceItem = (item, operator) => {
  const metadata = item?.metadata || {}
  const spec = item?.spec || {}
  const port = spec?.ports?.[0] || {}

  return {
    id: metadata.uid || metadata.name,
    name: metadata.name || '--',
    owner: operator || '--',
    port: port.port || port.targetPort || '--',
    status: spec?.type || '--',
    updatedAt: formatDisplayTime(metadata.creationTimestamp || metadata.managedFields?.[0]?.time),
    desc: `Service / ${metadata.namespace || '--'}`,
    apiKey: '',
    apiUrl: '',
    yaml: item,
  }
}

const mapIngressItem = (item, operator) => {
  const metadata = item?.metadata || {}
  const rule = item?.spec?.rules?.[0] || {}
  const backendPort = rule?.http?.paths?.[0]?.backend?.service?.port?.number || '--'

  return {
    id: metadata.uid || metadata.name,
    name: metadata.name || '--',
    owner: operator || '--',
    port: backendPort,
    status: item?.status?.loadBalancer?.ingress?.length ? 'Active' : 'Pending',
    updatedAt: formatDisplayTime(metadata.creationTimestamp || metadata.managedFields?.[0]?.time),
    desc: rule.host || `Ingress / ${metadata.namespace || '--'}`,
    apiKey: '',
    apiUrl: buildChatApiUrl(rule.host),
    yaml: item,
  }
}

const resourceConfig = {
  devbox: {
    listPath: (namespace) => `/apis/devbox.sealos.io/v1alpha2/namespaces/${namespace}/devboxes`,
    detailPath: (namespace, name) => `/apis/devbox.sealos.io/v1alpha2/namespaces/${namespace}/devboxes/${name}`,
    mapper: mapDevboxItem,
  },
  service: {
    listPath: (namespace) => `/api/v1/namespaces/${namespace}/services`,
    detailPath: (namespace, name) => `/api/v1/namespaces/${namespace}/services/${name}`,
    mapper: mapServiceItem,
  },
  ingress: {
    listPath: (namespace) => `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses`,
    detailPath: (namespace, name) => `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses/${name}`,
    mapper: mapIngressItem,
  },
}

export const getClusterInfo = async (clusterContext) => ({
  cluster: clusterContext.server,
  namespace: clusterContext.namespace,
  kc: clusterContext.kubeconfig,
  server: clusterContext.server,
  operator: clusterContext.operator,
  updatedAt: getNow(),
})

export const listResources = async (type, clusterContext) => {
  const config = resourceConfig[type]
  if (!config) throw new Error(`不支持的资源类型: ${type}`)

  const searchParams = new URLSearchParams({
    labelSelector: withLabelSelector(clusterContext),
  })

  const data = await requestJsonWithAuthRetry(buildProxyUrl(config.listPath(clusterContext.namespace), searchParams), clusterContext, {
    method: 'GET',
  })

  return (data?.items || []).map((item) => config.mapper(item, clusterContext.operator))
}

export const createResource = async (type, payload, clusterContext) => {
  const config = resourceConfig[type]
  if (!config) throw new Error(`不支持的资源类型: ${type}`)

  const nextYaml = {
    ...payload.yaml,
    metadata: {
      ...(payload.yaml?.metadata || {}),
      labels: buildAgentLabels(clusterContext, payload.yaml?.metadata?.labels || {}),
    },
  }

  if (type === 'devbox') {
    nextYaml.spec = {
      ...(nextYaml.spec || {}),
      labels: buildAppLabels(clusterContext, nextYaml.metadata?.name, nextYaml.spec?.labels || {}),
      config: {
        ...(nextYaml.spec?.config || {}),
        labels: buildAppLabels(clusterContext, nextYaml.metadata?.name, nextYaml.spec?.config?.labels || {}),
      },
    }
  }

  if (type === 'service') {
    nextYaml.spec = {
      ...(nextYaml.spec || {}),
      selector: buildAppLabels(clusterContext, nextYaml.metadata?.name, nextYaml.spec?.selector || {}),
    }
  }

  const { conflict, data } = await requestMaybeConflictWithAuthRetry(
    buildProxyUrl(config.listPath(clusterContext.namespace)),
    clusterContext,
    {
      method: 'POST',
      body: JSON.stringify(nextYaml),
    },
  )

  if (conflict) {
    const current = await requestJsonWithAuthRetry(
      buildProxyUrl(config.detailPath(clusterContext.namespace, nextYaml.metadata.name)),
      clusterContext,
      {
        method: 'GET',
      },
    )
    return config.mapper(current, clusterContext.operator)
  }

  return config.mapper(data, clusterContext.operator)
}

export const updateResource = async (type, name, payload, clusterContext) => {
  const config = resourceConfig[type]
  if (!config) throw new Error(`不支持的资源类型: ${type}`)

  const nextYaml = {
    ...payload.yaml,
    metadata: {
      ...(payload.yaml?.metadata || {}),
      labels: buildAgentLabels(clusterContext, payload.yaml?.metadata?.labels || {}),
    },
  }

  if (type === 'devbox') {
    nextYaml.spec = {
      ...(nextYaml.spec || {}),
      labels: buildAppLabels(clusterContext, nextYaml.metadata?.name, nextYaml.spec?.labels || {}),
      config: {
        ...(nextYaml.spec?.config || {}),
        labels: buildAppLabels(clusterContext, nextYaml.metadata?.name, nextYaml.spec?.config?.labels || {}),
      },
    }
  }

  if (type === 'service') {
    nextYaml.spec = {
      ...(nextYaml.spec || {}),
      selector: buildAppLabels(clusterContext, nextYaml.metadata?.name, nextYaml.spec?.selector || {}),
    }
  }

  const data = await requestJsonWithAuthRetry(buildProxyUrl(config.detailPath(clusterContext.namespace, name)), clusterContext, {
    method: 'PUT',
    body: JSON.stringify(nextYaml),
  })

  return config.mapper(data, clusterContext.operator)
}

export const deleteResource = async (type, name, clusterContext) => {
  const config = resourceConfig[type]
  if (!config) throw new Error(`不支持的资源类型: ${type}`)

  await requestJsonWithAuthRetry(buildProxyUrl(config.detailPath(clusterContext.namespace, name)), clusterContext, {
    method: 'DELETE',
  })

  return true
}

const randomFromCharset = (length, charset) =>
  Array.from({ length }, () => charset[Math.floor(Math.random() * charset.length)]).join('')

const lowerAlnum = 'abcdefghijklmnopqrstuvwxyz0123456789'
const lowerAlpha = 'abcdefghijklmnopqrstuvwxyz'
const tokenCharset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const createAppName = () => randomFromCharset(8, lowerAlnum)
const createDomainPrefix = () => randomFromCharset(12, lowerAlpha)
const createApiKey = () => randomFromCharset(64, tokenCharset)

export const getCreateBlueprint = (clusterContext, hostConfig) => {
  const appName = createAppName()
  const domainPrefix = createDomainPrefix()
  const apiKey = createApiKey()
  const regionDomain =
    sessionStorage.getItem('hermes-region-domain') ||
    hostConfig?.cloud?.domain ||
    hostConfig?.domain ||
    'usw-1.sealos.app'

  return {
    appName,
    namespace: clusterContext.namespace,
    apiKey,
    domainPrefix,
    fullDomain: `${domainPrefix}.${regionDomain}`,
    image: 'nousresearch/hermes-agent:latest',
    state: 'Running',
    runtimeClassName: 'devbox-runtime',
    storageLimit: '10Gi',
    port: 8642,
    cpu: '2000m',
    memory: '4096Mi',
    serviceType: 'ClusterIP',
    protocol: 'TCP',
    user: clusterContext.operator || 'admin',
    workingDir: '/home/admin',
    args: ['gateway', 'run'],
  }
}
