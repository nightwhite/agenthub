import { createSealosApp, sealosApp } from '@labring/sealos-desktop-sdk/app'

const isBrowser = typeof window !== 'undefined'

let sdkInitialized = false

const ensureSdkReady = () => {
  if (!sdkInitialized) {
    sdkInitialized = true
    try {
      createSealosApp?.()
    } catch (error) {
      console.warn('[sealosSdk] createSealosApp failed:', error)
    }
  }

  if (sealosApp && typeof sealosApp === 'object') {
    return sealosApp
  }

  return null
}

const requireSdkMethod = (methodName) => {
  const client = ensureSdkReady()
  if (client && typeof client[methodName] === 'function') {
    return client[methodName].bind(client)
  }
  throw new Error(`[sealosSdk] SDK method not available: ${methodName}`)
}

export const initSealosDesktopSdk = () => {
  if (!isBrowser) return () => {}

  try {
    createSealosApp?.()
  } catch (error) {
    console.warn('[sealosSdk] init failed:', error)
  }

  return () => {}
}

export const getSealosSession = async () => requireSdkMethod('getSession')()
export const getSealosLanguage = async () => requireSdkMethod('getLanguage')()
export const getSealosQuota = async () => requireSdkMethod('getWorkspaceQuota')()
export const getSealosHostConfig = async () => requireSdkMethod('getHostConfig')()
export const runSealosEvent = async (eventName, eventData) => requireSdkMethod('runEvents')(eventName, eventData)

export const addSealosAppEventListener = (eventName, handler) => {
  const addListener = requireSdkMethod('addAppEventListen')
  return addListener(eventName, handler)
}

export const getSealosSdkDebugInfo = () => {
  const client = ensureSdkReady()
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
