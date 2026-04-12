import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  createClusterContext,
  createResource,
  deleteResource,
  getClusterInfo,
  getCreateBlueprint,
  buildChatApiCandidates,
  buildChatApiUrl,
  buildCherryStudioChatApiUrl,
  buildPodExecWsCandidates,
  findExecPodForApp,
  listResources,
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

const normalizeName = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)

const buildAgentLabels = (source, clusterContext) => ({
  'agent.sealos.io/name': clusterContext?.agentLabel || source.user,
})

const emptyBlueprint = {
  appName: '',
  namespace: '',
  apiKey: '',
  apiUrl: '',
  domainPrefix: '',
  fullDomain: '',
  image: 'nousresearch/hermes-agent:latest',
  state: 'Running',
  runtimeClassName: 'devbox-runtime',
  storageLimit: '10Gi',
  port: 8642,
  cpu: '2000m',
  memory: '4096Mi',
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
  const apiUrl = buildCherryStudioChatApiUrl(
    envList.find((env) => env.name === 'OPENAI_API_BASE_URL')?.value || buildChatApiUrl(host),
  )

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
    serviceType: serviceYaml?.spec?.type || 'ClusterIP',
    protocol: appPorts[0]?.protocol || servicePorts[0]?.protocol || 'TCP',
    user: devbox?.owner || 'admin',
    workingDir: devboxYaml?.spec?.config?.workingDir || '/home/admin',
    argsText: Array.isArray(args) ? args.join(' ') : 'gateway run',
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
  const [message, setMessage] = useState('')
  const [copyMessage, setCopyMessage] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState('create')
  const [createTypeOpen, setCreateTypeOpen] = useState(false)
  const [createType, setCreateType] = useState('hermes-agent')
  const [editingGroup, setEditingGroup] = useState(null)
  const [blueprint, setBlueprint] = useState({ ...emptyBlueprint })
  const [chatSession, setChatSession] = useState(null)
  const chatConnectionRef = useRef(null)
  const chatMessagesRef = useRef(null)
  const chatShouldAutoScrollRef = useRef(true)
  const [terminalSession, setTerminalSession] = useState(null)
  const terminalContainerRef = useRef(null)
  const terminalRef = useRef(null)
  const terminalFitAddonRef = useRef(null)
  const terminalSocketRef = useRef(null)
  const terminalDataDisposableRef = useRef(null)
  const [config] = useState({
    docUrl: 'https://vite.dev/guide/',
  })

  const meta = resourceMeta[activeType]
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

      return {
        ...item,
        apiUrl: ingressHost ? `https://${ingressHost}/v1` : '',
        apiKey: blueprint.apiKey || item.apiKey || '',
      }
    })
  }, [activeType, resources, clusterInfo?.namespace, findResourceGroup])

  const filteredItems = useMemo(() => {
    if (!keyword.trim()) return enrichedItems
    return enrichedItems.filter((item) =>
      [item.name, item.owner, item.status, item.desc, item.apiUrl, item.apiKey, item.updatedAt]
        .join(' ')
        .toLowerCase()
        .includes(keyword.toLowerCase()),
    )
  }, [enrichedItems, keyword])

  const loadAll = async () => {
    setLoading(true)
    try {
      const session = await getSealosSession().catch(() => null)
      const language = await getSealosLanguage().catch(() => null)
      const quota = await getSealosQuota().catch(() => null)
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
      setMessage('已通过 fetch 同步最新数据')
    } catch (error) {
      setMessage(error.message || '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

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

  const writeTerminalLine = useCallback((text) => {
    if (!terminalRef.current) return
    terminalRef.current.writeln(text)
  }, [])

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
        const errorMessage = '缺少集群上下文，无法建立终端连接。'
        writeTerminalLine(`\r\n[error] ${errorMessage}`)
        setTerminalSession((current) => (current ? { ...current, status: 'error', error: errorMessage } : current))
        return
      }

      setTerminalSession((current) => (current ? { ...current, status: 'connecting', error: '' } : current))
      writeTerminalLine('\r\n[system] 正在查找 Pod 并建立连接...')

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
          token: clusterContext.token,
          clusterServer: clusterContext.server,
          commands: ['sh'],
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
        let lastConnectError = null

        for (const candidate of wsCandidates) {
          writeTerminalLine(`\r\n[system] 尝试连接: ${redactWsUrl(candidate)}`)
          try {
            socket = await tryOpenWebSocket(candidate, ['v4.channel.k8s.io'])
            wsUrl = candidate
            break
          } catch (errorWithProtocol) {
            console.warn('[terminal] websocket attempt failed with protocol', errorWithProtocol)
            try {
              socket = await tryOpenWebSocket(candidate, [])
              wsUrl = candidate
              break
            } catch (errorWithoutProtocol) {
              console.warn('[terminal] websocket attempt failed without protocol', errorWithoutProtocol)
              lastConnectError = errorWithoutProtocol
            }
          }
        }

        if (!socket) {
          const fallbackMessage =
            '无法建立终端 WebSocket 连接。当前环境很可能未在网关/代理层放通 Kubernetes exec WebSocket Upgrade（/api 或 /k8s-api）。'
          if (lastConnectError?.message) {
            throw new Error(`${fallbackMessage} 最后一次错误：${lastConnectError.message}`)
          }
          throw new Error(fallbackMessage)
        }

        socket.binaryType = 'arraybuffer'
        terminalSocketRef.current = socket

        writeTerminalLine(`[system] 已连接到 Pod: ${pod.podName}`)
        writeTerminalLine('[system] 自动执行 hermes ...')

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

        sendTerminalInput('hermes\r')

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
              writeTerminalLine(`\r\n[status] ${payload}`)
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
              writeTerminalLine(`\r\n[status] ${payload}`)
              return
            }

            writeTerminalData(payload)
          }
        }

        socket.onerror = () => {
          const errorMessage = '终端连接出现异常。'
          writeTerminalLine(`\r\n[error] ${errorMessage}`)
          setTerminalSession((current) => (current ? { ...current, status: 'error', error: errorMessage } : current))
        }

        socket.onclose = (event) => {
          const isManualClose = event.code === 1000
          const nextStatus = isManualClose ? 'disconnected' : 'error'
          const nextError = isManualClose ? '' : `连接关闭（code=${event.code}）`
          writeTerminalLine(`\r\n[system] 连接已关闭${event.code ? `（code=${event.code}）` : ''}`)
          setTerminalSession((current) => (current ? { ...current, status: nextStatus, error: nextError } : current))
          terminalSocketRef.current = null
        }
      } catch (error) {
        console.error(error)
        const errorMessage = error.message || '终端连接失败'
        writeTerminalLine(`\r\n[error] ${errorMessage}`)
        setTerminalSession((current) => (current ? { ...current, status: 'error', error: errorMessage } : current))
      }
    },
    [clusterContext, closeTerminalSocket, sendTerminalInput, writeTerminalData, writeTerminalLine],
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
          fontSize: 13,
          lineHeight: 1.3,
          convertEol: true,
          theme: {
            background: '#0b1020',
            foreground: '#e5e7eb',
            cursor: '#93c5fd',
          },
        })

        const fitAddon = new FitAddon()
        terminal.loadAddon(fitAddon)
        terminal.open(terminalContainerRef.current)
        fitAddon.fit()
        terminal.focus()

        terminalRef.current = terminal
        terminalFitAddonRef.current = fitAddon
        terminal.writeln('[system] 终端已初始化，准备连接...')

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
    const data = await getCreateBlueprint(clusterContext, hostConfig)
    setBlueprint({
      ...data,
      user: clusterContext?.operator || data.user,
      argsText: Array.isArray(data.args) ? data.args.join(' ') : 'gateway run',
    })
  }

  const openCreate = () => {
    setFormMode('create')
    setEditingGroup(null)
    setCreateType('hermes-agent')
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
    setBlueprint(createBlueprintFromResourceGroup({ ...group, fallbackNamespace: clusterInfo?.namespace }))
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setCreateTypeOpen(false)
    setFormMode('create')
    setCreateType('hermes-agent')
    setEditingGroup(null)
    setBlueprint({ ...emptyBlueprint })
  }

  const handleBlueprintChange = (field, value) => {
    setBlueprint((current) => ({ ...current, [field]: value }))
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
    setTerminalSession(createTerminalSession(item))
  }

  const closeTerminal = () => {
    disconnectTerminal({ keepSession: false })
  }

  const reconnectTerminal = async () => {
    if (!terminalSession?.resource) return
    await connectTerminal(terminalSession.resource)
  }

  const handleTerminalDisconnect = () => {
    disconnectTerminal({ keepSession: true, nextStatus: 'disconnected' })
    writeTerminalLine('\r\n[system] 已手动断开连接。')
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
      const payloads = buildResourcePayloads(blueprint, clusterContext)

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
        setMessage(`已统一创建 ${blueprint.appName} 对应的 DevBox / Service / Ingress`)
      } else {
        const updatedDevbox = await updateResource('devbox', editingGroup.devbox.name, payloads.devbox, clusterContext)
        const updatedService = await updateResource('service', editingGroup.service.name, payloads.service, clusterContext)
        const updatedIngress = await updateResource('ingress', editingGroup.ingress.name, payloads.ingress, clusterContext)
        setResources((current) => ({
          devbox: current.devbox.map((item) => (item.id === updatedDevbox.id ? updatedDevbox : item)),
          service: current.service.map((item) => (item.id === updatedService.id ? updatedService : item)),
          ingress: current.ingress.map((item) => (item.id === updatedIngress.id ? updatedIngress : item)),
        }))
        setMessage(`已统一更新 ${blueprint.appName} 对应的 DevBox / Service / Ingress`)
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
            <div className="hidden items-center gap-2 rounded-full bg-[#f5f7fb] px-3 py-1.5 text-xs text-[#6b7280] xl:inline-flex">
              <Dot />
              kc {clusterInfo?.cluster || '--'}
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex h-11 w-full items-center gap-3 rounded-[16px] border border-[#eceef3] bg-white px-4 text-sm text-[#9ca3af] lg:w-[320px]">
              <SearchIcon />
              <input
                className="h-full flex-1 border-0 bg-transparent text-sm text-[#111827] outline-none placeholder:text-[#9ca3af]"
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索名字或者备注"
                value={keyword}
              />
            </div>

            <button
              className="inline-flex h-11 items-center justify-center gap-2 rounded-[16px] bg-[#111111] px-5 text-sm font-medium text-white transition hover:bg-black"
              onClick={openCreate}
              type="button"
            >
              <PlusIcon />
              新建资源
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

                <h2 className="mt-3 text-[30px] font-semibold tracking-[-0.03em] text-[#111827]">创建您的第一个资源</h2>

                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-[16px] bg-[#111111] px-5 text-sm font-medium text-white transition hover:bg-black"
                    onClick={openCreate}
                    type="button"
                  >
                    <PlusIcon />
                    新建资源
                  </button>
                </div>
              </div>
            ) : (
              <div className="relative z-10 h-full p-6 lg:p-8">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[20px] font-semibold text-[#111827]">{meta.title} 资源</div>
                    <div className="mt-1 text-sm text-[#6b7280]">直接通过 kubeconfig 对应的 Kubernetes API 拉取并操作真实资源。</div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {message && <span className="text-xs text-[#2563eb]">{message}</span>}
                    {copyMessage && <span className="text-xs text-[#7c3aed]">{copyMessage}</span>}
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
                        <th className="px-5 py-4 font-medium">名称</th>
                        <th className="px-5 py-4 font-medium">负责人</th>
                        <th className="px-5 py-4 font-medium">API 地址</th>
                        <th className="px-5 py-4 font-medium">Key</th>
                        <th className="px-5 py-4 font-medium">状态</th>
                        <th className="px-5 py-4 font-medium">更新时间</th>
                        <th className="px-5 py-4 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading ? (
                        <tr>
                          <td className="px-5 py-8 text-center text-[#6b7280]" colSpan="7">
                            正在加载数据...
                          </td>
                        </tr>
                      ) : filteredItems.length ? (
                        filteredItems.map((item) => (
                          <tr key={item.id} className="border-t border-[#f1f3f7] text-[#111827]">
                            <td className="px-5 py-4">
                              <div className="font-medium">{item.name}</div>
                              <div className="mt-1 text-xs text-[#9ca3af]">{item.desc}</div>
                            </td>
                            <td className="px-5 py-4">{clusterContext?.operator || item.owner}</td>
                            <td className="px-5 py-4">
                              {item.apiUrl ? (
                                <button
                                  className="max-w-[260px] truncate rounded-full bg-[#eff6ff] px-3 py-1.5 text-xs text-[#2563eb] hover:bg-[#dbeafe]"
                                  onClick={() => handleCopy(item.apiUrl, 'API 地址')}
                                  title={item.apiUrl}
                                  type="button"
                                >
                                  {item.apiUrl}
                                </button>
                              ) : (
                                <span className="text-[#9ca3af]">--</span>
                              )}
                            </td>
                            <td className="px-5 py-4">
                              {item.apiKey ? (
                                <button
                                  className="rounded-full bg-[#f5f3ff] px-3 py-1.5 text-xs text-[#7c3aed] hover:bg-[#ede9fe]"
                                  onClick={() => handleCopy(item.apiKey, 'API Key')}
                                  type="button"
                                >
                                  复制 Key
                                </button>
                              ) : (
                                <span className="text-[#9ca3af]">--</span>
                              )}
                            </td>
                            <td className="px-5 py-4">
                              <StatusBadge status={item.status} />
                            </td>
                            <td className="px-5 py-4 text-[#6b7280]">{item.updatedAt}</td>
                            <td className="px-5 py-4">
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
                                <button
                                  className="rounded-full bg-[#fff1f2] px-3 py-1.5 text-xs text-[#e11d48] hover:bg-[#ffe4e6]"
                                  onClick={() => handleDelete(item)}
                                  type="button"
                                >
                                  删除
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td className="px-5 py-8 text-center text-[#6b7280]" colSpan="7">
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
        <Overlay onClose={closeCreateType} title="选择创建类型">
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
        </Overlay>
      )}

      {formOpen && (
        <Overlay onClose={closeForm} title={formMode === 'create' ? '统一创建资源' : `统一编辑 ${blueprint.appName}`}>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 md:grid-cols-1">
              <Field label="应用名（统一资源主键）">
                <input className="field-input bg-[#f9fafb]" readOnly value={blueprint.appName} />
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="CPU">
                <input
                  className="field-input"
                  onChange={(event) => handleBlueprintChange('cpu', event.target.value)}
                  value={blueprint.cpu}
                />
              </Field>
              <Field label="内存">
                <input
                  className="field-input"
                  onChange={(event) => handleBlueprintChange('memory', event.target.value)}
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
              <input readOnly value={blueprint.namespace} />
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
        </Overlay>
      )}

      {terminalSession && (
        <Overlay onClose={closeTerminal} title={`终端 · ${terminalSession.resource.name}`} variant="chat">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="rounded-[20px] border border-[#eceef3] bg-[#fafbfc] p-4 text-sm text-[#4b5563]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#0f766e]">Pod: {terminalSession.podName || '--'}</span>
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#6366f1]">容器: {terminalSession.containerName || '--'}</span>
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#2563eb]">
                  状态: {terminalSession.status === 'initializing' ? '加载中' : terminalSession.status}
                </span>
              </div>
              {terminalSession.error && <div className="mt-3 text-xs text-[#dc2626]">{terminalSession.error}</div>}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded-full bg-[#e0f2fe] px-3 py-1.5 text-xs text-[#0369a1] hover:bg-[#bae6fd] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={terminalSession.status === 'initializing' || terminalSession.status === 'connecting'}
                  onClick={reconnectTerminal}
                  type="button"
                >
                  重连
                </button>
                <button
                  className="rounded-full bg-[#fef3c7] px-3 py-1.5 text-xs text-[#b45309] hover:bg-[#fde68a] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={terminalSession.status !== 'connected' && terminalSession.status !== 'connecting'}
                  onClick={handleTerminalDisconnect}
                  type="button"
                >
                  断开
                </button>
              </div>
            </div>

            {terminalSession.status === 'initializing' && (
              <div className="rounded-[16px] border border-[#dbeafe] bg-[#eff6ff] px-4 py-2 text-xs text-[#1d4ed8]">
                终端组件加载中，请稍候...
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-hidden rounded-[24px] border border-[#111827] bg-[#0b1020] p-2">
              <div ref={terminalContainerRef} className="h-full w-full" />
            </div>
          </div>
        </Overlay>
      )}

      {chatSession && (
        <Overlay onClose={closeChat} title={`对话 · ${chatSession.resource.name}`} variant="chat">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="rounded-[20px] border border-[#eceef3] bg-[#fafbfc] p-4 text-sm text-[#4b5563]">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#2563eb]">API: {chatSession.resource.apiUrl || '--'}</span>
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#7c3aed]">
                  连接: {chatSession.transport === CHAT_TRANSPORT.websocket ? 'WebSocket' : 'SSE'}
                </span>
                <span className="rounded-full bg-white px-3 py-1 text-xs text-[#059669]">状态: {chatSession.status}</span>
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
        </Overlay>
      )}
    </div>
  )
}

function Overlay({ children, onClose, title, variant = 'default' }) {
  const panelClass =
    variant === 'chat'
      ? 'relative z-10 flex h-[min(88vh,920px)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-[#eceef3] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]'
      : 'relative z-10 w-full max-w-3xl rounded-[28px] border border-[#eceef3] bg-white shadow-[0_24px_80px_rgba(15,23,42,0.18)]'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(17,24,39,0.12)] p-4 backdrop-blur-[2px]">
      <button aria-label="关闭遮罩" className="absolute inset-0" onClick={onClose} type="button" />
      <section className={panelClass}>
        <div className="flex shrink-0 items-center justify-between border-b border-[#eceef3] px-6 py-5">
          <div>
            <h3 className="text-[22px] font-semibold tracking-[-0.03em] text-[#111827]">{title}</h3>
            <p className="mt-1 text-sm text-[#6b7280]">支持纯前端交互，可切换抽屉或弹窗显示。</p>
          </div>
          <button
            className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[#f5f7fb] text-[#6b7280] hover:bg-[#eef2f7]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <div className={variant === 'chat' ? 'min-h-0 flex-1 overflow-hidden p-6' : 'max-h-[80vh] overflow-hidden p-6'}>{children}</div>
      </section>
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
