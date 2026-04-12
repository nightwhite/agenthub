export const CHAT_TRANSPORT = {
  websocket: 'websocket',
  sse: 'sse',
}

const DEFAULT_MODEL = 'hermes-agent'

const isLocalDevHost = () => {
  if (typeof window === 'undefined') return false
  return ['localhost', '127.0.0.1'].includes(window.location.hostname)
}

const stripKnownChatSuffix = (pathname = '') => pathname.replace(/\/(chat(?:\/completions)?|responses)\/?$/, '') || '/'

const resolveChatTargetUrl = (apiUrl) => {
  const target = new URL(apiUrl)
  const normalizedPath = target.pathname.replace(/\/$/, '')

  if (normalizedPath.endsWith('/chat/completions')) {
    return { target, mode: 'chat-completions' }
  }

  if (normalizedPath.endsWith('/responses')) {
    return { target, mode: 'responses' }
  }

  if (normalizedPath.endsWith('/chat')) {
    return { target, mode: 'chat' }
  }

  target.pathname = `${stripKnownChatSuffix(target.pathname).replace(/\/$/, '')}/chat/completions`
  return { target, mode: 'chat-completions' }
}

const resolveProxyUrl = (apiUrl) => {
  const { target, mode } = resolveChatTargetUrl(apiUrl)
  if (!isLocalDevHost()) return { target, mode }

  const proxyPath = mode === 'chat' ? '/chat-api-ws' : '/chat-api'
  const proxyUrl = new URL(`${proxyPath}${target.pathname}`, window.location.origin)
  proxyUrl.search = target.search

  return { target: proxyUrl, mode }
}

const buildRequestUrl = (apiUrl) => resolveProxyUrl(apiUrl).target.toString()

const buildWsUrl = (apiUrl) => {
  const { target, mode } = resolveProxyUrl(apiUrl)
  if (mode !== 'chat') {
    return null
  }

  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  return target.toString()
}

export function createOpenAIChatConnection({ apiUrl, apiKey, onEvent, preferredTransport = CHAT_TRANSPORT.sse }) {
  if (!apiUrl) throw new Error('缺少 API 地址，无法建立对话连接')
  if (!apiKey) throw new Error('缺少 API Key，无法建立对话连接')

  let socket = null
  let eventSource = null
  let closed = false
  let activeTransport = preferredTransport

  const emit = (event) => {
    if (!closed) {
      onEvent?.(event)
    }
  }

  const close = () => {
    closed = true
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close(1000, 'chat panel closed')
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      socket.close()
    }
    if (eventSource) {
      eventSource.close()
    }
  }

  const sendViaSse = async (payload) => {
    const requestUrl = buildRequestUrl(apiUrl)
    console.log('[chat] request', { apiUrl, requestUrl, payload })
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-API-Key': apiKey,
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      console.error('[chat] response error', {
        status: response.status,
        body: errorText,
      })
      throw new Error(errorText || `聊天请求失败: ${response.status}`)
    }

    if (!response.body) {
      throw new Error(`聊天响应为空: ${response.status}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('text/event-stream')) {
      const data = await response.json().catch(async () => ({ choices: [{ message: { content: await response.text().catch(() => '') } }] }))
      emit({ type: 'open', transport: CHAT_TRANSPORT.sse })
      emit({ type: 'message', transport: CHAT_TRANSPORT.sse, payload: data })
      emit({ type: 'done', transport: CHAT_TRANSPORT.sse })
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''

    emit({ type: 'open', transport: CHAT_TRANSPORT.sse })

    while (!closed) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() || ''

      for (const chunk of chunks) {
        const lines = chunk.split('\n').filter(Boolean)
        const dataLine = lines.find((line) => line.startsWith('data:'))
        if (!dataLine) continue
        const raw = dataLine.slice(5).trim()
        if (!raw || raw === '[DONE]') {
          emit({ type: 'done', transport: CHAT_TRANSPORT.sse })
          continue
        }
        try {
          emit({ type: 'message', transport: CHAT_TRANSPORT.sse, payload: JSON.parse(raw) })
        } catch {
          emit({ type: 'message', transport: CHAT_TRANSPORT.sse, payload: { content: raw } })
        }
      }
    }
  }

  if (preferredTransport === CHAT_TRANSPORT.websocket) {
    const wsUrl = buildWsUrl(apiUrl)

    if (wsUrl) {
      socket = new WebSocket(wsUrl, ['openai-insecure-api-key', apiKey, `chat-target=${encodeURIComponent(apiUrl)}`])
      socket.__chatTarget = apiUrl

      socket.addEventListener('open', () => {
        emit({ type: 'open', transport: CHAT_TRANSPORT.websocket })
      })

      socket.addEventListener('message', (event) => {
        try {
          emit({ type: 'message', transport: CHAT_TRANSPORT.websocket, payload: JSON.parse(event.data) })
        } catch {
          emit({ type: 'message', transport: CHAT_TRANSPORT.websocket, payload: { content: event.data } })
        }
      })

      socket.addEventListener('close', () => {
        emit({ type: 'close', transport: CHAT_TRANSPORT.websocket })
      })

      socket.addEventListener('error', () => {
        if (closed) return
        emit({ type: 'error', transport: CHAT_TRANSPORT.websocket, error: new Error('WebSocket 连接失败，请改用 SSE。') })
      })
    } else {
      activeTransport = CHAT_TRANSPORT.sse
      Promise.resolve()
        .then(() => emit({ type: 'fallback', transport: CHAT_TRANSPORT.sse }))
        .catch((error) => emit({ type: 'error', transport: CHAT_TRANSPORT.sse, error }))
    }
  } else {
    emit({ type: 'open', transport: CHAT_TRANSPORT.sse })
  }

  const send = async (message) => {
    const payload = {
      model: message.model || DEFAULT_MODEL,
      stream: true,
      messages: message.messages,
      metadata: message.metadata,
    }

    if (activeTransport === CHAT_TRANSPORT.websocket && socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: 'chat.completion',
          apiKey,
          ...payload,
        }),
      )
      return
    }

    await sendViaSse(payload)
  }

  return { send, close }
}
