import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createClusterContext,
  createResource,
  deleteResource,
  downloadFileFromPod,
  getClusterInfo,
  getCreateBlueprint,
  getPreferredAuthToken,
  buildChatApiCandidates,
  buildPodExecWsCandidates,
  findExecPodForApp,
  listFilesInPod,
  listResources,
  readFileFromPod,
  saveFileToPod,
  uploadFileToPod,
  updateResource,
} from './api'
import {
  getSealosHostConfig,
  getSealosLanguage,
  getSealosQuota,
  getSealosSession,
} from './sealosSdk'
import { CHAT_TRANSPORT, createOpenAIChatConnection } from './chat'
import hermesAgentLogo from './assets/hermes-agent-logo.png'
import openclawLogo from './assets/openclaw-logo.jpg'
import AgentWindow from './components/AgentWindow'

const resourceMeta = {
  devbox: { title: 'Agents', columnLabel: '端口' },
  service: { title: 'Service', columnLabel: '端口' },
  ingress: { title: 'Ingress', columnLabel: '端口' },
}

const sharedAnnotations = {
  'kubernetes.io/ingress.class': 'nginx',
  'nginx.ingress.kubernetes.io/proxy-body-size': '32m',
  'nginx.ingress.kubernetes.io/ssl-redirect': 'false',
  'nginx.ingress.kubernetes.io/backend-protocol': 'HTTP',
  'nginx.ingress.kubernetes.io/client-body-buffer-size': '64k',
  'nginx.ingress.kubernetes.io/proxy-buffer-size': '64k',
  'nginx.ingress.kubernetes.io/proxy-send-timeout': '300',
  'nginx.ingress.kubernetes.io/proxy-read-timeout': '300',
  'nginx.ingress.kubernetes.io/server-snippet': 'client_header_buffer_size 64k;\nlarge_client_header_buffers 4 128k;',
}

const PRODUCT_META = {
  'hermes-agent': {
    label: 'Hermes Agent',
    logo: hermesAgentLogo,
  },
  openclaw: {
    label: 'OpenClaw',
    logo: openclawLogo,
  },
}

const RESOURCE_PRESETS = [
  {
    id: 'minimum',
    label: '最小',
    description: '1c2g · 轻量运行',
    cpu: '1000m',
    memory: '2048Mi',
  },
  {
    id: 'recommended',
    label: '推荐',
    description: '2c4g · 默认配置',
    cpu: '2000m',
    memory: '4096Mi',
  },
  {
    id: 'luxury',
    label: '豪华',
    description: '4c8g · 更高性能',
    cpu: '4000m',
    memory: '8192Mi',
  },
  {
    id: 'custom',
    label: '自定义',
    description: '手动输入 CPU / 内存',
    cpu: '',
    memory: '',
  },
]

const DEFAULT_FILE_DIRECTORY = '/home/admin'

const MARKDOWN_PREVIEW_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt',
  'json',
  'yaml',
  'yml',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'html',
  'xml',
  'csv',
  'log',
  'ini',
  'toml',
  'env',
  'py',
  'sh',
  'bash',
  'sql',
  'java',
  'go',
  'rs',
  'conf',
  'properties',
])
const IMAGE_PREVIEW_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'])

const normalizeName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)

const ensureDns1035Name = (value, fallback = 'agent') => {
  const normalized = normalizeName(value) || normalizeName(fallback) || 'agent'
  const candidate = /^[a-z]/.test(normalized) ? normalized : `a${normalized}`
  return candidate.slice(0, 63).replace(/^-+|-+$/g, '') || 'agent'
}

const buildAgentLabels = (source, clusterContext) => ({
  'agent.sealos.io/name': clusterContext?.agentLabel || source.user,
})

const inferProductType = (image = '') => (/openclaw/i.test(image) ? 'openclaw' : 'hermes-agent')

const resolveResourcePreset = (cpu = '', memory = '') => {
  const match = RESOURCE_PRESETS.find((preset) => preset.cpu === cpu && preset.memory === memory)
  return match?.id || 'custom'
}

const getLabelId = (item) =>
  item?.yaml?.metadata?.labels?.id || item?.yaml?.metadata?.labels?.['agent.sealos.io/name'] || '--'

const isPausedStatus = (status = '') => /paused/i.test(String(status || ''))

const formatTerminalStatusText = (status = '') => {
  const statusMap = {
    initializing: '初始化中',
    connecting: '连接中',
    connected: '已连接',
    disconnected: '已断开',
    error: '连接失败',
  }

  return statusMap[status] || status || '--'
}

const getTerminalStatusClassName = (status = '') => {
  if (status === 'connected') {
    return 'border border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
  }

  if (status === 'connecting' || status === 'initializing') {
    return 'border border-amber-300/20 bg-amber-300/10 text-amber-100'
  }

  if (status === 'error') {
    return 'border border-rose-400/20 bg-rose-400/10 text-rose-200'
  }

  return 'border border-white/10 bg-white/5 text-[#d2d6dc]'
}

const formatFileManagerTimestamp = (value) => {
  if (!value) return '--'

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

const formatFileManagerSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`
}

const getPathLeafName = (value = '') => {
  const segments = String(value || '')
    .split('/')
    .map((item) => item.trim())
    .filter(Boolean)

  return segments.at(-1) || value || '--'
}

const buildRemoteFilePath = (directory = '', fileName = '') => {
  const safeDirectory = String(directory || '').trim().replace(/\/+$/g, '') || '/'
  const safeFileName = String(fileName || '').trim().replace(/^\/+/, '')

  if (!safeFileName) {
    return safeDirectory
  }

  return safeDirectory === '/' ? `/${safeFileName}` : `${safeDirectory}/${safeFileName}`
}

const normalizeDirectoryPath = (value = '', fallback = DEFAULT_FILE_DIRECTORY) => {
  const normalized = String(value || '').trim() || fallback
  if (normalized === '/') return '/'
  return normalized.replace(/\/+$/g, '') || '/'
}

const getParentDirectoryPath = (value = '') => {
  const normalized = normalizeDirectoryPath(value, '/')
  if (normalized === '/') return '/'

  const segments = normalized.split('/').filter(Boolean)
  segments.pop()
  return segments.length ? `/${segments.join('/')}` : '/'
}

const resolveFileManagerPath = (value = '', currentDirectory = DEFAULT_FILE_DIRECTORY) => {
  const rawValue = String(value || '').trim()
  const fallbackRawDirectory = normalizeDirectoryPath(currentDirectory, '/')
  const fallbackDirectory =
    fallbackRawDirectory === '/' || fallbackRawDirectory.startsWith('/') ? fallbackRawDirectory : `/${fallbackRawDirectory}`

  if (!rawValue) {
    return fallbackDirectory
  }

  if (rawValue === '/') {
    return '/'
  }

  const segments = rawValue.startsWith('/') ? [] : fallbackDirectory.split('/').filter(Boolean)

  for (const segment of rawValue.split('/')) {
    const token = segment.trim()
    if (!token || token === '.') continue
    if (token === '..') {
      segments.pop()
      continue
    }
    segments.push(token)
  }

  return segments.length ? `/${segments.join('/')}` : '/'
}

const getFileExtension = (value = '') => {
  const match = String(value || '').toLowerCase().match(/\.([^.]+)$/)
  return match?.[1] || ''
}

const isMarkdownLikeFile = (value = '') => MARKDOWN_PREVIEW_EXTENSIONS.has(getFileExtension(value))

const isImagePreviewableFile = (value = '') => IMAGE_PREVIEW_EXTENSIONS.has(getFileExtension(value))

const isTextPreviewableFile = (value = '') => {
  const normalizedValue = String(value || '').trim().toLowerCase()
  const extension = getFileExtension(value)
  if (MARKDOWN_PREVIEW_EXTENSIONS.has(extension) || TEXT_PREVIEW_EXTENSIONS.has(extension)) {
    return true
  }
  return ['readme', 'license', 'dockerfile', 'makefile'].includes(normalizedValue)
}

const getFileEntryTypeLabel = (entry = {}) => {
  if (entry.kind === 'parent') return '上一级'
  if (entry.kind === 'directory') return '目录'
  if (!entry?.name) return '--'
  if (isMarkdownLikeFile(entry.name)) return '文档'
  if (isTextPreviewableFile(entry.name)) return '文本'
  return '文件'
}

const emptyBlueprint = {
  appName: '',
  namespace: '',
  apiKey: '',
  apiUrl: '',
  domainPrefix: '',
  fullDomain: '',
  image: 'nousresearch/hermes-agent:latest',
  productType: 'hermes-agent',
  state: 'Running',
  runtimeClassName: 'devbox-runtime',
  storageLimit: '10Gi',
  port: 8642,
  cpu: '2000m',
  memory: '4096Mi',
  profile: 'recommended',
  serviceType: 'ClusterIP',
  protocol: 'TCP',
  user: '',
  workingDir: '/home/admin',
  argsText: 'gateway run',
}

const createChatSession = (resource) => ({
  resource,
  draft: '',
  status: 'idle',
  transport: CHAT_TRANSPORT.sse,
  error: '',
  triedApiUrls: [],
  messages: [],
})

const createTerminalSession = (resource) => ({
  resource,
  status: 'initializing',
  error: '',
  podName: '',
  containerName: '',
  namespace: '',
  wsUrl: '',
})

const createKeySession = (resource) => ({
  resource,
})

const createFileManagerSession = (resource) => ({
  resource,
  uploadDirectory: DEFAULT_FILE_DIRECTORY,
  directoryInput: DEFAULT_FILE_DIRECTORY,
  downloadPath: '',
  selectedFile: null,
  selectedAt: '',
  searchKeyword: '',
  status: '',
  error: '',
  browsing: false,
  uploading: false,
  downloading: false,
  previewing: false,
  reading: false,
  saving: false,
  entriesLoaded: false,
  entries: [],
  activeItem: null,
  detailVisible: false,
  previewContent: '',
  previewDraft: '',
  previewMode: 'preview',
  previewObjectUrl: '',
  previewObjectType: '',
  lastUploadedPath: '',
  lastUploadedFileName: '',
  lastUploadedSize: 0,
  lastUploadedAt: '',
  lastDownloadedPath: '',
  lastDownloadedFileName: '',
  lastDownloadedSize: 0,
  lastDownloadedAt: '',
})

const splitArgsText = (value = '') =>
  value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)

const createBlueprintFromResourceGroup = ({ devbox, service, ingress, fallbackNamespace }) => {
  const devboxYaml = devbox?.yaml || {}
  const serviceYaml = service?.yaml || {}
  const ingressYaml = ingress?.yaml || {}
  const host = ingressYaml?.spec?.rules?.[0]?.host || ''
  const envList = devboxYaml?.spec?.config?.env || []
  const appPorts = devboxYaml?.spec?.config?.appPorts || []
  const servicePorts = serviceYaml?.spec?.ports || []
  const args = devboxYaml?.spec?.config?.args || []
  const apiKey = envList.find((env) => env.name === 'API_SERVER_KEY')?.value || ''
  const apiUrl = host ? `https://${host}/v1` : ''

  return {
    appName: devbox?.name || service?.name || ingress?.name || '',
    namespace:
      devboxYaml?.metadata?.namespace ||
      serviceYaml?.metadata?.namespace ||
      ingressYaml?.metadata?.namespace ||
      fallbackNamespace ||
      '',
    apiKey,
    apiUrl,
    domainPrefix:
      ingressYaml?.metadata?.labels?.['cloud.sealos.io/app-deploy-manager-domain'] ||
      host.split('.')[0] ||
      '',
    fullDomain: host,
    image: devboxYaml?.spec?.image || devbox?.image || 'nousresearch/hermes-agent:latest',
    state: devboxYaml?.spec?.state || devbox?.status || 'Running',
    runtimeClassName: devboxYaml?.spec?.runtimeClassName || 'devbox-runtime',
    storageLimit: devboxYaml?.spec?.storageLimit || '10Gi',
    port:
      appPorts[0]?.port ||
      servicePorts[0]?.port ||
      ingressYaml?.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service?.port?.number ||
      devbox?.port ||
      service?.port ||
      ingress?.port ||
      8642,
    cpu: devboxYaml?.spec?.resource?.cpu || '2000m',
    memory: devboxYaml?.spec?.resource?.memory || '4096Mi',
    profile: resolveResourcePreset(
      devboxYaml?.spec?.resource?.cpu || '2000m',
      devboxYaml?.spec?.resource?.memory || '4096Mi',
    ),
    serviceType: serviceYaml?.spec?.type || 'ClusterIP',
    protocol: appPorts[0]?.protocol || servicePorts[0]?.protocol || 'TCP',
    user: devbox?.owner || 'admin',
    workingDir: devboxYaml?.spec?.config?.workingDir || '/home/admin',
    argsText: Array.isArray(args) ? args.join(' ') : 'gateway run',
    productType: inferProductType(devboxYaml?.spec?.image || devbox?.image),
  }
}

const buildResourcePayloads = (source, clusterContext) => {
  const args = splitArgsText(source.argsText)
  const agentLabels = buildAgentLabels(source, clusterContext)
  const safeDomainPrefix = normalizeName(source.domainPrefix || source.appName || 'agent')
  const ingressName = `network-${safeDomainPrefix}`

  const appSelector = {
    app: source.appName,
    ...agentLabels,
  }

  const devbox = {
    name: source.appName,
    owner: source.user,
    image: source.image,
    replicas: Number(source.port),
    status: source.state,
    desc: `DevBox / ${source.namespace}`,
    yaml: {
      apiVersion: 'devbox.sealos.io/v1alpha2',
      kind: 'Devbox',
      metadata: {
        name: source.appName,
        namespace: source.namespace,
        labels: appSelector,
      },
      spec: {
        image: source.image,
        state: source.state,
        runtimeClassName: source.runtimeClassName,
        storageLimit: source.storageLimit,
        network: {
          type: 'SSHGate',
          extraPorts: [{ containerPort: Number(source.port) }],
        },
        resource: {
          cpu: source.cpu,
          memory: source.memory,
        },
        config: {
          labels: appSelector,
          user: source.user,
          workingDir: source.workingDir,
          appPorts: [
            {
              name: source.appName,
              port: Number(source.port),
              protocol: source.protocol,
              targetPort: Number(source.port),
            },
          ],
          env: [
            { name: 'API_SERVER_KEY', value: source.apiKey },
            { name: 'API_SERVER_ENABLED', value: 'true' },
            { name: 'API_SERVER_HOST', value: '0.0.0.0' },
            { name: 'API_SERVER_PORT', value: String(source.port) },
          ],
          args,
        },
      },
    },
  }

  const service = {
    name: source.appName,
    owner: source.user,
    image: source.serviceType,
    replicas: Number(source.port),
    status: 'Healthy',
    desc: `Service / ${source.namespace}`,
    yaml: {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
        name: source.appName,
        namespace: source.namespace,
        labels: appSelector,
      },
      spec: {
        type: source.serviceType,
        selector: appSelector,
        ports: [
          {
            name: 'api',
            port: Number(source.port),
            targetPort: Number(source.port),
            protocol: source.protocol,
          },
        ],
      },
    },
  }

  const ingress = {
    name: ingressName,
    owner: source.user,
    image: source.fullDomain,
    replicas: Number(source.port),
    status: 'Active',
    desc: `Ingress / ${source.namespace}`,
    yaml: {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: ingressName,
        namespace: source.namespace,
        labels: {
          ...appSelector,
          'cloud.sealos.io/app-deploy-manager': source.appName,
          'cloud.sealos.io/app-deploy-manager-domain': source.domainPrefix,
        },
        annotations: sharedAnnotations,
      },
      spec: {
        rules: [
          {
            host: source.fullDomain,
            http: {
              paths: [
                {
                  pathType: 'Prefix',
                  path: '/',
                  backend: {
                    service: {
                      name: source.appName,
                      port: {
                        number: Number(source.port),
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
        tls: [
          {
            hosts: [source.fullDomain],
            secretName: 'wildcard-cert',
          },
        ],
      },
    },
  }

  return { devbox, service, ingress }
}

export default function App() {
  const [resources, setResources] = useState({ devbox: [], service: [], ingress: [] })
  const [clusterInfo, setClusterInfo] = useState(null)
  const [clusterContext, setClusterContext] = useState(null)
  const [hostConfig, setHostConfig] = useState(null)
  const [activeType, setActiveType] = useState('devbox')
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [, setMessage] = useState('')
  const [, setCopyMessage] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState('create')
  const [createTypeOpen, setCreateTypeOpen] = useState(false)
  const [createType, setCreateType] = useState('hermes-agent')
  const [editingGroup, setEditingGroup] = useState(null)
  const [blueprint, setBlueprint] = useState({ ...emptyBlueprint })
  const [actionMenuId, setActionMenuId] = useState('')
  const [chatSession, setChatSession] = useState(null)
  const chatConnectionRef = useRef(null)
  const chatMessagesRef = useRef(null)
  const chatShouldAutoScrollRef = useRef(true)
  const [terminalSession, setTerminalSession] = useState(null)
  const [keySession, setKeySession] = useState(null)
  const [fileManagerSession, setFileManagerSession] = useState(null)
  const fileInputRef = useRef(null)
  const terminalContainerRef = useRef(null)
  const terminalRef = useRef(null)
  const terminalFitAddonRef = useRef(null)
  const terminalSocketRef = useRef(null)
  const terminalDataDisposableRef = useRef(null)
  const [config] = useState({
    docUrl: 'https://vite.dev/guide/',
  })

  const terminalResource = terminalSession?.resource || null

  const findResourceGroup = useCallback(
    (name) => {
      const devbox = resources.devbox.find((entry) => entry.name === name) || null
      const service = resources.service.find((entry) => entry.name === name) || null
      const ingress =
        resources.ingress.find((entry) => entry.yaml?.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service?.name === name) ||
        resources.ingress.find((entry) => entry.name === name) ||
        resources.ingress.find((entry) => entry.name === `network-${normalizeName(name)}`) ||
        null

      return { devbox, service, ingress }
    },
    [resources.devbox, resources.service, resources.ingress],
  )

  const enrichedItems = useMemo(() => {
    const activeItems = resources[activeType] || []

    if (activeType !== 'devbox') {
      return activeItems
    }

    return activeItems.map((item) => {
      const group = findResourceGroup(item.name)
      const blueprint = createBlueprintFromResourceGroup({
        ...group,
        fallbackNamespace: clusterInfo?.namespace,
      })
      const ingressHost = group.ingress?.yaml?.spec?.rules?.[0]?.host || ''
      const productType = blueprint.productType || inferProductType(item.image)

      return {
        ...item,
        apiUrl: ingressHost ? `https://${ingressHost}/v1` : '',
        apiKey: blueprint.apiKey || item.apiKey || '',
        labelId: getLabelId(group.devbox || item),
        productType,
        productMeta: PRODUCT_META[productType] || PRODUCT_META['hermes-agent'],
      }
    })
  }, [activeType, resources, clusterInfo?.namespace, findResourceGroup])

  const filteredItems = useMemo(() => {
    if (!keyword.trim()) return enrichedItems
    return enrichedItems.filter((item) =>
      [item.name, item.labelId, item.status, item.updatedAt, item.productMeta?.label]
        .join(' ')
        .toLowerCase()
        .includes(keyword.toLowerCase()),
    )
  }, [enrichedItems, keyword])

  const fileManagerRows = useMemo(() => {
    if (!fileManagerSession) return []

    const currentDirectory = normalizeDirectoryPath(fileManagerSession.uploadDirectory)
    const rows = []

    if (currentDirectory !== '/') {
      rows.push({
        id: `parent:${getParentDirectoryPath(currentDirectory)}`,
        kind: 'parent',
        name: '返回上一级',
        path: getParentDirectoryPath(currentDirectory),
        size: null,
        updatedAt: '',
        typeLabel: '上一级',
        sizeLabel: '--',
        updatedLabel: '--',
      })
    }

    for (const entry of fileManagerSession.entries || []) {
      const entryPath = resolveFileManagerPath(entry.path || entry.name, currentDirectory)

      rows.push({
        ...entry,
        path: entryPath,
        id: `${entry.kind}:${entryPath}`,
        typeLabel: getFileEntryTypeLabel(entry),
        sizeLabel: entry.kind === 'directory' ? '--' : formatFileManagerSize(Number(entry.size)),
        updatedLabel: formatFileManagerTimestamp(entry.updatedAt),
      })
    }

    const localKeyword = fileManagerSession.searchKeyword.trim().toLowerCase()
    if (!localKeyword) return rows

    return rows.filter((row) =>
      [row.name, row.path, row.typeLabel, row.kind === 'parent' ? '返回上一级' : '']
        .join(' ')
        .toLowerCase()
        .includes(localKeyword),
    )
  }, [fileManagerSession])

  const loadAll = async () => {
    setLoading(true)
    try {
      const session = await getSealosSession().catch(() => null)
      await getSealosLanguage().catch(() => null)
      await getSealosQuota().catch(() => null)
      const hostConfig = await getSealosHostConfig().catch(() => null)

      setHostConfig(hostConfig)

      const nextClusterContext = createClusterContext(session)
      setClusterContext(nextClusterContext)

      const kubeconfig = session?.kubeconfig || ''
      if (kubeconfig) {
        sessionStorage.setItem('hermes-kubeconfig', kubeconfig)
      }
      const rawRegionDomain = session?.subscription?.RegionDomain || hostConfig?.cloud?.domain || hostConfig?.domain || ''
      const regionDomain = String(rawRegionDomain || '').trim().replace(/\.sealos\.io$/i, '.sealos.app')
      if (regionDomain) {
        sessionStorage.setItem('hermes-region-domain', regionDomain)
      }

      const [cluster, devbox, service, ingress] = await Promise.all([
        getClusterInfo(nextClusterContext),
        listResources('devbox', nextClusterContext),
        listResources('service', nextClusterContext),
        listResources('ingress', nextClusterContext),
      ])
      setClusterInfo(cluster)
      setResources({ devbox, service, ingress })
      setMessage('')
    } catch (error) {
      setMessage(error.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  useEffect(() => {
    if (!actionMenuId) return undefined

    const handlePointerDown = (event) => {
      if (event.target.closest?.('[data-action-menu-root="true"]')) return
      setActionMenuId('')
    }

    document.addEventListener('click', handlePointerDown)
    return () => document.removeEventListener('click', handlePointerDown)
  }, [actionMenuId])

  useEffect(() => () => {
    chatConnectionRef.current?.close()
    chatConnectionRef.current = null
    terminalDataDisposableRef.current?.dispose?.()
    terminalDataDisposableRef.current = null
    const socket = terminalSocketRef.current
    terminalSocketRef.current = null
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, 'unmount')
    }
    terminalRef.current?.dispose?.()
    terminalRef.current = null
    terminalFitAddonRef.current = null
  }, [])

  useEffect(() => {
    const container = chatMessagesRef.current
    if (!container || !chatSession) return

    if (chatShouldAutoScrollRef.current) {
      container.scrollTop = container.scrollHeight
    }
  }, [chatSession?.messages, chatSession])

  const handleChatScroll = () => {
    const container = chatMessagesRef.current
    if (!container) return

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    chatShouldAutoScrollRef.current = distanceFromBottom <= 80
  }

  const writeTerminalData = useCallback((value) => {
    if (!terminalRef.current) return
    terminalRef.current.write(value)
  }, [])

  const sendTerminalInput = useCallback((input) => {
    const socket = terminalSocketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return

    const encoder = new TextEncoder()
    const encoded = encoder.encode(input)
    const payload = new Uint8Array(encoded.length + 1)
    payload[0] = 0
    payload.set(encoded, 1)
    socket.send(payload)
  }, [])

  const closeTerminalSocket = useCallback(() => {
    const socket = terminalSocketRef.current
    terminalSocketRef.current = null

    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, 'manual-close')
    }
  }, [])

  const disconnectTerminal = useCallback((options = {}) => {
    const { keepSession = true, nextStatus = 'disconnected', nextError = '' } = options
    closeTerminalSocket()

    if (!keepSession) {
      setTerminalSession(null)
      return
    }

    setTerminalSession((current) => {
      if (!current) return current
      return {
        ...current,
        status: nextStatus,
        error: nextError,
      }
    })
  }, [closeTerminalSocket])

  const connectTerminal = useCallback(
    async (resource) => {
      if (!resource) return
      if (!clusterContext) {
        setTerminalSession((current) =>
          current
            ? {
                ...current,
                status: 'error',
                error: '缺少集群上下文，无法建立终端连接。',
              }
            : current,
        )
        return
      }

      setTerminalSession((current) => (current ? { ...current, status: 'connecting', error: '' } : current))

      closeTerminalSocket()

      try {
        const pod = await findExecPodForApp(resource.name, clusterContext)
        const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
        const localProxyOnly =
          import.meta.env.DEV && typeof window !== 'undefined' && localHosts.has(window.location.hostname)

        const wsCandidates = buildPodExecWsCandidates({
          namespace: pod.namespace,
          podName: pod.podName,
          containerName: pod.containerName,
          token: getPreferredAuthToken(clusterContext),
          clusterServer: clusterContext.server,
          commands: ['sh', '-lc', 'if command -v hermes >/dev/null 2>&1; then hermes; fi; exec sh'],
          localProxyOnly,
        })

        const redactWsUrl = (value = '') => {
          try {
            const url = new URL(value)
            if (url.searchParams.has('k8sToken')) {
              url.searchParams.set('k8sToken', '<redacted>')
            }
            return url.toString()
          } catch {
            return value
          }
        }

        console.info('[terminal] connect ws candidates', {
          wsCandidates: wsCandidates.map(redactWsUrl),
          localProxyOnly,
          locationOrigin: typeof window !== 'undefined' ? window.location.origin : '',
          referrer: typeof document !== 'undefined' ? document.referrer : '',
          clusterServer: clusterContext.server,
          ancestorOrigin: typeof window !== 'undefined' ? window.location.ancestorOrigins?.[0] || '' : '',
        })

        const tryOpenWebSocket = (wsUrl, protocols = ['v4.channel.k8s.io']) =>
          new Promise((resolve, reject) => {
            let settled = false
            const safeWsUrl = redactWsUrl(wsUrl)
            const socket = protocols?.length ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl)
            const timer = window.setTimeout(() => {
              if (settled) return
              settled = true
              socket.close()
              reject(new Error(`连接超时: ${safeWsUrl}`))
            }, 6000)

            const finish = (callback) => (event) => {
              if (settled) return
              settled = true
              window.clearTimeout(timer)
              callback(event)
            }

            socket.onopen = finish(() => resolve(socket))
            socket.onerror = () => {
              // 等待 onclose 拿到 code
            }
            socket.onclose = finish((event) => reject(new Error(`连接关闭（code=${event.code}）: ${safeWsUrl}`)))
          })

        let socket = null
        let wsUrl = ''

        for (const candidate of wsCandidates) {
          try {
            socket = await tryOpenWebSocket(candidate, ['v4.channel.k8s.io'])
            wsUrl = candidate
            break
          } catch {
            try {
              socket = await tryOpenWebSocket(candidate, [])
              wsUrl = candidate
              break
            } catch {
              // 继续尝试下一个候选地址
            }
          }
        }

        if (!socket) {
          setTerminalSession((current) =>
            current
              ? {
                  ...current,
                  status: 'error',
                  error: '未建立终端连接，请关闭后重新打开终端。',
                }
              : current,
          )
          return
        }

        socket.binaryType = 'arraybuffer'
        terminalSocketRef.current = socket

        setTerminalSession((current) =>
          current
            ? {
                ...current,
                status: 'connected',
                error: '',
                podName: pod.podName,
                containerName: pod.containerName,
                namespace: pod.namespace,
                wsUrl: redactWsUrl(wsUrl),
              }
            : current,
        )

        socket.onmessage = (event) => {
          const appendFromText = (text) => {
            if (!text) return
            const channelCode = text.charCodeAt(0)
            const payload = text.slice(1)

            if (channelCode === 2) {
              writeTerminalData(`\u001b[31m${payload}\u001b[0m`)
              return
            }

            if (channelCode === 3) {
              return
            }

            writeTerminalData(payload)
          }

          if (typeof event.data === 'string') {
            appendFromText(event.data)
            return
          }

          if (event.data instanceof ArrayBuffer) {
            const bytes = new Uint8Array(event.data)
            if (!bytes.length) return
            const channelCode = bytes[0]
            const payload = new TextDecoder().decode(bytes.slice(1))

            if (channelCode === 2) {
              writeTerminalData(`\u001b[31m${payload}\u001b[0m`)
              return
            }

            if (channelCode === 3) {
              return
            }

            writeTerminalData(payload)
          }
        }

        socket.onerror = () => {
          setTerminalSession((current) =>
            current
              ? {
                  ...current,
                  status: 'error',
                  error: '终端连接异常，请关闭后重新打开。',
                }
              : current,
          )
        }

        socket.onclose = (event) => {
          setTerminalSession((current) =>
            current
              ? {
                  ...current,
                  status: current.status === 'error' ? current.status : 'disconnected',
                  error: current.error || (event.code && event.code !== 1000 ? `连接已关闭（code=${event.code}）` : ''),
                }
              : current,
          )
          terminalSocketRef.current = null
        }
      } catch (error) {
        console.error(error)
        const errorMessage = error?.message || '终端连接失败'
        setTerminalSession((current) =>
          current
            ? {
                ...current,
                status: 'error',
                error: errorMessage,
              }
            : current,
        )
      }
    },
    [clusterContext, closeTerminalSocket, writeTerminalData],
  )

  useEffect(() => {
    if (!terminalResource || !terminalContainerRef.current) return

    const resource = terminalResource
    let disposed = false
    let terminal = null
    let resizeObserver = null
    let onWindowResize = null

    const initTerminal = async () => {
      try {
        await import('@xterm/xterm/css/xterm.css')
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ])

        if (disposed || !terminalContainerRef.current) return

        terminal = new Terminal({
          cursorBlink: true,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace',
          fontSize: 14,
          lineHeight: 1.35,
          letterSpacing: 0.2,
          convertEol: true,
          scrollback: 4000,
          theme: {
            background: '#05070a',
            foreground: '#f3efe7',
            cursor: '#f6c58f',
            cursorAccent: '#05070a',
            selectionBackground: 'rgba(250, 249, 246, 0.18)',
            black: '#17191d',
            brightBlack: '#6b7280',
          },
        })

        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.open(terminalContainerRef.current)
        fitAddon.fit()
        terminal.focus()

        terminalRef.current = terminal
        terminalFitAddonRef.current = fitAddon

        resizeObserver = new ResizeObserver(() => {
          fitAddon.fit()
        })
        resizeObserver.observe(terminalContainerRef.current)

        onWindowResize = () => fitAddon.fit()
        window.addEventListener('resize', onWindowResize)

        terminalDataDisposableRef.current = terminal.onData((input) => {
          sendTerminalInput(input)
        })

        connectTerminal(resource)
      } catch (error) {
        console.error(error)
        const errorMessage = error.message || '终端初始化失败'
        setTerminalSession((current) => (current ? { ...current, status: 'error', error: errorMessage } : current))
      }
    }

    initTerminal()

    return () => {
      disposed = true
      terminalDataDisposableRef.current?.dispose?.()
      terminalDataDisposableRef.current = null
      if (onWindowResize) {
        window.removeEventListener('resize', onWindowResize)
      }
      resizeObserver?.disconnect()
      terminal?.dispose?.()
      terminalRef.current = null
      terminalFitAddonRef.current = null
      disconnectTerminal({ keepSession: true, nextStatus: 'disconnected' })
    }
  }, [terminalResource, connectTerminal, disconnectTerminal, sendTerminalInput])

  const loadBlueprint = async () => {
    if (!clusterContext) throw new Error('缺少 cluster context')
    const data = await getCreateBlueprint(clusterContext, hostConfig, resources.ingress)
    const safeAppName = ensureDns1035Name(data.appName, createType === 'openclaw' ? 'openclaw' : 'agent')
    setBlueprint({
      ...data,
      appName: safeAppName,
      profile: resolveResourcePreset(data.cpu, data.memory),
      productType: createType,
      user: clusterContext?.operator || data.user,
      argsText: Array.isArray(data.args) ? data.args.join(' ') : 'gateway run',
    })
  }

  const openCreate = () => {
    setFormMode('create')
    setEditingGroup(null)
    setCreateType('hermes-agent')
    setActionMenuId('')
    setCreateTypeOpen(true)
  }

  const closeCreateType = () => {
    setCreateTypeOpen(false)
    setCreateType('hermes-agent')
  }

  const proceedCreateType = async () => {
    try {
      await loadBlueprint()
      setCreateTypeOpen(false)
      setFormOpen(true)
    } catch (error) {
      console.error(error)
      setMessage(error.message || '加载创建模板失败')
    }
  }

  const openEdit = (item) => {
    const group = findResourceGroup(item.name)
    setFormMode('edit')
    setEditingGroup(group)
    setActionMenuId('')
    setBlueprint(createBlueprintFromResourceGroup({ ...group, fallbackNamespace: clusterInfo?.namespace }))
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setCreateTypeOpen(false)
    setFormMode('create')
    setCreateType('hermes-agent')
    setEditingGroup(null)
    setActionMenuId('')
    setBlueprint({ ...emptyBlueprint })
  }

  const handleBlueprintChange = (field, value) => {
    setBlueprint((current) => {
      const next = { ...current, [field]: value }
      if (field === 'cpu' || field === 'memory') {
        next.profile = resolveResourcePreset(field === 'cpu' ? value : next.cpu, field === 'memory' ? value : next.memory)
      }
      return next
    })
  }

  const handleProfileChange = (profileId) => {
    setBlueprint((current) => {
      const preset = RESOURCE_PRESETS.find((item) => item.id === profileId)
      if (!preset) return current
      if (profileId === 'custom') {
        return {
          ...current,
          profile: 'custom',
        }
      }
      return {
        ...current,
        profile: profileId,
        cpu: preset.cpu,
        memory: preset.memory,
      }
    })
  }

  const handleCopy = async (value, label) => {
    if (!value) {
      setCopyMessage(`${label} 为空，无法复制`)
      return
    }

    try {
      await navigator.clipboard.writeText(value)
      setCopyMessage(`${label} 已复制`)
      window.setTimeout(() => setCopyMessage(''), 2000)
    } catch (error) {
      console.error(error)
      setCopyMessage(`${label} 复制失败`)
    }
  }

  const openChat = (item) => {
    setActionMenuId('')
    chatConnectionRef.current?.close()
    chatConnectionRef.current = null
    chatShouldAutoScrollRef.current = true

    let host = ''
    if (item.apiUrl) {
      try {
        host = new URL(item.apiUrl).host
      } catch {
        host = ''
      }
    }
    const chatApiCandidates = buildChatApiCandidates(host)

    setChatSession(
      createChatSession({
        ...item,
        apiUrl: chatApiCandidates[0] || item.apiUrl,
        chatApiCandidates,
        apiKey: item.apiKey,
      }),
    )
  }

  const closeChat = () => {
    chatConnectionRef.current?.close()
    chatConnectionRef.current = null
    setChatSession(null)
  }

  const openTerminal = (item) => {
    setActionMenuId('')
    setTerminalSession(createTerminalSession(item))
  }

  const closeTerminal = () => {
    disconnectTerminal({ keepSession: false })
  }

  const openKeyDialog = (item) => {
    setActionMenuId('')
    setKeySession(createKeySession(item))
  }

  const closeKeyDialog = () => {
    setKeySession(null)
  }

  const openFileManager = (item) => {
    setActionMenuId('')
    setFileManagerSession(createFileManagerSession(item))
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const closeFileManager = () => {
    let previewObjectUrl = ''

    setFileManagerSession((current) => {
      previewObjectUrl = current?.previewObjectUrl || ''
      return null
    })

    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl)
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const updateFileManagerSession = useCallback((updater) => {
    setFileManagerSession((current) => {
      if (!current) return current
      return typeof updater === 'function' ? updater(current) : updater
    })
  }, [])

  const revokeFileManagerObjectUrl = useCallback((value = '') => {
    if (value) {
      URL.revokeObjectURL(value)
    }
  }, [])

  const closeFileManagerDetail = useCallback(() => {
    let previewObjectUrl = ''

    updateFileManagerSession((current) => {
      if (!current) return current
      previewObjectUrl = current.previewObjectUrl || ''

      return {
        ...current,
        detailVisible: false,
        previewing: false,
        reading: false,
        previewObjectUrl: '',
        previewObjectType: '',
        error: '',
      }
    })

    revokeFileManagerObjectUrl(previewObjectUrl)
  }, [revokeFileManagerObjectUrl, updateFileManagerSession])

  const handlePickFile = () => {
    fileInputRef.current?.click()
  }

  const handleClearFileManagerSelection = () => {
    updateFileManagerSession((current) => ({
      ...current,
      selectedFile: null,
      selectedAt: '',
      error: '',
    }))

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const loadFileManagerDirectory = useCallback(
    async (directory, options = {}) => {
      const resource = fileManagerSession?.resource
      const targetDirectory = resolveFileManagerPath(directory, fileManagerSession?.uploadDirectory || DEFAULT_FILE_DIRECTORY)

      if (!resource) return []
      if (!clusterContext) {
        updateFileManagerSession((current) => ({
          ...current,
          error: '缺少集群上下文，无法读取目录。',
        }))
        return []
      }

      let previewObjectUrl = ''

      updateFileManagerSession((current) => {
        if (!current) return current
        if (options.resetPreview) {
          previewObjectUrl = current.previewObjectUrl || ''
        }

        return {
          ...current,
          browsing: true,
          error: '',
          status: options.statusMessage || `正在读取目录 ${targetDirectory}...`,
          directoryInput: targetDirectory,
          ...(options.resetPreview
            ? {
                activeItem: null,
                detailVisible: false,
                previewContent: '',
                previewDraft: '',
                previewMode: 'preview',
                previewObjectUrl: '',
                previewObjectType: '',
                downloadPath: '',
              }
            : {}),
        }
      })

      revokeFileManagerObjectUrl(previewObjectUrl)

      try {
        const result = await listFilesInPod(
          {
            appName: resource.name,
            directory: targetDirectory,
          },
          clusterContext,
        )
        const nextDirectory = resolveFileManagerPath(result.directory || targetDirectory, targetDirectory)
        const entries = Array.isArray(result.entries)
          ? result.entries.map((entry) => ({
              ...entry,
              path: resolveFileManagerPath(entry.path || entry.name, nextDirectory),
            }))
          : []

        updateFileManagerSession((current) => {
          if (!current) return current

          const focusedItem = options.focusPath ? entries.find((entry) => entry.path === options.focusPath) || null : null

          return {
            ...current,
            browsing: false,
            entriesLoaded: true,
            uploadDirectory: nextDirectory,
            directoryInput: nextDirectory,
            entries,
            activeItem: options.resetPreview ? null : focusedItem || current.activeItem,
            downloadPath:
              focusedItem && focusedItem.kind !== 'directory'
                ? focusedItem.path
                : options.resetPreview
                  ? ''
                  : current.downloadPath,
            status: options.statusMessage || `已载入目录 ${nextDirectory}`,
            error: '',
          }
        })

        return entries
      } catch (error) {
        console.error(error)
        updateFileManagerSession((current) => ({
          ...current,
          browsing: false,
          entriesLoaded: true,
          error: error.message || '目录读取失败',
        }))
        return []
      }
    },
    [
      clusterContext,
      fileManagerSession?.resource,
      fileManagerSession?.uploadDirectory,
      revokeFileManagerObjectUrl,
      updateFileManagerSession,
    ],
  )

  const handleOpenFileManagerRow = async (row) => {
    if (!row || !fileManagerSession?.resource) return

    const targetPath = resolveFileManagerPath(row.path || row.name, fileManagerSession.uploadDirectory)

    if (row.kind === 'parent' || row.kind === 'directory') {
      await loadFileManagerDirectory(targetPath, {
        resetPreview: true,
        statusMessage: row.kind === 'parent' ? `已返回 ${targetPath}` : `已进入目录 ${targetPath}`,
      })
      return
    }

    updateFileManagerSession((current) => ({
      ...current,
      activeItem: {
        ...row,
        path: targetPath,
      },
      detailVisible: false,
      downloadPath: targetPath,
      previewContent: current.activeItem?.path === targetPath ? current.previewContent : '',
      previewDraft: current.activeItem?.path === targetPath ? current.previewDraft : '',
      previewMode: current.activeItem?.path === targetPath ? current.previewMode : 'preview',
      reading: false,
      error: '',
      status: isTextPreviewableFile(row.name)
        ? '可在操作列中选择预览、编辑或下载。'
        : '可在操作列中选择预览或下载。',
    }))
  }

  const handlePreviewFileManagerRow = async (row) => {
    if (!row || !fileManagerSession?.resource) return

    if (row.kind === 'parent' || row.kind === 'directory') {
      await handleOpenFileManagerRow(row)
      return
    }

    if (!clusterContext) {
      updateFileManagerSession((current) => ({
        ...current,
        error: '缺少集群上下文，无法预览文件。',
      }))
      return
    }

    const targetPath = resolveFileManagerPath(row.path || row.name, fileManagerSession.uploadDirectory)
    let previewObjectUrl = ''

    updateFileManagerSession((current) => {
      if (!current) return current
      previewObjectUrl = current.previewObjectUrl || ''

      return {
        ...current,
        activeItem: {
          ...row,
          path: targetPath,
        },
        detailVisible: true,
        downloadPath: targetPath,
        previewMode: 'preview',
        previewing: true,
        reading: false,
        previewContent: '',
        previewDraft: '',
        previewObjectUrl: '',
        previewObjectType: '',
        error: '',
        status: `正在打开 ${row.name} 的预览...`,
      }
    })

    revokeFileManagerObjectUrl(previewObjectUrl)

    try {
      if (isTextPreviewableFile(row.name)) {
        const result = await readFileFromPod(
          {
            appName: fileManagerSession.resource.name,
            remotePath: targetPath,
          },
          clusterContext,
        )

        updateFileManagerSession((current) => ({
          ...current,
          previewing: false,
          activeItem: {
            ...row,
            path: targetPath,
            size: Number.isFinite(result.size) ? result.size : row.size,
            updatedAt: result.updatedAt || row.updatedAt,
          },
          previewContent: result.content,
          previewDraft: result.content,
          status: `已在文件管理窗口内打开 ${row.name}`,
          error: '',
        }))
        return
      }

      const result = await downloadFileFromPod(
        {
          appName: fileManagerSession.resource.name,
          remotePath: targetPath,
        },
        clusterContext,
      )

      const objectUrl = URL.createObjectURL(result.blob)
      updateFileManagerSession((current) => ({
        ...current,
        previewing: false,
        activeItem: {
          ...row,
          path: targetPath,
          size: result.blob?.size || row.size,
        },
        previewObjectUrl: objectUrl,
        previewObjectType: result.blob?.type || '',
        status: `已在文件管理窗口内打开 ${row.name}`,
        error: '',
      }))
    } catch (error) {
      console.error(error)
      updateFileManagerSession((current) => ({
        ...current,
        previewing: false,
        previewContent: '',
        previewDraft: '',
        previewObjectUrl: '',
        previewObjectType: '',
        error: error.message || '文件预览失败',
        status: error.message || '文件预览失败',
      }))
    }
  }

  const handleEditFileManagerRow = async (row) => {
    if (!row || !fileManagerSession?.resource) return

    if (row.kind === 'parent' || row.kind === 'directory') {
      await handleOpenFileManagerRow(row)
      return
    }

    if (!clusterContext) {
      updateFileManagerSession((current) => ({
        ...current,
        error: '缺少集群上下文，无法读取文件。',
      }))
      return
    }

    if (!isTextPreviewableFile(row.name)) {
      updateFileManagerSession((current) => ({
        ...current,
        activeItem: {
          ...row,
          path: resolveFileManagerPath(row.path || row.name, current.uploadDirectory),
        },
        detailVisible: false,
        previewContent: '',
        previewDraft: '',
        previewMode: 'preview',
        reading: false,
        error: '当前文件不支持在线编辑。',
        status: '当前文件暂不支持在线编辑，可尝试预览或直接下载。',
      }))
      return
    }

    const targetPath = resolveFileManagerPath(row.path || row.name, fileManagerSession.uploadDirectory)
    let previewObjectUrl = ''

    updateFileManagerSession((current) => {
      if (!current) return current
      previewObjectUrl = current.previewObjectUrl || ''

      return {
        ...current,
        activeItem: {
          ...row,
          path: targetPath,
        },
        detailVisible: true,
        downloadPath: targetPath,
        reading: true,
        previewMode: 'edit',
        previewObjectUrl: '',
        previewObjectType: '',
        error: '',
        status: `正在载入 ${row.name} 以便编辑...`,
      }
    })

    revokeFileManagerObjectUrl(previewObjectUrl)

    try {
      const result = await readFileFromPod(
        {
          appName: fileManagerSession.resource.name,
          remotePath: targetPath,
        },
        clusterContext,
      )

      updateFileManagerSession((current) => ({
        ...current,
        activeItem: {
          ...row,
          path: targetPath,
          size: Number.isFinite(result.size) ? result.size : row.size,
          updatedAt: result.updatedAt || row.updatedAt,
        },
        downloadPath: targetPath,
        reading: false,
        previewContent: result.content,
        previewDraft: result.content,
        previewMode: 'edit',
        status: `正在编辑 ${row.name}`,
        error: '',
      }))
    } catch (error) {
      console.error(error)
      updateFileManagerSession((current) => ({
        ...current,
        reading: false,
        previewContent: '',
        previewDraft: '',
        previewMode: 'edit',
        error: error.message || '文件读取失败',
        status: error.message || '文件读取失败',
      }))
    }
  }

  const handleJumpToDirectory = () => {
    if (!fileManagerSession) return
    const nextDirectory = resolveFileManagerPath(
      fileManagerSession.directoryInput,
      fileManagerSession.uploadDirectory,
    )
    loadFileManagerDirectory(nextDirectory, {
      resetPreview: true,
      statusMessage: `已进入目录 ${nextDirectory}`,
    })
  }

  const handleFileSelection = (event) => {
    const nextFile = event.target.files?.[0] || null
    updateFileManagerSession((current) => ({
      ...current,
      selectedFile: nextFile,
      selectedAt: nextFile ? new Date().toISOString() : '',
      error: '',
      status: nextFile ? `已选择 ${nextFile.name}` : current.status,
    }))
  }

  const handleUploadFile = async () => {
    if (!fileManagerSession?.resource) return
    if (!clusterContext) {
      updateFileManagerSession((current) => ({ ...current, error: '缺少集群上下文，无法上传文件。' }))
      return
    }
    if (!fileManagerSession.selectedFile) {
      updateFileManagerSession((current) => ({ ...current, error: '请先选择要上传的文件。' }))
      return
    }

    const targetDirectory = resolveFileManagerPath(fileManagerSession.uploadDirectory, fileManagerSession.uploadDirectory)

    updateFileManagerSession((current) => ({
      ...current,
      uploading: true,
      error: '',
      status: `正在上传 ${current.selectedFile.name}...`,
    }))

    try {
      const result = await uploadFileToPod(
        {
          appName: fileManagerSession.resource.name,
          file: fileManagerSession.selectedFile,
          targetDirectory,
        },
        clusterContext,
      )

      const uploadedRemotePath = resolveFileManagerPath(
        result.remotePath || buildRemoteFilePath(targetDirectory, fileManagerSession.selectedFile.name),
        targetDirectory,
      )

      updateFileManagerSession((current) => ({
        ...current,
        uploading: false,
        selectedFile: null,
        selectedAt: '',
        status: `上传成功：${uploadedRemotePath}`,
        lastUploadedPath: uploadedRemotePath,
        lastUploadedFileName: current.selectedFile?.name || getPathLeafName(uploadedRemotePath),
        lastUploadedSize: current.selectedFile?.size || 0,
        lastUploadedAt: new Date().toISOString(),
        downloadPath: uploadedRemotePath,
      }))
      setMessage(`文件已上传到 ${uploadedRemotePath}`)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }

      await loadFileManagerDirectory(targetDirectory, {
        focusPath: uploadedRemotePath,
        statusMessage: `上传成功：${uploadedRemotePath}`,
      })
    } catch (error) {
      console.error(error)
      updateFileManagerSession((current) => ({
        ...current,
        uploading: false,
        error: error.message || '文件上传失败',
      }))
    }
  }

  const handleDownloadFile = async (remotePathOverride = '') => {
    if (!fileManagerSession?.resource) return
    if (!clusterContext) {
      updateFileManagerSession((current) => ({ ...current, error: '缺少集群上下文，无法下载文件。' }))
      return
    }

    const targetPath = resolveFileManagerPath(
      remotePathOverride || fileManagerSession.downloadPath.trim() || fileManagerSession.activeItem?.path || '',
      fileManagerSession.uploadDirectory,
    )
    if (!targetPath || targetPath === '/') {
      updateFileManagerSession((current) => ({ ...current, error: '请先选择要下载的文件。' }))
      return
    }

    updateFileManagerSession((current) => ({
      ...current,
      downloading: true,
      error: '',
      downloadPath: targetPath,
      status: `正在下载 ${targetPath}...`,
    }))

    try {
      const result = await downloadFileFromPod(
        {
          appName: fileManagerSession.resource.name,
          remotePath: targetPath,
        },
        clusterContext,
      )

      const objectUrl = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = result.fileName || fileManagerSession.resource.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)

      updateFileManagerSession((current) => ({
        ...current,
        downloading: false,
        status: `下载成功：${targetPath}`,
        lastDownloadedPath: targetPath,
        lastDownloadedFileName: result.fileName || getPathLeafName(targetPath),
        lastDownloadedSize: result.blob?.size || 0,
        lastDownloadedAt: new Date().toISOString(),
      }))
      setMessage(`文件 ${result.fileName} 已开始下载`)
    } catch (error) {
      console.error(error)
      updateFileManagerSession((current) => ({
        ...current,
        downloading: false,
        error: error.message || '文件下载失败',
      }))
    }
  }

  const handleSaveFileManagerContent = async () => {
    const activeItem = fileManagerSession?.activeItem
    if (!fileManagerSession?.resource || !activeItem) return

    if (!clusterContext) {
      updateFileManagerSession((current) => ({
        ...current,
        error: '缺少集群上下文，无法保存文件。',
      }))
      return
    }

    if (!isTextPreviewableFile(activeItem.name)) {
      updateFileManagerSession((current) => ({
        ...current,
        error: '当前文件不支持在线编辑。',
      }))
      return
    }

    updateFileManagerSession((current) => ({
      ...current,
      saving: true,
      error: '',
      status: `正在保存 ${activeItem.name}...`,
    }))

    try {
      const result = await saveFileToPod(
        {
          appName: fileManagerSession.resource.name,
          remotePath: activeItem.path,
          content: fileManagerSession.previewDraft,
        },
        clusterContext,
      )

      const nextUpdatedAt = result.updatedAt || new Date().toISOString()

      updateFileManagerSession((current) => ({
        ...current,
        saving: false,
        previewContent: current.previewDraft,
        previewMode: 'edit',
        status: `保存成功：${activeItem.path}`,
        entries: current.entries.map((entry) =>
          entry.path === activeItem.path
            ? {
                ...entry,
                size: result.size,
                updatedAt: nextUpdatedAt,
              }
            : entry,
        ),
        activeItem:
          current.activeItem?.path === activeItem.path
            ? {
                ...current.activeItem,
                size: result.size,
                updatedAt: nextUpdatedAt,
              }
            : current.activeItem,
      }))
      setMessage(`文件已保存：${activeItem.path}`)
    } catch (error) {
      console.error(error)
      updateFileManagerSession((current) => ({
        ...current,
        saving: false,
        error: error.message || '文件保存失败',
      }))
    }
  }

  useEffect(() => {
    if (!fileManagerSession?.resource || fileManagerSession.entriesLoaded || fileManagerSession.browsing) return

    loadFileManagerDirectory(fileManagerSession.uploadDirectory, {
      resetPreview: true,
      statusMessage: `已载入目录 ${normalizeDirectoryPath(fileManagerSession.uploadDirectory)}`,
    })
  }, [
    fileManagerSession?.browsing,
    fileManagerSession?.entriesLoaded,
    fileManagerSession?.resource,
    fileManagerSession?.uploadDirectory,
    loadFileManagerDirectory,
  ])

  const handleToggleDevboxState = async (item) => {
    if (!clusterContext) {
      setMessage('缺少集群上下文，无法更新 DevBox 状态')
      return
    }

    const nextState = isPausedStatus(item.status) ? 'Running' : 'Paused'
    const actionLabel = nextState === 'Paused' ? '暂停' : '启动'
    setActionMenuId('')

    try {
      const payload = {
        yaml: {
          ...(item.yaml || {}),
          metadata: {
            ...(item.yaml?.metadata || {}),
          },
          spec: {
            ...(item.yaml?.spec || {}),
            state: nextState,
          },
        },
      }
      const updatedDevbox = await updateResource('devbox', item.name, payload, clusterContext)
      setResources((current) => ({
        ...current,
        devbox: current.devbox.map((entry) => (entry.name === item.name ? updatedDevbox : entry)),
      }))
      setMessage(`已${actionLabel} ${item.name}`)
    } catch (error) {
      console.error(error)
      setMessage(error.message || `${actionLabel}失败`)
    }
  }

  const updateChatSession = (updater) => {
    setChatSession((current) => {
      if (!current) return current
      return typeof updater === 'function' ? updater(current) : updater
    })
  }

  const ensureChatConnection = (resource) => {
    if (chatConnectionRef.current) {
      return chatConnectionRef.current
    }

    const connection = createOpenAIChatConnection({
      apiUrl: resource.apiUrl,
      apiKey: resource.apiKey,
      preferredTransport: CHAT_TRANSPORT.sse,
      onEvent: (event) => {
        if (event.type === 'open') {
          updateChatSession((current) => ({ ...current, status: 'connected', transport: event.transport, error: '' }))
          return
        }

        if (event.type === 'fallback') {
          updateChatSession((current) => ({
            ...current,
            status: 'connecting',
            transport: event.transport,
            error: 'WebSocket 不可用，已自动切换到 SSE。',
          }))
          return
        }

        if (event.type === 'message') {
          const chunk =
            event.payload?.choices?.[0]?.delta?.content ||
            event.payload?.choices?.[0]?.message?.content ||
            event.payload?.content ||
            event.payload?.message ||
            ''

          if (!chunk) return

          updateChatSession((current) => {
            const messages = [...current.messages]
            const lastMessage = messages[messages.length - 1]
            if (lastMessage?.role === 'assistant' && lastMessage.streaming) {
              messages[messages.length - 1] = {
                ...lastMessage,
                content: `${lastMessage.content}${chunk}`,
              }
            } else {
              messages.push({
                id: `assistant-${Date.now()}`,
                role: 'assistant',
                content: chunk,
                createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
                streaming: true,
              })
            }

            return {
              ...current,
              status: 'connected',
              transport: event.transport,
              error: '',
              messages,
            }
          })
          return
        }

        if (event.type === 'done' || event.type === 'close') {
          updateChatSession((current) => ({
            ...current,
            status: 'connected',
            messages: current.messages.map((message) => ({ ...message, streaming: false })),
          }))
          return
        }

        if (event.type === 'error') {
          updateChatSession((current) => ({
            ...current,
            status: 'error',
            error: event.error?.message || '连接失败，请检查 API 地址和 Key。',
          }))
        }
      },
    })

    chatConnectionRef.current = connection
    return connection
  }

  const sendChatMessage = async () => {
    if (!chatSession) return

    const draft = chatSession.draft.trim()
    if (!draft) return

    if (!chatSession.resource.apiUrl) {
      updateChatSession((current) => ({ ...current, status: 'error', error: '当前资源缺少 API 地址，无法发起对话。' }))
      return
    }

    if (!chatSession.resource.apiKey) {
      updateChatSession((current) => ({ ...current, status: 'error', error: '当前资源缺少 API Key，无法发起对话。' }))
      return
    }

    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: draft,
      createdAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    }

    const nextMessages = [...chatSession.messages, userMessage]
    const candidateApiUrls = chatSession.resource.chatApiCandidates?.length
      ? chatSession.resource.chatApiCandidates
      : [chatSession.resource.apiUrl]

    updateChatSession((current) => ({
      ...current,
      draft: '',
      status: 'connecting',
      error: '',
      messages: nextMessages,
      triedApiUrls: [],
    }))

    let lastError = null

    for (const candidateApiUrl of candidateApiUrls) {
      try {
        chatConnectionRef.current?.close()
        chatConnectionRef.current = null

        updateChatSession((current) => ({
          ...current,
          resource: {
            ...current.resource,
            apiUrl: candidateApiUrl,
          },
          triedApiUrls: [...current.triedApiUrls, candidateApiUrl],
        }))

        const connection = ensureChatConnection({
          ...chatSession.resource,
          apiUrl: candidateApiUrl,
        })

        await connection.send({
          model: 'hermes-agent',
          messages: nextMessages
            .filter((message) => ['user', 'assistant', 'system'].includes(message.role))
            .map((message) => ({ role: message.role, content: message.content })),
        })
        return
      } catch (error) {
        lastError = error
      }
    }

    updateChatSession((current) => ({
      ...current,
      status: 'error',
      error: lastError?.message || '发送失败，请检查 API 地址和 Key。',
    }))
  }

  const handleChatInputKeyDown = async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      await sendChatMessage()
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setSubmitting(true)

    try {
      const submittedBlueprint =
        formMode === 'create'
          ? {
              ...blueprint,
              appName: ensureDns1035Name(blueprint.appName, createType === 'openclaw' ? 'openclaw' : 'agent'),
            }
          : blueprint

      if (submittedBlueprint.appName !== blueprint.appName) {
        setBlueprint((current) => ({ ...current, appName: submittedBlueprint.appName }))
      }

      const payloads = buildResourcePayloads(submittedBlueprint, clusterContext)

      if (formMode === 'create') {
        const createdDevbox = await createResource('devbox', payloads.devbox, clusterContext)
        const createdService = await createResource('service', payloads.service, clusterContext)
        const createdIngress = await createResource('ingress', payloads.ingress, clusterContext)
        setResources((current) => ({
          devbox: [createdDevbox, ...current.devbox.filter((item) => item.name !== createdDevbox.name)],
          service: [createdService, ...current.service.filter((item) => item.name !== createdService.name)],
          ingress: [createdIngress, ...current.ingress.filter((item) => item.name !== createdIngress.name)],
        }))
        setActiveType('devbox')
        setMessage(`已统一创建 ${submittedBlueprint.appName} 对应的 DevBox / Service / Ingress`)
      } else {
        const updatedDevbox = await updateResource('devbox', editingGroup.devbox.name, payloads.devbox, clusterContext)
        const updatedService = await updateResource('service', editingGroup.service.name, payloads.service, clusterContext)
        const updatedIngress = await updateResource('ingress', editingGroup.ingress.name, payloads.ingress, clusterContext)
        setResources((current) => ({
          devbox: current.devbox.map((item) => (item.id === updatedDevbox.id ? updatedDevbox : item)),
          service: current.service.map((item) => (item.id === updatedService.id ? updatedService : item)),
          ingress: current.ingress.map((item) => (item.id === updatedIngress.id ? updatedIngress : item)),
        }))
        setMessage(`已统一更新 ${submittedBlueprint.appName} 对应的 DevBox / Service / Ingress`)
      }
      closeForm()
      await loadAll()
    } catch (error) {
      console.error(error)
      setMessage(error.message || '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDelete = async (item) => {
    const itemYaml = item?.yaml || {}
    const itemLabels = itemYaml?.metadata?.labels || {}
    const appLabel =
      itemLabels?.app ||
      itemYaml?.spec?.selector?.app ||
      itemYaml?.spec?.rules?.[0]?.http?.paths?.[0]?.backend?.service?.name ||
      item.name
    const agentLabel = itemLabels?.['agent.sealos.io/name'] || clusterContext?.agentLabel || ''

    const sameLabel = (entry) => {
      const labels = entry?.yaml?.metadata?.labels || {}
      if ((labels?.app || '') !== appLabel) return false
      if (agentLabel && (labels?.['agent.sealos.io/name'] || '') !== agentLabel) return false
      return true
    }

    const targets = [
      ...resources.devbox.filter(sameLabel).map((entry) => ({ type: 'devbox', name: entry.name })),
      ...resources.service.filter(sameLabel).map((entry) => ({ type: 'service', name: entry.name })),
      ...resources.ingress.filter(sameLabel).map((entry) => ({ type: 'ingress', name: entry.name })),
    ]

    const dedupedTargets = Array.from(new Map(targets.map((target) => [`${target.type}:${target.name}`, target])).values())
    const deleteTargets = dedupedTargets.length ? dedupedTargets : [{ type: activeType, name: item.name }]
    const order = { ingress: 0, service: 1, devbox: 2 }
    deleteTargets.sort((a, b) => (order[a.type] ?? 99) - (order[b.type] ?? 99))

    const confirmed = window.confirm(`确认联动删除 ${deleteTargets.length} 个资源吗？`)
    if (!confirmed) return

    setActionMenuId('')

    try {
      const failed = []
      for (const target of deleteTargets) {
        try {
          await deleteResource(target.type, target.name, clusterContext)
        } catch (error) {
          failed.push(`${target.type}/${target.name}: ${error?.message || '删除失败'}`)
        }
      }

      if (failed.length) {
        throw new Error(`部分删除失败：${failed.join('; ')}`)
      }

      setMessage(`已联动删除 ${deleteTargets.length} 个资源`)
      await loadAll()
    } catch (error) {
      setMessage(error.message || '删除失败')
    }
  }

  const showEmptyState = false

  return (
    <div className="h-screen w-screen overflow-hidden bg-white text-[#111827]">
      <div className="flex h-full w-full flex-col bg-white">
        <header className="flex flex-col gap-5 px-8 pb-6 pt-7 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="text-[34px] font-semibold tracking-[-0.03em] text-[#111827]">AgentHub</div>
            <button
              className="inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-[#2563eb] transition hover:bg-[#eff6ff]"
              onClick={() => window.open(config.docUrl, '_blank', 'noopener,noreferrer')}
              type="button"
            >
              <BookIcon />
              文档
            </button>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex h-11 w-full items-center gap-3 rounded-[16px] border border-[#eceef3] bg-white px-4 text-sm text-[#9ca3af] lg:w-[320px]">
              <SearchIcon />
              <input
                className="h-full flex-1 border-0 bg-transparent text-sm text-[#111827] outline-none placeholder:text-[#9ca3af]"
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索备注名、labels id、类型或状态"
                value={keyword}
              />
            </div>

            <button
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[16px] bg-[#111111] px-5 text-sm font-medium text-white transition hover:bg-black"
              onClick={openCreate}
              type="button"
            >
              <PlusIcon />
              新建Agent
            </button>
          </div>
        </header>

        <div className="flex-1 px-8 pb-8">
          <section className="relative h-[calc(100vh-120px)] min-h-[620px] overflow-hidden rounded-[30px] border border-dashed border-[#e6eaf0] bg-[linear-gradient(180deg,#ffffff_0%,#fcfcfd_100%)]">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[280px] bg-[radial-gradient(circle_at_center,rgba(59,130,246,0.04),transparent_58%)]" />
            <div className="pointer-events-none absolute left-1/2 top-[42%] h-[320px] w-[720px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(15,23,42,0.03),transparent_68%)]" />
            <div className="pointer-events-none absolute left-1/2 top-[44%] h-[220px] w-[560px] -translate-x-1/2 -translate-y-1/2 [background-image:linear-gradient(to_right,rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(to_bottom,rgba(148,163,184,0.12)_1px,transparent_1px)] [background-size:28px_28px] [transform:translate(-50%,-50%)_perspective(900px)_rotateX(73deg)]" />

            {showEmptyState ? (
              <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center">
                <div className="relative h-[232px] w-[420px] max-w-full">
                  <div className="absolute left-1/2 top-[22px] flex h-[92px] w-[92px] -translate-x-1/2 items-center justify-center rounded-[30px] border border-white/80 bg-white shadow-[0_20px_50px_rgba(15,23,42,0.08)]">
                    <CodeCubeIcon />
                  </div>
                  <FloatingBadge className="left-[34px] top-[38px] shadow-[0_14px_32px_rgba(15,23,42,0.05)]">
                    <TinyGridIcon />
                  </FloatingBadge>
                  <FloatingBadge className="right-[28px] top-[34px] shadow-[0_14px_32px_rgba(15,23,42,0.05)]">
                    <LayersIcon />
                  </FloatingBadge>
                  <FloatingBadge className="left-[70px] bottom-[48px] shadow-[0_14px_32px_rgba(15,23,42,0.05)]">
                    <VsCodeGlyph />
                  </FloatingBadge>
                  <FloatingBadge className="right-[88px] bottom-[56px] shadow-[0_14px_32px_rgba(15,23,42,0.05)]">
                    <CubeIcon />
                  </FloatingBadge>
                  <FloatingBadge className="right-[4px] top-[116px] shadow-[0_14px_32px_rgba(15,23,42,0.05)]">
                    <PlayGlyph />
                  </FloatingBadge>
                </div>

                <h2 className="mt-3 text-[30px] font-semibold tracking-[-0.03em] text-[#111827]">创建您的第一个 Agent</h2>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[16px] bg-[#111111] px-5 text-sm font-medium text-white transition hover:bg-black"
                    onClick={openCreate}
                    type="button"
                  >
                    <PlusIcon />
                    新建Agent
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative z-10 h-full p-6 lg:p-8">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[20px] font-semibold text-[#111827]">Agent 实例</div>
                    <div className="mt-1 text-sm text-[#6b7280]">列表仅显示当前 namespace 下的真实资源，并按 Agent 标签聚合操作。</div>
                  </div>
                </div>

                <div className="mb-4 flex gap-3 overflow-x-auto pb-1 opacity-0 pointer-events-none h-0 overflow-hidden">
                  {Object.keys(resourceMeta).map((type) => {
                    const active = type === activeType
                    return (
                      <button
                        key={type}
                        className={`inline-flex items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-sm transition ${
                          active
                            ? 'bg-[#111111] text-white'
                            : 'bg-[#f5f7fb] text-[#4b5563] hover:bg-[#eef2f7]'
                        }`}
                        onClick={() => setActiveType(type)}
                        type="button"
                      >
                        <span>{resourceMeta[type].title}</span>
                        <span className={`rounded-full px-2 py-0.5 text-xs ${active ? 'bg-white/15 text-white' : 'bg-white text-[#6b7280]'}`}>
                          {resources[type].length}
                        </span>
                      </button>
                    )
                  })}
                </div>

                <div className="h-[calc(100%-104px)] overflow-auto rounded-[24px] border border-[#eceef3] bg-white">
                  <table className="min-w-full text-left text-sm">
                    <thead className="sticky top-0 bg-[#fafbfc] text-[#6b7280]">
                      <tr>
                        <th className="px-5 py-4 font-medium">备注名</th>
                        <th className="px-5 py-4 font-medium">类型</th>
                        <th className="px-5 py-4 font-medium">状态</th>
                        <th className="px-5 py-4 font-medium">更新时间</th>
                        <th className="px-5 py-4 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading ? (
                        <tr>
                          <td className="px-5 py-8 text-center text-[#6b7280]" colSpan="5">
                            正在加载数据...
                          </td>
                        </tr>
                      ) : filteredItems.length ? (
                        filteredItems.map((item) => {
                          const productMeta = item.productMeta || PRODUCT_META['hermes-agent']
                          const nextToggleLabel = isPausedStatus(item.status) ? '启动' : '暂停'
                          return (
                            <tr key={item.id} className="border-t border-[#f1f3f7] text-[#111827]">
                              <td className="px-5 py-4 align-top">
                                <div className="font-medium">{item.name}</div>
                                <div className="mt-1 text-xs text-[#9ca3af]">labels id: {item.labelId || '--'}</div>
                              </td>
                              <td className="px-5 py-4 align-top">
                                <div className="flex items-center gap-3">
                                  <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-[14px] border border-[#eceef3] bg-[#f8fafc]">
                                    <img alt={`${productMeta.label} logo`} className="h-8 w-8 object-cover" src={productMeta.logo} />
                                  </div>
                                  <div>
                                    <div className="font-medium text-[#111827]">{productMeta.label}</div>
                                    <div className="mt-1 text-xs text-[#9ca3af]">Logo</div>
                                  </div>
                                </div>
                              </td>
                              <td className="px-5 py-4 align-top">
                                <StatusBadge status={item.status} />
                              </td>
                              <td className="px-5 py-4 align-top text-[#6b7280]">{item.updatedAt}</td>
                              <td className="px-5 py-4 align-top">
                                <div className="flex justify-end gap-2">
                                  <button
                                    className="rounded-full bg-[#eff6ff] px-3 py-1.5 text-xs text-[#2563eb] hover:bg-[#dbeafe]"
                                    onClick={() => openChat(item)}
                                    type="button"
                                  >
                                    对话
                                  </button>
                                  <button
                                    className="rounded-full bg-[#ecfeff] px-3 py-1.5 text-xs text-[#0f766e] hover:bg-[#cffafe]"
                                    onClick={() => openTerminal(item)}
                                    type="button"
                                  >
                                    终端
                                  </button>
                                  <button
                                    className="rounded-full bg-[#f8fafc] px-3 py-1.5 text-xs text-[#475569] hover:bg-[#f1f5f9]"
                                    onClick={() => openEdit(item)}
                                    type="button"
                                  >
                                    配置
                                  </button>
                                  <div className="relative" data-action-menu-root="true">
                                    <button
                                      className="rounded-full bg-[#f8fafc] px-3 py-1.5 text-xs text-[#475569] hover:bg-[#f1f5f9]"
                                      onClick={() => setActionMenuId((current) => (current === item.id ? '' : item.id))}
                                      type="button"
                                    >
                                      更多
                                    </button>
                                    {actionMenuId === item.id && (
                                      <div className="absolute right-0 z-20 mt-2 w-40 rounded-[18px] border border-[#eceef3] bg-white p-2 shadow-[0_16px_40px_rgba(15,23,42,0.12)]">
                                        <button
                                          className="w-full rounded-[12px] px-3 py-2 text-left text-sm text-[#111827] transition hover:bg-[#f8fafc]"
                                          onClick={() => openKeyDialog(item)}
                                          type="button"
                                        >
                                          密钥
                                        </button>
                                        <button
                                          className="w-full rounded-[12px] px-3 py-2 text-left text-sm text-[#111827] transition hover:bg-[#f8fafc]"
                                          onClick={() => openFileManager(item)}
                                          type="button"
                                        >
                                          文件管理
                                        </button>
                                        <button
                                          className="w-full rounded-[12px] px-3 py-2 text-left text-sm text-[#111827] transition hover:bg-[#f8fafc]"
                                          onClick={() => handleToggleDevboxState(item)}
                                          type="button"
                                        >
                                          {nextToggleLabel}
                                        </button>
                                        <button
                                          className="w-full rounded-[12px] px-3 py-2 text-left text-sm text-[#dc2626] transition hover:bg-[#fff1f2]"
                                          onClick={() => handleDelete(item)}
                                          type="button"
                                        >
                                          删除
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )
                        })
                      ) : (
                        <tr>
                          <td className="px-5 py-8 text-center text-[#6b7280]" colSpan="5">
                            没有搜索到匹配资源
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {createTypeOpen && (
        <AgentWindow
          description="选择一个产品类型后进入配置表单，关闭时会清理当前创建步骤。"
          onClose={closeCreateType}
          title="选择创建类型"
          bodyClassName="overflow-y-auto"
        >
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <button
                className={`rounded-[18px] border px-4 py-4 text-left transition ${
                  createType === 'hermes-agent'
                    ? 'border-[#111827] bg-[#f8fafc] shadow-[inset_0_0_0_1px_rgba(17,24,39,0.15)]'
                    : 'border-[#e5e7eb] bg-white hover:border-[#d1d5db]'
                }`}
                onClick={() => setCreateType('hermes-agent')}
                type="button"
              >
                <div className="flex items-center gap-3">
                  <img alt="Hermes Agent 官方 Logo" className="h-9 w-9 rounded-lg object-cover" src={hermesAgentLogo} />
                  <div>
                    <div className="text-sm font-semibold text-[#111827]">创建 Hermes Agent</div>
                    <div className="mt-1 text-xs text-[#6b7280]">立即可用，进入下一步填写资源配置。</div>
                  </div>
                </div>
              </button>

              <button
                className="cursor-not-allowed rounded-[18px] border border-[#e5e7eb] bg-[#f9fafb] px-4 py-4 text-left opacity-70"
                disabled
                type="button"
              >
                <div className="flex items-center gap-3">
                  <img alt="OpenClaw 官方 Logo" className="h-9 w-9 rounded-lg object-cover" src={openclawLogo} />
                  <div>
                    <div className="flex items-center gap-2 text-sm font-semibold text-[#6b7280]">
                      创建 OpenClaw
                      <span className="rounded-full bg-[#eef2ff] px-2 py-0.5 text-[10px] text-[#6366f1]">后续开放</span>
                    </div>
                    <div className="mt-1 text-xs text-[#9ca3af]">该能力暂不可选，敬请期待。</div>
                  </div>
                </div>
              </button>
            </div>

            <button
              className="inline-flex h-11 w-full items-center justify-center rounded-[16px] bg-[#111111] text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
              disabled={createType !== 'hermes-agent'}
              onClick={proceedCreateType}
              type="button"
            >
              下一步
            </button>
          </div>
        </AgentWindow>
      )}

      {formOpen && (
        <AgentWindow
          description={
            formMode === 'create'
              ? '统一创建 DevBox / Service / Ingress，关闭时会重置当前表单。'
              : '编辑当前 Agent 资源组，关闭时会丢弃未保存的配置。'
          }
          onClose={closeForm}
          title={formMode === 'create' ? '统一创建资源' : `统一编辑 ${blueprint.appName}`}
          bodyClassName="overflow-y-auto"
        >
          <form className="space-y-5" onSubmit={handleSubmit}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="应用名（统一资源主键）">
                <input className="field-input bg-[#f9fafb]" readOnly value={blueprint.appName} />
              </Field>
              <Field label="命名空间">
                <input className="field-input bg-[#f9fafb]" readOnly value={blueprint.namespace} />
              </Field>
            </div>

            <div className="rounded-[24px] border border-[#eceef3] bg-[#fafbfc] p-4">
              <div className="mb-3 text-sm font-medium text-[#111827]">配置规格</div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {RESOURCE_PRESETS.map((preset) => {
                  const active = blueprint.profile === preset.id
                  return (
                    <button
                      key={preset.id}
                      className={`rounded-[18px] border px-4 py-4 text-left transition ${
                        active
                          ? 'border-[#111827] bg-white shadow-[inset_0_0_0_1px_rgba(17,24,39,0.12)]'
                          : 'border-[#e5e7eb] bg-white hover:border-[#d1d5db]'
                      }`}
                      onClick={() => handleProfileChange(preset.id)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-[#111827]">{preset.label}</div>
                        {active && <span className="rounded-full bg-[#111827] px-2 py-0.5 text-[10px] text-white">当前</span>}
                      </div>
                      <div className="mt-2 text-xs leading-5 text-[#6b7280]">{preset.description}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="CPU">
                <input
                  className={`field-input ${blueprint.profile !== 'custom' ? 'cursor-not-allowed bg-[#f9fafb] text-[#9ca3af]' : ''}`}
                  disabled={blueprint.profile !== 'custom'}
                  onChange={(event) => handleBlueprintChange('cpu', event.target.value)}
                  placeholder="例如 1000m"
                  value={blueprint.cpu}
                />
              </Field>
              <Field label="内存">
                <input
                  className={`field-input ${blueprint.profile !== 'custom' ? 'cursor-not-allowed bg-[#f9fafb] text-[#9ca3af]' : ''}`}
                  disabled={blueprint.profile !== 'custom'}
                  onChange={(event) => handleBlueprintChange('memory', event.target.value)}
                  placeholder="例如 2048Mi"
                  value={blueprint.memory}
                />
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-1">
              <Field label="存储限制">
                <input
                  className="field-input"
                  onChange={(event) => handleBlueprintChange('storageLimit', event.target.value)}
                  value={blueprint.storageLimit}
                />
              </Field>
            </div>

            <div className="hidden" aria-hidden="true">
              <input readOnly value={blueprint.image} />
              <input readOnly value={blueprint.port} />
              <input readOnly value={blueprint.user} />
              <input readOnly value={blueprint.workingDir} />
              <input readOnly value={blueprint.argsText} />
              <input readOnly value={blueprint.serviceType} />
              <input readOnly value={blueprint.protocol} />
              <input readOnly value={blueprint.apiKey} />
              <input readOnly value={blueprint.apiUrl} />
              <input readOnly value={blueprint.fullDomain} />
              <input readOnly value={blueprint.domainPrefix} />
            </div>

            <button
              className="inline-flex h-11 w-full items-center justify-center rounded-[16px] bg-[#111111] text-sm font-medium text-white transition hover:bg-black disabled:opacity-60"
              disabled={submitting}
              type="submit"
            >
              {submitting ? '提交中...' : formMode === 'create' ? '统一创建资源' : '统一保存资源'}
            </button>
          </form>
        </AgentWindow>
      )}

      {keySession && (
        <AgentWindow
          description="密钥不会在列表中直接展示，可在此窗口内查看与复制。关闭按钮会触发当前密钥窗口的清理逻辑。"
          onClose={closeKeyDialog}
          title={`密钥 · ${keySession.resource.name}`}
          bodyClassName="overflow-y-auto bg-[#f6f7fb]"
          panelClassName="border-[#e5e7eb] bg-white shadow-[0_28px_100px_rgba(15,23,42,0.16)]"
        >
          <div className="flex h-full min-h-0 flex-col gap-4">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
              <div className="rounded-[24px] border border-[#e5e7eb] bg-white p-5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1.5 text-[#111827]">
                    <CopyLineIcon className="h-4 w-4" />
                    API Key
                  </span>
                  <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-3 py-1.5 text-[#667085]">
                    <Dot />
                    labels id：{getLabelId(keySession.resource)}
                  </span>
                </div>

                <div className="mt-4 rounded-[20px] border border-[#e5e7eb] bg-[#0f172a] p-4">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-white/50">Secret Value</div>
                  <pre className="mt-3 whitespace-pre-wrap break-all text-sm leading-7 text-white">{keySession.resource.apiKey || '当前资源未读取到 API Key'}</pre>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    className="inline-flex h-10 items-center justify-center gap-2 rounded-[14px] bg-[#111827] px-4 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={!keySession.resource.apiKey}
                    onClick={() => handleCopy(keySession.resource.apiKey, 'API Key')}
                    type="button"
                  >
                    <CopyLineIcon className="h-4 w-4" />
                    复制密钥
                  </button>
                  <button
                    className="inline-flex h-10 items-center justify-center rounded-[14px] border border-[#d0d5dd] bg-white px-4 text-sm font-medium text-[#344054] transition hover:bg-[#f8fafc]"
                    onClick={closeKeyDialog}
                    type="button"
                  >
                    关闭
                  </button>
                </div>
              </div>

              <div className="rounded-[24px] border border-[#e5e7eb] bg-white p-5">
                <div className="text-sm font-semibold text-[#111827]">使用说明</div>
                <div className="mt-3 space-y-3 text-sm leading-7 text-[#667085]">
                  <p>列表页已隐藏 API 地址与密钥，只保留“更多 → 密钥”入口，避免在主表格中直接暴露敏感信息。</p>
                  <p>如果当前资源尚未注入 <code className="rounded bg-[#f4f6fb] px-1.5 py-0.5 text-[13px] text-[#111827]">API_SERVER_KEY</code>，这里会显示为空提示。</p>
                  <p>复制后可直接用于对话接入、外部客户端配置或手动排障。</p>
                </div>
              </div>
            </div>
          </div>
        </AgentWindow>
      )}

      {terminalSession && (
        <AgentWindow
          description="关闭窗口会自动断开终端连接，并执行当前会话的清理逻辑。"
          onClose={closeTerminal}
          title={`终端 · ${terminalSession.resource.name}`}
          bodyClassName="overflow-hidden bg-[#0a0c10] p-0"
          panelClassName="border-white/10 bg-[#0a0c10] shadow-[0_32px_120px_rgba(0,0,0,0.45)]"
          headerClassName="border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0))]"
          titleClassName="text-white"
          descriptionClassName="text-[#98a2b3]"
          closeButtonClassName="bg-white/5 text-[#d0d5dd] hover:bg-white/10"
        >
          <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_top,rgba(246,197,143,0.12),transparent_32%),linear-gradient(180deg,#0a0c10_0%,#080a0d_100%)]">
            <div className="border-b border-white/10 px-6 py-5">
              <div className="flex flex-wrap items-center gap-3">
                <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${getTerminalStatusClassName(terminalSession.status)}`}>
                  <span className="h-2 w-2 rounded-full bg-current opacity-80" />
                  {formatTerminalStatusText(terminalSession.status)}
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[#d0d5dd]">
                  备注 ID · {getLabelId(terminalSession.resource)}
                </span>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-[#98a2b3]">
                  输入会直接写入容器 Shell
                </span>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-3">
                <div className="rounded-[20px] border border-white/10 bg-white/5 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[#98a2b3]">Pod</div>
                  <div className="mt-2 break-all text-sm font-medium text-white">{terminalSession.podName || '--'}</div>
                </div>
                <div className="rounded-[20px] border border-white/10 bg-white/5 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[#98a2b3]">Container</div>
                  <div className="mt-2 break-all text-sm font-medium text-white">{terminalSession.containerName || '--'}</div>
                </div>
                <div className="rounded-[20px] border border-white/10 bg-white/5 px-4 py-3">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-[#98a2b3]">Namespace</div>
                  <div className="mt-2 break-all text-sm font-medium text-white">{terminalSession.namespace || '--'}</div>
                </div>
              </div>

              {terminalSession.error && (
                <div className="mt-4 rounded-[18px] border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
                  {terminalSession.error}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 px-6 pb-6 pt-4">
              <div className="relative flex h-full min-h-[320px] flex-col overflow-hidden rounded-[28px] border border-white/10 bg-[#05070a] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
                    <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
                    <span className="h-3 w-3 rounded-full bg-[#28c840]" />
                  </div>
                  <div className="text-xs text-[#98a2b3]">{terminalSession.resource.name}</div>
                </div>

                <div className="relative min-h-0 flex-1">
                  <div ref={terminalContainerRef} className="h-full w-full px-4 py-3" />

                  {(terminalSession.status === 'initializing' || terminalSession.status === 'connecting') && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[rgba(5,7,10,0.72)]">
                      <div className="rounded-[22px] border border-white/10 bg-[rgba(12,14,18,0.9)] px-5 py-4 text-center shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
                        <div className="mx-auto h-9 w-9 animate-spin rounded-full border-2 border-white/15 border-t-[#f6c58f]" />
                        <div className="mt-3 text-sm font-medium text-white">
                          {terminalSession.status === 'initializing' ? '终端界面加载中' : '正在建立容器连接'}
                        </div>
                        <div className="mt-1 text-xs text-[#98a2b3]">首次连接可能需要几秒，请稍候。</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </AgentWindow>
      )}

      {chatSession && (
        <AgentWindow
          description="关闭窗口会自动断开当前聊天连接。"
          onClose={closeChat}
          title={`对话 · ${chatSession.resource.name}`}
          bodyClassName="overflow-hidden"
        >
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="rounded-[20px] border border-[#eceef3] bg-[#fafbfc] p-4 text-sm text-[#4b5563]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#7c3aed]">
                  连接: {chatSession.transport === CHAT_TRANSPORT.websocket ? 'WebSocket' : 'SSE'}
                </span>
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#059669]">状态: {chatSession.status}</span>
                <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs text-[#6b7280]">
                  <Dot />
                  labels id：{getLabelId(chatSession.resource)}
                </span>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
                <div className="rounded-[18px] border border-[#e5e7eb] bg-white p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-[#98a2b3]">Ingress API 地址</div>
                  <div className="mt-2 rounded-[14px] border border-[#eef2f7] bg-[#f8fafc] px-3 py-3 font-mono text-xs leading-6 text-[#111827] break-all">
                    {chatSession.resource.apiUrl || '当前资源未读取到 API 地址'}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-[12px] border border-[#d0d5dd] bg-white px-3 text-xs font-medium text-[#344054] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={!chatSession.resource.apiUrl}
                      onClick={() => handleCopy(chatSession.resource.apiUrl, 'API 地址')}
                      type="button"
                    >
                      <CopyLineIcon className="h-4 w-4" />
                      复制地址
                    </button>
                  </div>
                </div>

                <div className="rounded-[18px] border border-[#e5e7eb] bg-white p-3">
                  <div className="text-[11px] uppercase tracking-[0.14em] text-[#98a2b3]">API Key</div>
                  <div className="mt-2 rounded-[14px] border border-[#eef2f7] bg-[#f8fafc] px-3 py-3 font-mono text-xs leading-6 text-[#111827] break-all">
                    {chatSession.resource.apiKey || '当前资源未读取到 API Key'}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <button
                      className="inline-flex h-9 items-center justify-center gap-2 rounded-[12px] border border-[#d0d5dd] bg-white px-3 text-xs font-medium text-[#344054] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={!chatSession.resource.apiKey}
                      onClick={() => handleCopy(chatSession.resource.apiKey, 'API Key')}
                      type="button"
                    >
                      <CopyLineIcon className="h-4 w-4" />
                      复制密钥
                    </button>
                  </div>
                </div>
              </div>

              {chatSession.error && <div className="mt-3 text-xs text-[#dc2626]">{chatSession.error}</div>}
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-[#eceef3] bg-white p-4">
              <div ref={chatMessagesRef} className="h-full overflow-y-auto pr-2" onScroll={handleChatScroll}>
                <div className="flex min-h-full flex-col justify-end gap-4">
                  {chatSession.messages.map((message) => {
                    const isUser = message.role === 'user'
                    return (
                      <div key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[85%] rounded-[20px] px-4 py-3 text-sm leading-6 ${
                            isUser ? 'bg-[#111827] text-white' : 'bg-[#f5f7fb] text-[#111827]'
                          }`}
                        >
                          <div className="whitespace-pre-wrap break-words">{message.content}</div>
                          <div className={`mt-2 text-[11px] ${isUser ? 'text-white/60' : 'text-[#9ca3af]'}`}>
                            {message.createdAt}
                            {message.streaming ? ' · 接收中...' : ''}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className="rounded-[24px] border border-[#eceef3] bg-white p-3">
              <div className="flex items-end gap-3">
                <textarea
                  className="h-[56px] flex-1 resize-none rounded-[18px] border border-[#e5e7eb] bg-[#fafafa] px-4 py-[15px] text-sm leading-6 text-[#111827] outline-none transition focus:border-[#2563eb] focus:bg-white"
                  onChange={(event) => updateChatSession((current) => ({ ...current, draft: event.target.value }))}
                  onKeyDown={handleChatInputKeyDown}
                  placeholder="请输入你的问题，消息会通过当前资源的 OpenAI API 地址发送。"
                  value={chatSession.draft}
                />
                <button
                  className="inline-flex h-[56px] items-center justify-center rounded-[18px] bg-[#111111] px-5 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!chatSession.draft.trim() || chatSession.status === 'connecting'}
                  onClick={sendChatMessage}
                  type="button"
                >
                  {chatSession.status === 'connecting' ? '发送中...' : '发送消息'}
                </button>
              </div>
            </div>
          </div>
        </AgentWindow>
      )}

      {fileManagerSession && (
        <AgentWindow
          description="目录浏览、上传、下载、预览与编辑都会在当前文件管理窗口内完成。"
          onClose={closeFileManager}
          title={`文件管理 · ${fileManagerSession.resource.name}`}
          bodyClassName="overflow-hidden bg-[#f6f7fb] p-0"
          panelClassName="border-[#e5e7eb] bg-white shadow-[0_28px_100px_rgba(15,23,42,0.16)]"
        >
          <div className="relative flex h-full min-h-0 flex-col bg-[#f6f7fb]">
            <div className="border-b border-[#e5e7eb] bg-white px-5 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1.5 text-xs text-[#111827]">
                  <ServerStackIcon />
                  <span className="font-medium">{fileManagerSession.resource.name}</span>
                </div>
                <div className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-3 py-1.5 text-xs text-[#667085]">
                  <Dot />
                  备注编号：{getLabelId(fileManagerSession.resource)}
                </div>
                <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1.5 text-xs text-[#667085]">
                  <FolderLineIcon />
                  <span className="max-w-[44vw] truncate">当前目录：{fileManagerSession.uploadDirectory}</span>
                </div>
              </div>

              <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
                <div className="flex min-w-0 items-center gap-2">
                  <button
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-[12px] border border-[#d0d5dd] bg-white px-3 text-xs font-medium text-[#344054] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={normalizeDirectoryPath(fileManagerSession.uploadDirectory) === '/'}
                    onClick={() =>
                      loadFileManagerDirectory(getParentDirectoryPath(fileManagerSession.uploadDirectory), {
                        resetPreview: true,
                        statusMessage: `已返回 ${getParentDirectoryPath(fileManagerSession.uploadDirectory)}`,
                      })
                    }
                    type="button"
                  >
                    上一级
                  </button>
                  <input
                    className="h-9 min-w-0 flex-1 rounded-[12px] border border-[#e5e7eb] bg-[#f8fafc] px-3 text-xs text-[#111827] outline-none transition placeholder:text-[#98a2b3] focus:border-[#cbd5e1] focus:bg-white"
                    onChange={(event) =>
                      updateFileManagerSession((current) => ({
                        ...current,
                        directoryInput: event.target.value,
                        error: '',
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        handleJumpToDirectory()
                      }
                    }}
                    placeholder="输入目录后点击进入"
                    value={fileManagerSession.directoryInput}
                  />
                  <button
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-[12px] bg-[#111827] px-3 text-xs font-medium text-white transition hover:bg-black"
                    onClick={handleJumpToDirectory}
                    type="button"
                  >
                    进入目录
                  </button>
                </div>

                <div className="flex min-w-0 items-center gap-2">
                  <label className="relative min-w-0 flex-1">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#98a2b3]">
                      <SearchIcon />
                    </span>
                    <input
                      className="h-9 w-full rounded-[12px] border border-[#e5e7eb] bg-[#f8fafc] pl-9 pr-3 text-xs text-[#111827] outline-none transition placeholder:text-[#98a2b3] focus:border-[#cbd5e1] focus:bg-white"
                      onChange={(event) =>
                        updateFileManagerSession((current) => ({
                          ...current,
                          searchKeyword: event.target.value,
                        }))
                      }
                      placeholder="搜索文件名或路径"
                      value={fileManagerSession.searchKeyword}
                    />
                  </label>
                  <button
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-[12px] border border-[#d0d5dd] bg-white px-3 text-xs font-medium text-[#344054] transition hover:bg-[#f8fafc]"
                    onClick={handlePickFile}
                    type="button"
                  >
                    选择文件
                  </button>
                  <button
                    className="inline-flex h-9 shrink-0 items-center justify-center rounded-[12px] bg-[#111827] px-3 text-xs font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={fileManagerSession.uploading || !fileManagerSession.selectedFile}
                    onClick={handleUploadFile}
                    type="button"
                  >
                    {fileManagerSession.uploading ? '上传中...' : '上传文件'}
                  </button>
                </div>
              </div>

              {fileManagerSession.selectedFile && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[14px] border border-dashed border-[#d0d5dd] bg-[#f8fafc] px-3 py-2 text-xs text-[#667085]">
                  <span className="rounded-full bg-[#eef2ff] px-2.5 py-1 text-[#4338ca]">待上传</span>
                  <span className="font-medium text-[#111827]">{fileManagerSession.selectedFile.name}</span>
                  <span>大小：{formatFileManagerSize(fileManagerSession.selectedFile.size)}</span>
                  <span className="max-w-full truncate">目标：{buildRemoteFilePath(fileManagerSession.uploadDirectory, fileManagerSession.selectedFile.name)}</span>
                  <button
                    className="inline-flex h-7 items-center justify-center rounded-[10px] border border-[#d0d5dd] bg-white px-2.5 text-[11px] font-medium text-[#344054] transition hover:bg-[#f8fafc]"
                    onClick={handleClearFileManagerSelection}
                    type="button"
                  >
                    清除
                  </button>
                </div>
              )}

              {fileManagerSession.lastUploadedPath && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[14px] border border-emerald-200 bg-[#ecfdf3] px-3 py-2 text-xs text-emerald-700">
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-medium text-emerald-700">上传成功</span>
                  <span className="font-medium text-emerald-900">{fileManagerSession.lastUploadedFileName || getPathLeafName(fileManagerSession.lastUploadedPath)}</span>
                  <span className="max-w-full truncate">位置：{fileManagerSession.lastUploadedPath}</span>
                  <span>大小：{formatFileManagerSize(fileManagerSession.lastUploadedSize)}</span>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 p-5">
              <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-white shadow-[0_12px_30px_rgba(15,23,42,0.04)]">
                <div className="grid grid-cols-[minmax(0,1.08fr)_220px_minmax(0,1.36fr)_96px_96px_136px] gap-3 border-b border-[#eef2f6] bg-[#f8fafc] px-4 py-3 text-[11px] font-semibold text-[#98a2b3]">
                  <div>名称</div>
                  <div>操作</div>
                  <div>路径</div>
                  <div>类型</div>
                  <div>大小</div>
                  <div>更新时间</div>
                </div>

                <div className="h-full min-h-0 overflow-y-auto">
                  {fileManagerSession.browsing ? (
                    <div className="flex h-full min-h-[260px] items-center justify-center px-6 py-10 text-sm text-[#667085]">
                      正在读取目录内容...
                    </div>
                  ) : fileManagerRows.length ? (
                    fileManagerRows.map((row) => {
                      const active = fileManagerSession.activeItem?.path === row.path && row.kind !== 'parent'
                      const helperText =
                        row.kind === 'parent'
                          ? '返回上一层目录'
                          : row.kind === 'directory'
                            ? '目录，点击名称可进入'
                            : isTextPreviewableFile(row.name)
                              ? '可在操作列中预览、编辑或下载'
                              : '可尝试预览或直接下载'

                      return (
                        <div
                          key={row.id}
                          className={`grid w-full grid-cols-[minmax(0,1.08fr)_220px_minmax(0,1.36fr)_96px_96px_136px] gap-3 border-b border-[#f2f4f7] px-4 py-3 text-left text-xs text-[#111827] transition hover:bg-[#f8fafc] ${
                            active ? 'bg-[#eef4ff]' : 'bg-white'
                          }`}
                        >
                          <div className="min-w-0 self-center">
                            <button
                              className="flex min-w-0 items-center gap-3 text-left"
                              onClick={() => handleOpenFileManagerRow(row)}
                              type="button"
                            >
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] border border-[#e5e7eb] bg-[#f8fafc] text-[#475467]">
                                <FileManagerRowGlyph kind={row.kind} />
                              </div>
                              <div className="min-w-0">
                                <div className="truncate font-medium text-[#111827]">{row.name}</div>
                                <div className="mt-1 truncate text-[11px] text-[#98a2b3]">{helperText}</div>
                              </div>
                            </button>
                          </div>
                          <div className="self-center">
                            {row.kind === 'parent' || row.kind === 'directory' ? (
                              <button
                                className="inline-flex h-7 items-center justify-center rounded-[10px] border border-[#d0d5dd] bg-white px-2.5 text-[11px] font-medium text-[#344054] transition hover:bg-[#f8fafc]"
                                onClick={() => handleOpenFileManagerRow(row)}
                                type="button"
                              >
                                {row.kind === 'parent' ? '返回' : '进入'}
                              </button>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <button
                                  className="inline-flex h-7 items-center justify-center rounded-[10px] border border-[#d0d5dd] bg-white px-2.5 text-[11px] font-medium text-[#344054] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
                                  disabled={fileManagerSession.previewing}
                                  onClick={() => handlePreviewFileManagerRow(row)}
                                  type="button"
                                >
                                  {fileManagerSession.previewing && fileManagerSession.activeItem?.path === row.path ? '打开中...' : '预览'}
                                </button>
                                {isTextPreviewableFile(row.name) && (
                                  <button
                                    className="inline-flex h-7 items-center justify-center rounded-[10px] border border-[#d0d5dd] bg-white px-2.5 text-[11px] font-medium text-[#344054] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
                                    disabled={fileManagerSession.reading || fileManagerSession.saving}
                                    onClick={() => handleEditFileManagerRow(row)}
                                    type="button"
                                  >
                                    {fileManagerSession.reading && fileManagerSession.activeItem?.path === row.path
                                      ? '载入中...'
                                      : fileManagerSession.detailVisible &&
                                          fileManagerSession.activeItem?.path === row.path &&
                                          fileManagerSession.previewMode === 'edit'
                                        ? '编辑中'
                                        : '编辑'}
                                  </button>
                                )}
                                <button
                                  className="inline-flex h-7 items-center justify-center rounded-[10px] border border-[#d0d5dd] bg-white px-2.5 text-[11px] font-medium text-[#344054] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
                                  disabled={fileManagerSession.downloading}
                                  onClick={() => handleDownloadFile(row.path)}
                                  type="button"
                                >
                                  {fileManagerSession.downloading && fileManagerSession.downloadPath === row.path ? '下载中...' : '下载'}
                                </button>
                              </div>
                            )}
                          </div>
                          <div className="min-w-0 self-center text-[#475467]">
                            <div className="truncate">{row.path}</div>
                          </div>
                          <div className="self-center">
                            <span className="inline-flex rounded-full bg-[#f4f6fb] px-2.5 py-1 text-[11px] font-medium text-[#475467]">
                              {row.typeLabel}
                            </span>
                          </div>
                          <div className="self-center text-[#475467]">{row.sizeLabel}</div>
                          <div className="self-center text-[#667085]">{row.updatedLabel}</div>
                        </div>
                      )
                    })
                  ) : (
                    <div className="flex h-full min-h-[260px] items-center justify-center px-6 py-10 text-center">
                      <div>
                        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[16px] border border-dashed border-[#d0d5dd] bg-[#f8fafc] text-[#98a2b3]">
                          <FolderLineIcon />
                        </div>
                        <div className="mt-3 text-sm font-medium text-[#111827]">当前目录没有匹配内容</div>
                        <div className="mt-1 text-xs text-[#98a2b3]">可以更换目录、换个关键词，或先上传一个文件。</div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#eef2f6] bg-white px-4 py-3">
                  <div className="min-w-0 text-xs text-[#667085]">
                    {fileManagerSession.status || '支持目录进入、窗口内预览、窗口内编辑与下载。'}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {fileManagerSession.error && (
                      <span className="rounded-full bg-[#fff1f2] px-2.5 py-1 text-[11px] text-[#dc2626]">{fileManagerSession.error}</span>
                    )}
                    {fileManagerSession.lastDownloadedPath && (
                      <span className="rounded-full bg-[#eff6ff] px-2.5 py-1 text-[11px] text-[#2563eb]">
                        最近下载：{fileManagerSession.lastDownloadedFileName || getPathLeafName(fileManagerSession.lastDownloadedPath)}
                      </span>
                    )}
                  </div>
                </div>
              </section>
            </div>

            <input className="hidden" onChange={handleFileSelection} ref={fileInputRef} type="file" />

            {fileManagerSession.detailVisible && (
              <AgentWindow
                contained
                description={
                  fileManagerSession.previewMode === 'edit'
                    ? '编辑完成后直接保存，关闭按钮会触发当前文件编辑弹窗的清理逻辑。'
                    : isMarkdownLikeFile(fileManagerSession.activeItem?.name)
                      ? 'Markdown 预览已按文档格式解析展示。'
                      : '预览内容会保留在当前文件管理窗口内部。'
                }
                onClose={closeFileManagerDetail}
                title={`${fileManagerSession.previewMode === 'edit' ? '文件编辑' : '文件预览'} · ${fileManagerSession.activeItem?.name || '--'}`}
                bodyClassName="overflow-hidden bg-[#f6f7fb] p-0"
                panelClassName="border-[#dbe3ee] bg-white shadow-[0_30px_120px_rgba(15,23,42,0.18)]"
                sizeClassName="h-[84%] w-[88%] max-w-[1120px]"
              >
                <div className="flex h-full min-h-0 flex-col bg-[#f6f7fb]">
                  <div className="border-b border-[#e5e7eb] bg-white px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-2 rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1.5 text-[#111827]">
                        <FileManagerRowGlyph kind={fileManagerSession.previewMode === 'edit' ? 'draft' : fileManagerSession.activeItem?.kind} />
                        {fileManagerSession.previewMode === 'edit' ? '编辑模式' : '预览模式'}
                      </span>
                      <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-[#e5e7eb] bg-white px-3 py-1.5 text-[#667085]">
                        <FolderLineIcon />
                        <span className="max-w-[50vw] truncate">{fileManagerSession.activeItem?.path || '--'}</span>
                      </span>
                      <span className="inline-flex items-center rounded-full border border-[#e5e7eb] bg-[#f8fafc] px-3 py-1.5 text-[#667085]">
                        类型：{getFileEntryTypeLabel(fileManagerSession.activeItem || {})}
                      </span>
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 p-5">
                    {fileManagerSession.previewing || fileManagerSession.reading ? (
                      <div className="flex h-full min-h-[320px] items-center justify-center rounded-[24px] border border-[#e5e7eb] bg-white text-sm text-[#667085]">
                        {fileManagerSession.previewMode === 'edit' ? '正在加载可编辑内容...' : '正在加载预览内容...'}
                      </div>
                    ) : fileManagerSession.error ? (
                      <div className="flex h-full min-h-[320px] items-center justify-center rounded-[24px] border border-dashed border-rose-200 bg-[#fff1f2] px-6 text-center text-sm text-rose-600">
                        {fileManagerSession.error}
                      </div>
                    ) : fileManagerSession.previewMode === 'edit' ? (
                      <textarea
                        className="h-full min-h-[320px] w-full resize-none rounded-[24px] border border-[#d9deea] bg-white px-5 py-5 text-sm leading-7 text-[#111827] outline-none transition focus:border-[#cbd5e1]"
                        onChange={(event) =>
                          updateFileManagerSession((current) => ({
                            ...current,
                            previewDraft: event.target.value,
                          }))
                        }
                        spellCheck={false}
                        value={fileManagerSession.previewDraft}
                      />
                    ) : fileManagerSession.activeItem && isTextPreviewableFile(fileManagerSession.activeItem.name) ? (
                      isMarkdownLikeFile(fileManagerSession.activeItem.name) ? (
                        <div className="h-full overflow-auto rounded-[24px] border border-[#e5e7eb] bg-white p-4">
                          <MarkdownPreview content={fileManagerSession.previewContent} />
                        </div>
                      ) : (
                        <div className="h-full overflow-auto rounded-[24px] border border-[#0f172a] bg-[#0f172a] p-4">
                          <pre className="min-h-full whitespace-pre-wrap break-words text-sm leading-7 text-[#e5e7eb]">
                            {fileManagerSession.previewContent || '文件内容为空'}
                          </pre>
                        </div>
                      )
                    ) : fileManagerSession.previewObjectUrl ? (
                      isImagePreviewableFile(fileManagerSession.activeItem?.name) ||
                      String(fileManagerSession.previewObjectType || '').startsWith('image/') ? (
                        <div className="flex h-full min-h-[320px] items-center justify-center overflow-auto rounded-[24px] border border-[#e5e7eb] bg-white p-4">
                          <img alt={fileManagerSession.activeItem?.name || '文件预览'} className="max-h-full max-w-full rounded-[18px] object-contain" src={fileManagerSession.previewObjectUrl} />
                        </div>
                      ) : (
                        <div className="h-full min-h-[320px] overflow-hidden rounded-[24px] border border-[#e5e7eb] bg-white">
                          <iframe className="h-full w-full" src={fileManagerSession.previewObjectUrl} title={fileManagerSession.activeItem?.name || '文件预览'} />
                        </div>
                      )
                    ) : (
                      <div className="flex h-full min-h-[320px] items-center justify-center rounded-[24px] border border-dashed border-[#d0d5dd] bg-white px-6 text-center text-sm text-[#98a2b3]">
                        当前文件暂不支持内嵌预览，你可以直接下载到本地查看。
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e5e7eb] bg-white px-5 py-4">
                    <div className="min-w-0 text-xs text-[#667085]">
                      {fileManagerSession.previewMode === 'edit'
                        ? '当前编辑仅作用于选中文件，保存后会立即写回容器。'
                        : fileManagerSession.activeItem?.path || '当前没有打开文件。'}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {fileManagerSession.activeItem?.path && (
                        <button
                          className="inline-flex h-9 items-center justify-center rounded-[12px] border border-[#d0d5dd] bg-white px-3 text-xs font-medium text-[#344054] transition hover:bg-[#f8fafc] disabled:cursor-not-allowed disabled:opacity-60"
                          disabled={fileManagerSession.downloading}
                          onClick={() => handleDownloadFile(fileManagerSession.activeItem.path)}
                          type="button"
                        >
                          {fileManagerSession.downloading && fileManagerSession.downloadPath === fileManagerSession.activeItem.path ? '下载中...' : '下载文件'}
                        </button>
                      )}
                      {fileManagerSession.previewMode === 'edit' &&
                        fileManagerSession.activeItem &&
                        isTextPreviewableFile(fileManagerSession.activeItem.name) && (
                          <button
                            className="inline-flex h-9 items-center justify-center rounded-[12px] bg-[#111827] px-4 text-xs font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
                            disabled={fileManagerSession.saving}
                            onClick={handleSaveFileManagerContent}
                            type="button"
                          >
                            {fileManagerSession.saving ? '保存中...' : '保存'}
                          </button>
                        )}
                    </div>
                  </div>
                </div>
              </AgentWindow>
            )}
          </div>
        </AgentWindow>
      )}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="block space-y-2 text-sm text-[#4b5563]">
      <span className="font-medium text-[#111827]">{label}</span>
      {children}
    </label>
  )
}

function FloatingBadge({ children, className = '' }) {
  return (
    <div className={`absolute flex h-14 w-14 items-center justify-center rounded-[18px] border border-white/80 bg-white ${className}`}>
      {children}
    </div>
  )
}

function StatusBadge({ status }) {
  const colorMap = {
    Running: 'bg-[#ecfdf3] text-[#047857]',
    Healthy: 'bg-[#ecfdf3] text-[#047857]',
    Active: 'bg-[#ecfdf3] text-[#047857]',
    Stopped: 'bg-[#f3f4f6] text-[#4b5563]',
    Pending: 'bg-[#fff7ed] text-[#c2410c]',
    Degraded: 'bg-[#fff1f2] text-[#e11d48]',
  }

  return <span className={`rounded-full px-3 py-1 text-xs font-medium ${colorMap[status] || 'bg-[#f3f4f6] text-[#4b5563]'}`}>{status}</span>
}

function Dot() {
  return <span className="h-2 w-2 rounded-full bg-[#60a5fa]" />
}

function SearchIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.2-4.2" />
    </svg>
  )
}

function renderInlineMarkdown(text, keyPrefix) {
  const segments = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g
  let lastIndex = 0
  let match = null
  let tokenIndex = 0

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push(
        <span key={`${keyPrefix}-text-${tokenIndex}`}>{text.slice(lastIndex, match.index)}</span>,
      )
      tokenIndex += 1
    }

    const token = match[0]
    if (token.startsWith('**')) {
      segments.push(
        <strong key={`${keyPrefix}-strong-${tokenIndex}`} className="font-semibold text-[#111827]">
          {token.slice(2, -2)}
        </strong>,
      )
    } else if (token.startsWith('*')) {
      segments.push(
        <em key={`${keyPrefix}-em-${tokenIndex}`} className="italic text-[#111827]">
          {token.slice(1, -1)}
        </em>,
      )
    } else {
      segments.push(
        <code key={`${keyPrefix}-code-${tokenIndex}`} className="rounded bg-[#eef2f7] px-1.5 py-0.5 text-[13px] text-[#c2410c]">
          {token.slice(1, -1)}
        </code>,
      )
    }

    tokenIndex += 1
    lastIndex = match.index + token.length
  }

  if (lastIndex < text.length) {
    segments.push(<span key={`${keyPrefix}-tail`}>{text.slice(lastIndex)}</span>)
  }

  return segments.length ? segments : [<span key={`${keyPrefix}-plain`}>{text}</span>]
}

function MarkdownPreview({ content = '' }) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let index = 0

  const isBlockBoundary = (value = '') =>
    /^#{1,6}\s/.test(value) ||
    /^```/.test(value) ||
    /^>\s?/.test(value) ||
    /^[-*+]\s/.test(value) ||
    /^\d+\.\s/.test(value)

  while (index < lines.length) {
    const rawLine = lines[index]
    const trimmedLine = rawLine.trim()

    if (!trimmedLine) {
      index += 1
      continue
    }

    if (/^```/.test(trimmedLine)) {
      const codeLines = []
      const language = trimmedLine.replace(/^```/, '').trim()
      index += 1
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        codeLines.push(lines[index])
        index += 1
      }
      if (index < lines.length) {
        index += 1
      }
      blocks.push(
        <div key={`code-${blocks.length}`} className="overflow-hidden rounded-[18px] border border-[#e5e7eb] bg-[#111827]">
          <div className="border-b border-white/10 px-4 py-2 text-[11px] text-white/70">{language || '代码'}</div>
          <pre className="overflow-x-auto px-4 py-4 text-[13px] leading-6 text-white">{codeLines.join('\n')}</pre>
        </div>,
      )
      continue
    }

    const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch) {
      const level = headingMatch[1].length
      const sizes = {
        1: 'text-[26px]',
        2: 'text-[22px]',
        3: 'text-[18px]',
        4: 'text-[16px]',
        5: 'text-[15px]',
        6: 'text-[14px]',
      }
      blocks.push(
        <div key={`heading-${blocks.length}`} className={`${sizes[level]} font-semibold tracking-[-0.02em] text-[#111827]`}>
          {renderInlineMarkdown(headingMatch[2], `heading-${blocks.length}`)}
        </div>,
      )
      index += 1
      continue
    }

    if (/^>\s?/.test(trimmedLine)) {
      const quoteLines = []
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push(
        <blockquote key={`quote-${blocks.length}`} className="rounded-r-[18px] rounded-l-[8px] border-l-4 border-[#94a3b8] bg-white px-4 py-3 text-sm leading-7 text-[#475467]">
          {quoteLines.map((line, lineIndex) => (
            <div key={`quote-${blocks.length}-${lineIndex}`}>{renderInlineMarkdown(line, `quote-${blocks.length}-${lineIndex}`)}</div>
          ))}
        </blockquote>,
      )
      continue
    }

    if (/^[-*+]\s/.test(trimmedLine)) {
      const items = []
      while (index < lines.length && /^[-*+]\s/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*+]\s/, ''))
        index += 1
      }
      blocks.push(
        <ul key={`list-${blocks.length}`} className="list-disc space-y-2 pl-6 text-sm leading-7 text-[#111827]">
          {items.map((item, itemIndex) => (
            <li key={`list-${blocks.length}-${itemIndex}`}>{renderInlineMarkdown(item, `list-${blocks.length}-${itemIndex}`)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (/^\d+\.\s/.test(trimmedLine)) {
      const items = []
      while (index < lines.length && /^\d+\.\s/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s/, ''))
        index += 1
      }
      blocks.push(
        <ol key={`ordered-${blocks.length}`} className="list-decimal space-y-2 pl-6 text-sm leading-7 text-[#111827]">
          {items.map((item, itemIndex) => (
            <li key={`ordered-${blocks.length}-${itemIndex}`}>{renderInlineMarkdown(item, `ordered-${blocks.length}-${itemIndex}`)}</li>
          ))}
        </ol>,
      )
      continue
    }

    const paragraphLines = []
    while (index < lines.length && lines[index].trim() && !isBlockBoundary(lines[index].trim())) {
      paragraphLines.push(lines[index].trim())
      index += 1
    }

    blocks.push(
      <p key={`paragraph-${blocks.length}`} className="text-sm leading-7 text-[#111827]">
        {renderInlineMarkdown(paragraphLines.join(' '), `paragraph-${blocks.length}`)}
      </p>,
    )
  }

  if (!blocks.length) {
    return (
      <div className="flex min-h-[320px] items-center justify-center rounded-[18px] border border-dashed border-[#d0d5dd] bg-white text-sm text-[#98a2b3]">
        文件内容为空
      </div>
    )
  }

  return <div className="space-y-4 rounded-[18px] border border-[#e5e7eb] bg-white px-4 py-4">{blocks}</div>
}

function FileManagerRowGlyph({ kind }) {
  if (kind === 'parent') {
    return <FolderUpIcon className="h-5 w-5" />
  }

  if (kind === 'directory') {
    return <FolderLineIcon className="h-5 w-5" />
  }

  if (kind === 'download') {
    return <DownloadArrowIcon className="h-5 w-5" />
  }

  if (kind === 'upload' || kind === 'draft') {
    return <UploadArrowIcon className="h-5 w-5" />
  }

  return <FileLineIcon className="h-5 w-5" />
}

function ServerStackIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
      <path d="M8 7h.01M8 17h.01" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FolderLineIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
    </svg>
  )
}

function FolderUpIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H10l2 2h6.5A2.5 2.5 0 0 1 21 10.5v6A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z" />
      <path d="M12 15V9" strokeLinecap="round" />
      <path d="m9.5 11.5 2.5-2.5 2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FileLineIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M7 3.5h6l4 4v13H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2Z" />
      <path d="M13 3.5v4h4" />
    </svg>
  )
}

function UploadArrowIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M12 16V7" strokeLinecap="round" />
      <path d="m8.5 10.5 3.5-3.5 3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17.5a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 17.5" strokeLinecap="round" />
    </svg>
  )
}

function DownloadArrowIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M12 7v9" strokeLinecap="round" />
      <path d="m8.5 13.5 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17.5a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 17.5" strokeLinecap="round" />
    </svg>
  )
}

function CopyLineIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <rect x="9" y="9" width="10" height="10" rx="2" />
      <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function TrashLineIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M4 7h16" strokeLinecap="round" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M7 7l1 12a2 2 0 0 0 2 1.8h4a2 2 0 0 0 2-1.8L17 7" />
      <path d="M10 11v5M14 11v5" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function BookIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v14H6.5A2.5 2.5 0 0 0 4 20.5z" />
      <path d="M4 6.5v14" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M3 12h3" />
      <path d="M18 12h3" />
      <path d="m5.6 5.6 2.1 2.1" />
      <path d="m16.3 16.3 2.1 2.1" />
      <path d="m18.4 5.6-2.1 2.1" />
      <path d="m7.7 16.3-2.1 2.1" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  )
}

function CodeCubeIcon() {
  return (
    <svg className="h-12 w-12" fill="none" viewBox="0 0 48 48">
      <rect x="8" y="8" width="32" height="32" rx="12" fill="#f8fafc" stroke="#dbe1ea" />
      <path d="m24 14 10 5.8v8.4L24 34l-10-5.8v-8.4Z" fill="#111827" opacity="0.9" />
      <path d="m19 24 3-3m7 0-3 3m-4 0h4" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  )
}

function TinyGridIcon() {
  return (
    <svg className="h-6 w-6 text-[#9ca3af]" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
      <rect x="4" y="4" width="6" height="6" rx="1.2" />
      <rect x="14" y="4" width="6" height="6" rx="1.2" />
      <rect x="4" y="14" width="6" height="6" rx="1.2" />
      <rect x="14" y="14" width="6" height="6" rx="1.2" />
    </svg>
  )
}

function LayersIcon() {
  return (
    <svg className="h-6 w-6 text-[#9ca3af]" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
      <path d="m12 4 8 4-8 4-8-4Z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </svg>
  )
}

function CubeIcon() {
  return (
    <svg className="h-6 w-6 text-[#9ca3af]" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z" />
      <path d="M12 12 4 7.5" />
      <path d="M12 12l8-4.5" />
      <path d="M12 12v9" />
    </svg>
  )
}

function PlayGlyph() {
  return (
    <svg className="h-6 w-6 text-[#9ca3af]" fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 6.5v11l9-5.5Z" />
    </svg>
  )
}

function VsCodeGlyph() {
  return (
    <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24">
      <path d="m16.5 4 3.5 1.7v12.6L16.5 20l-7.2-7.2-3.3 2.5-2-1.6 3.9-3.7-3.9-3.7 2-1.6 3.3 2.5Z" fill="#3b82f6" />
      <path d="M16.5 4 9.3 11.2 16.5 20" stroke="#1d4ed8" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}
