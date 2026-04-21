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

const encodeHeaderValue = (value = '') => {
  if (!value) return ''

  try {
    return encodeURIComponent(value)
  } catch {
    return ''
  }
}

const dedupeAuthCandidates = (entries = []) => {
  const seen = new Set()

  return entries.filter((entry) => {
    const token = toKubeconfigScalar(entry?.token)
    if (!token || seen.has(token)) return false
    seen.add(token)
    entry.token = token
    return true
  })
}

const extractExecEnvTokenCandidates = (envList = []) =>
  dedupeAuthCandidates(
    (Array.isArray(envList) ? envList : [])
      .filter((entry) => /token/i.test(entry?.name || ''))
      .map((entry) => ({
        source: `kubeconfig exec env ${entry?.name || 'token'}`,
        token: entry?.value,
      })),
  )

const extractKubeconfigAuthCandidates = (userConfig = {}) => {
  const authProviderConfig = userConfig?.['auth-provider']?.config || userConfig?.authProvider?.config || {}

  return dedupeAuthCandidates([
    { source: 'kubeconfig token', token: userConfig?.token },
    { source: 'kubeconfig id-token', token: userConfig?.['id-token'] },
    { source: 'kubeconfig access-token', token: userConfig?.['access-token'] },
    {
      source: 'kubeconfig auth-provider id-token',
      token: authProviderConfig?.['id-token'] || authProviderConfig?.idToken,
    },
    {
      source: 'kubeconfig auth-provider access-token',
      token: authProviderConfig?.['access-token'] || authProviderConfig?.accessToken,
    },
    ...extractExecEnvTokenCandidates(userConfig?.exec?.env),
  ])
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
    const authCandidates = extractKubeconfigAuthCandidates(selectedUser?.user || {})

    return {
      namespace,
      token: authCandidates[0]?.token || '',
      authCandidates,
      server: toKubeconfigScalar(selectedCluster?.cluster?.server),
    }
  } catch (error) {
    console.warn('[k8s-api] parse kubeconfig with yaml failed, fallback to line parser', {
      message: error?.message,
    })
    return {}
  }
}

const parseKubeconfigValues = (kubeconfig = '', key) => {
  if (!kubeconfig || !key) return []

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const lines = kubeconfig.split('\n')
  const values = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line.match(new RegExp(`^(\\s*)${escapedKey}:\\s*(.*)$`))
    if (!match) continue

    const baseIndent = match[1].length
    const rawValue = (match[2] || '').trim()

    if (rawValue && !['>-', '>', '|-', '|'].includes(rawValue)) {
      values.push(rawValue.replace(/^['"]|['"]$/g, ''))
      continue
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
      values.push(blockLines.join(''))
      continue
    }
  }

  return values
}

const parseKubeconfigValue = (kubeconfig = '', key) => parseKubeconfigValues(kubeconfig, key)[0] || ''

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
  let payload = text
  let message = text || `请求失败: ${response.status}`

  if (text) {
    try {
      payload = JSON.parse(text)
      message = payload?.message || message
    } catch {
      payload = text
    }
  }

  const error = new Error(message)
  error.status = response.status
  error.payload = payload
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

const requestRawWithAuthRetry = async (url, clusterContext, options = {}) => {
  try {
    const response = await fetch(url, buildAuthorizedRequestOptions(clusterContext, options))
    if (!response.ok) {
      throw await createApiError(response)
    }
    return response
  } catch (error) {
    if (isUnauthorizedError(error)) {
      error.message = '请求失败: kubeconfig 认证无效或当前环境未按 Sealos 应用方式代理 Kubernetes 请求'
    }
    throw error
  }
}

const fileToBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const marker = 'base64,'
      const index = result.indexOf(marker)
      resolve(index >= 0 ? result.slice(index + marker.length) : '')
    }
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })

const bytesToBase64 = (bytes = new Uint8Array()) => {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

const textToBase64 = (value = '') => bytesToBase64(new TextEncoder().encode(String(value || '')))

const base64ToText = (value = '') => {
  if (!value) return ''
  const binary = atob(value)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const parseContentDispositionFilename = (value = '') => {
  if (!value) return ''

  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1])
    } catch {
      return utf8Match[1]
    }
  }

  const asciiMatch = value.match(/filename="?([^";]+)"?/i)
  return asciiMatch?.[1] || ''
}

export const createClusterContext = (session) => {
  const kubeconfig = session?.kubeconfig || ''
  const parsedKubeconfig = parseKubeconfigStruct(kubeconfig)
  const server = parsedKubeconfig.server || parseKubeconfigValue(kubeconfig, 'server')
  const namespace = parsedKubeconfig.namespace || parseKubeconfigValue(kubeconfig, 'namespace')
  const sessionToken = toKubeconfigScalar(session?.token)
  const authCandidates = dedupeAuthCandidates([
    ...(parsedKubeconfig.authCandidates || []),
    ...parseKubeconfigValues(kubeconfig, 'token').map((token) => ({
      source: 'kubeconfig token (line fallback)',
      token,
    })),
    ...parseKubeconfigValues(kubeconfig, 'id-token').map((token) => ({
      source: 'kubeconfig id-token (line fallback)',
      token,
    })),
    ...parseKubeconfigValues(kubeconfig, 'access-token').map((token) => ({
      source: 'kubeconfig access-token (line fallback)',
      token,
    })),
    { source: 'session token', token: sessionToken },
  ])
  const token = parsedKubeconfig.token || authCandidates[0]?.token || ''
  const operator = session?.user?.id || session?.user?.name || ''
  const agentLabel = operator

  if (!server) {
    throw new Error('未从 kubeconfig 中解析到 API Server 地址')
  }

  if (!namespace) {
    throw new Error('未从 sdk session 中解析到 namespace')
  }

  if (!authCandidates.length) {
    throw new Error('未从 sdk session / kubeconfig 中解析到可用 token')
  }

  if (!agentLabel) {
    throw new Error('未从 sdk session 中解析到 user.id，无法生成 agent.sealos.io/name label')
  }

  console.info('[k8s-api] cluster context parsed', {
    namespace,
    server,
    tokenFromKubeconfig: maskTokenForLog(token),
    tokenFromSession: maskTokenForLog(sessionToken),
    authSources: authCandidates.map((candidate) => candidate.source),
  })

  return {
    server,
    namespace,
    token,
    sessionToken,
    authCandidates,
    activeAuthToken: '',
    activeAuthSource: '',
    operator,
    agentLabel,
    kubeconfig,
  }
}

export const getPreferredAuthToken = (clusterContext) =>
  toKubeconfigScalar(
    clusterContext?.activeAuthToken ||
      clusterContext?.authCandidates?.[0]?.token ||
      clusterContext?.token ||
      clusterContext?.sessionToken,
  )

const buildHeaders = (clusterContext) => {
  const encodedKubeconfig = encodeHeaderValue(clusterContext?.kubeconfig || '')
  const encodedDesktopToken = encodeHeaderValue(clusterContext?.sessionToken || '')
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  if (encodedKubeconfig) {
    headers.Authorization = encodedKubeconfig
  }

  if (encodedDesktopToken) {
    headers['Authorization-Bearer'] = encodedDesktopToken
  }

  return headers
}

function maskTokenForLog(token = '') {
  if (!token || typeof token !== 'string') {
    return {
      length: 0,
      head: '',
      tail: '',
    }
  }

  return {
    length: token.length,
    head: token.slice(0, 10),
    tail: token.slice(-10),
  }
}

const isUnauthorizedError = (error) => error?.status === 401

const buildAuthorizedRequestOptions = (clusterContext, options = {}) => ({
  ...options,
  headers: {
    ...(options.headers || {}),
    ...buildHeaders(clusterContext),
  },
})

const requestJsonWithAuthRetry = async (url, clusterContext, options = {}) => {
  try {
    return await requestJson(url, buildAuthorizedRequestOptions(clusterContext, options))
  } catch (error) {
    if (isUnauthorizedError(error)) {
      error.message = '请求失败: kubeconfig 认证无效或当前环境未按 Sealos 应用方式代理 Kubernetes 请求'
    }
    throw error
  }
}

const requestMaybeConflictWithAuthRetry = async (url, clusterContext, options = {}) => {
  try {
    return await requestMaybeConflict(url, buildAuthorizedRequestOptions(clusterContext, options))
  } catch (error) {
    if (isUnauthorizedError(error)) {
      error.message = '请求失败: kubeconfig 认证无效或当前环境未按 Sealos 应用方式代理 Kubernetes 请求'
    }
    throw error
  }
}

const buildProxyUrl = (path, searchParams) => {
  const query = searchParams?.toString()
  return `/k8s-api${path}${query ? `?${query}` : ''}`
}

const normalizeHostname = (value = '') => {
  if (!value || typeof value !== 'string') return ''

  const raw = value.trim()
  if (!raw) return ''

  try {
    const target = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`)
    return target.hostname.trim().toLowerCase().replace(/\.$/, '')
  } catch {
    return raw
      .replace(/^[a-z]+:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/:\d+$/, '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '')
  }
}

const dedupeStrings = (values = []) => {
  const seen = new Set()

  return values.filter((value) => {
    const normalized = normalizeHostname(value)
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

const deriveRegionSlug = (value = '') => {
  const hostname = normalizeHostname(value)
  const firstLabel = hostname.split('.').filter(Boolean)[0] || ''

  return firstLabel.replace(/-\d+$/, '').replace(/[^a-z0-9]/g, '')
}

const deriveIngressDomainFromRegion = (value = '') => {
  const hostname = normalizeHostname(value)
  if (!hostname) return ''

  if (/\.sealos\.app$/i.test(hostname)) {
    return hostname
  }

  if (/\.sealos\.io$/i.test(hostname)) {
    return hostname.replace(/\.sealos\.io$/i, '.sealos.app')
  }

  const slug = deriveRegionSlug(hostname)
  return slug ? `${slug}.sealos.app` : ''
}

const inferIngressDomainFromExistingIngresses = (ingressList = []) => {
  for (const ingress of Array.isArray(ingressList) ? ingressList : []) {
    const host = normalizeHostname(ingress?.yaml?.spec?.rules?.[0]?.host || ingress?.desc || '')
    const publicDomainLabel = normalizeHostname(
      ingress?.yaml?.metadata?.labels?.['cloud.sealos.io/app-deploy-manager-domain'] || '',
    )

    if (publicDomainLabel && !publicDomainLabel.includes('.') && host.startsWith(`${publicDomainLabel}.`)) {
      return host.slice(publicDomainLabel.length + 1)
    }

    const parts = host.split('.').filter(Boolean)
    if (parts.length >= 3 && /^sealos[a-z0-9-]+\.(site|run|io|plus)$/.test(parts.slice(1).join('.'))) {
      return parts.slice(1).join('.')
    }
  }

  return ''
}

const resolveIngressDomain = (hostConfig, ingressList = []) => {
  const storedIngressDomain =
    typeof window !== 'undefined' ? sessionStorage.getItem('hermes-ingress-domain') || '' : ''
  const storedRegionDomain =
    typeof window !== 'undefined' ? sessionStorage.getItem('hermes-region-domain') || '' : ''

  const candidates = dedupeStrings([
    storedIngressDomain,
    inferIngressDomainFromExistingIngresses(ingressList),
    import.meta.env.VITE_DEFAULT_INGRESS_DOMAIN || '',
    deriveIngressDomainFromRegion(storedRegionDomain),
    deriveIngressDomainFromRegion(hostConfig?.cloud?.domain),
    deriveIngressDomainFromRegion(hostConfig?.domain),
  ])

  const resolved = candidates[0] || ''

  if (resolved && typeof window !== 'undefined') {
    sessionStorage.setItem('hermes-ingress-domain', resolved)
  }

  return resolved
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

  if (clusterServer) {
    params.set('k8sServer', clusterServer)
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

export const uploadFileToPod = async ({ appName, file, targetDirectory }, clusterContext) => {
  if (!appName) {
    throw new Error('缺少应用名，无法上传文件')
  }
  if (!file) {
    throw new Error('请先选择要上传的文件')
  }

  const pod = await findExecPodForApp(appName, clusterContext)
  const contentBase64 = await fileToBase64(file)
  const response = await requestJsonWithAuthRetry(buildProxyUrl('/files/upload'), clusterContext, {
    method: 'POST',
    body: JSON.stringify({
      namespace: pod.namespace,
      podName: pod.podName,
      containerName: pod.containerName,
      targetDirectory,
      fileName: file.name,
      contentBase64,
    }),
  })

  return {
    ...response,
    podName: pod.podName,
    containerName: pod.containerName,
  }
}

export const downloadFileFromPod = async ({ appName, remotePath }, clusterContext) => {
  if (!appName) {
    throw new Error('缺少应用名，无法下载文件')
  }
  if (!remotePath) {
    throw new Error('请输入容器内文件路径')
  }

  const pod = await findExecPodForApp(appName, clusterContext)
  const response = await requestRawWithAuthRetry(buildProxyUrl('/files/download'), clusterContext, {
    method: 'POST',
    body: JSON.stringify({
      namespace: pod.namespace,
      podName: pod.podName,
      containerName: pod.containerName,
      remotePath,
    }),
  })

  return {
    blob: await response.blob(),
    fileName:
      parseContentDispositionFilename(response.headers.get('content-disposition') || '') ||
      remotePath.split('/').filter(Boolean).pop() ||
      `${appName}.dat`,
    podName: pod.podName,
    containerName: pod.containerName,
  }
}

export const listFilesInPod = async ({ appName, directory }, clusterContext) => {
  if (!appName) {
    throw new Error('缺少应用名，无法读取目录')
  }

  const pod = await findExecPodForApp(appName, clusterContext)
  const response = await requestJsonWithAuthRetry(buildProxyUrl('/files/list'), clusterContext, {
    method: 'POST',
    body: JSON.stringify({
      namespace: pod.namespace,
      podName: pod.podName,
      containerName: pod.containerName,
      directory,
    }),
  })

  return {
    ...response,
    podName: pod.podName,
    containerName: pod.containerName,
  }
}

export const readFileFromPod = async ({ appName, remotePath }, clusterContext) => {
  if (!appName) {
    throw new Error('缺少应用名，无法读取文件')
  }
  if (!remotePath) {
    throw new Error('缺少文件路径，无法读取文件')
  }

  const pod = await findExecPodForApp(appName, clusterContext)
  const response = await requestJsonWithAuthRetry(buildProxyUrl('/files/read'), clusterContext, {
    method: 'POST',
    body: JSON.stringify({
      namespace: pod.namespace,
      podName: pod.podName,
      containerName: pod.containerName,
      remotePath,
    }),
  })

  return {
    ...response,
    content: base64ToText(response?.contentBase64 || ''),
    podName: pod.podName,
    containerName: pod.containerName,
  }
}

export const saveFileToPod = async ({ appName, remotePath, content }, clusterContext) => {
  if (!appName) {
    throw new Error('缺少应用名，无法保存文件')
  }
  if (!remotePath) {
    throw new Error('缺少文件路径，无法保存文件')
  }

  const pod = await findExecPodForApp(appName, clusterContext)
  const response = await requestJsonWithAuthRetry(buildProxyUrl('/files/save'), clusterContext, {
    method: 'POST',
    body: JSON.stringify({
      namespace: pod.namespace,
      podName: pod.podName,
      containerName: pod.containerName,
      remotePath,
      contentBase64: textToBase64(content),
    }),
  })

  return {
    ...response,
    podName: pod.podName,
    containerName: pod.containerName,
  }
}

const randomFromCharset = (length, charset) =>
  Array.from({ length }, () => charset[Math.floor(Math.random() * charset.length)]).join('')

const createDns1035Label = (length, tailCharset = '') => {
  const safeLength = Math.max(1, Number(length) || 1)
  const head = randomFromCharset(1, lowerAlpha)
  if (safeLength === 1) return head
  return `${head}${randomFromCharset(safeLength - 1, tailCharset || lowerAlnum)}`
}

const lowerAlnum = 'abcdefghijklmnopqrstuvwxyz0123456789'
const lowerAlpha = 'abcdefghijklmnopqrstuvwxyz'
const tokenCharset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

const createAppName = () => createDns1035Label(8, lowerAlnum)
const createDomainPrefix = () => randomFromCharset(12, lowerAlpha)
const createApiKey = () => randomFromCharset(64, tokenCharset)

export const getCreateBlueprint = (clusterContext, hostConfig, ingressList = []) => {
  const appName = createAppName()
  const domainPrefix = createDomainPrefix()
  const apiKey = createApiKey()
  const ingressDomain = resolveIngressDomain(hostConfig, ingressList)

  if (!ingressDomain) {
    throw new Error('未解析到可用的公网域名后缀，请配置 VITE_DEFAULT_INGRESS_DOMAIN 或先提供一个已存在的可用 Ingress')
  }

  return {
    appName,
    namespace: clusterContext.namespace,
    apiKey,
    domainPrefix,
    fullDomain: `${domainPrefix}.${ingressDomain}`,
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
