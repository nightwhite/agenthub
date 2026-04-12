import { createSealosApp, sealosApp } from '@labring/sealos-desktop-sdk/app'

const mockSession = {
  token: 'mock-hermes-token',
  user: {
    id: 'user-hermes-agent',
    name: 'Hermes Agent',
    avatar: 'https://api.dicebear.com/9.x/bottts/svg?seed=Hermes',
    k8sUsername: 'hermes-agent',
    nsid: 'ns-hermes-agent',
  },
  subscription: {
    ID: 'sub-hermes-agent',
    PlanName: 'Enterprise Workspace',
    Workspace: 'agent-system',
    RegionDomain: 'mock-k8s.hermes.local',
    UserUID: 'user-hermes-agent',
    Status: 'ACTIVE',
    PayStatus: 'PAID',
    PayMethod: 'mock',
    Stripe: null,
    TrafficStatus: 'NORMAL',
    CurrentPeriodStartAt: '2026-04-01 00:00:00',
    CurrentPeriodEndAt: '2026-05-01 00:00:00',
    CancelAtPeriodEnd: false,
    CancelAt: '',
    CreateAt: '2026-04-01 00:00:00',
    UpdateAt: '2026-04-10 19:00:00',
    ExpireAt: null,
    Traffic: [],
    type: 'SUBSCRIPTION',
  },
  kubeconfig: `apiVersion: v1
clusters:
- cluster:
    server: https://mock-k8s.hermes.local
  name: hermes-agent-cluster
contexts:
- context:
    cluster: hermes-agent-cluster
    namespace: agent-system
    user: hermes-agent
  name: hermes-agent-context
current-context: hermes-agent-context
kind: Config
users:
- name: hermes-agent
  user:
    token: mock-hermes-token`,
}

const mockLanguage = { lng: 'zh' }
const mockQuota = {
  quota: [
    { type: 'cpu', used: 12, limit: 32 },
    { type: 'memory', used: 48, limit: 128 },
    { type: 'storage', used: 320, limit: 1024 },
    { type: 'gpu', used: 1, limit: 4 },
  ],
}

const mockHostConfig = {
  cloud: {
    domain: 'mock-k8s.hermes.local',
    port: '443',
    regionUid: 'cn-hz-mock-1',
  },
  features: {
    subscription: true,
  },
}

const isBrowser = typeof window !== 'undefined'

const wait = (time = 120) => new Promise((resolve) => setTimeout(resolve, time))

const postMockMessage = (data) => {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: window.location.origin,
      source: window,
    }),
  )
}

const createMockReply = (data, overrides = {}) => ({
  success: true,
  ...overrides,
  data,
})

export const initSealosDesktopSdk = () => {
  if (!isBrowser) {
    return () => {}
  }

  let cleanup = () => {}

  try {
    cleanup = createSealosApp?.() || (() => {})
  } catch (error) {
    console.warn('[sealosSdk] createSealosApp failed, fallback to mock bridge:', error)
  }

  const canOverrideTopPostMessage = (() => {
    try {
      if (!window.top) return false
      return window.self === window.top
    } catch (error) {
      console.warn('[sealosSdk] cross-origin iframe detected, force mock sdk:', error)
      return false
    }
  })()

  if (!canOverrideTopPostMessage) {
    return cleanup
  }

  let originalPostMessage = null
  try {
    originalPostMessage = window.top.postMessage.bind(window.top)
  } catch (error) {
    console.warn('[sealosSdk] unable to access top.postMessage, skip mock bridge override:', error)
    return cleanup
  }

  try {
    window.top.postMessage = async (message, targetOrigin, transfer) => {
      const isSdkCall =
        message &&
        typeof message === 'object' &&
        'messageId' in message &&
        'apiName' in message

      if (!isSdkCall) {
        return originalPostMessage(message, targetOrigin, transfer)
      }

      await wait()

      const baseReply = {
        messageId: message.messageId,
        apiName: message.apiName,
        origin: window.location.origin,
      }

      if (message.apiName === 'user.getInfo') {
        postMockMessage({ ...baseReply, ...createMockReply(mockSession) })
        return undefined
      }

      if (message.apiName === 'getLanguage') {
        postMockMessage({ ...baseReply, ...createMockReply(mockLanguage) })
        return undefined
      }

      if (message.apiName === 'account.getWorkspaceQuota') {
        postMockMessage({ ...baseReply, ...createMockReply(mockQuota) })
        return undefined
      }

      if (message.apiName === 'getHostConfig') {
        postMockMessage({ ...baseReply, ...createMockReply(mockHostConfig) })
        return undefined
      }

      if (message.apiName === 'event-bus') {
        const payload = message.data || {}
        postMockMessage({
          ...baseReply,
          ...createMockReply({
            ack: true,
            eventName: payload.eventName,
            eventData: payload.eventData || null,
          }),
        })

        if (payload.eventName === 'app-ready') {
          postMockMessage({
            apiName: 'event-bus',
            eventName: 'desktop-notify',
            data: {
              type: 'info',
              content: 'Desktop 端已收到 app-ready 事件。',
            },
          })
        }
        return undefined
      }

      postMockMessage({
        ...baseReply,
        success: false,
        message: `Unsupported apiName: ${message.apiName}`,
      })

      return undefined
    }
  } catch (error) {
    console.warn('[sealosSdk] unable to override top.postMessage, skip mock bridge override:', error)
    return cleanup
  }

  return () => {
    window.top.postMessage = originalPostMessage
    cleanup?.()
  }
}

const getSdkClient = (() => {
  let sdkInitialized = false

  return () => {
    if (!sdkInitialized) {
      sdkInitialized = true
      try {
        createSealosApp?.()
      } catch (error) {
        console.warn('[sealosSdk] createSealosApp retry failed:', error)
      }
    }

    if (sealosApp && typeof sealosApp === 'object') {
      return sealosApp
    }

    return null
  }
})()

const hasSdkMethod = (methodName) => {
  const client = getSdkClient()
  return Boolean(client && typeof client[methodName] === 'function')
}

const getSdkDebugInfo = () => {
  const client = getSdkClient()
  return {
    sdkAvailable: Boolean(client),
    methods: client
      ? {
          getSession: typeof client.getSession === 'function',
          getLanguage: typeof client.getLanguage === 'function',
          getWorkspaceQuota: typeof client.getWorkspaceQuota === 'function',
          getHostConfig: typeof client.getHostConfig === 'function',
          runEvents: typeof client.runEvents === 'function',
          addAppEventListen: typeof client.addAppEventListen === 'function',
        }
      : null,
    isBrowser,
    location: isBrowser ? window.location.href : '',
  }
}

export const getSealosSession = async () =>
  hasSdkMethod('getSession') ? getSdkClient().getSession() : mockSession
export const getSealosLanguage = async () =>
  hasSdkMethod('getLanguage') ? getSdkClient().getLanguage() : mockLanguage
export const getSealosQuota = async () =>
  hasSdkMethod('getWorkspaceQuota') ? getSdkClient().getWorkspaceQuota() : mockQuota
export const getSealosHostConfig = async () =>
  hasSdkMethod('getHostConfig') ? getSdkClient().getHostConfig() : mockHostConfig
export const runSealosEvent = async (eventName, eventData) =>
  hasSdkMethod('runEvents')
    ? getSdkClient().runEvents(eventName, eventData)
    : { success: true, mocked: true, eventName, eventData }
export const addSealosAppEventListener = (eventName, handler) => {
  if (hasSdkMethod('addAppEventListen')) {
    return getSdkClient().addAppEventListen(eventName, handler)
  }

  const listener = (event) => {
    const payload = event?.data
    if (payload?.apiName === 'event-bus' && payload?.eventName === eventName) {
      handler(payload.data)
    }
  }

  if (isBrowser) {
    window.addEventListener('message', listener)
  }

  return () => {
    if (isBrowser) {
      window.removeEventListener('message', listener)
    }
  }
}

export const getSealosSdkDebugInfo = () => getSdkDebugInfo()
