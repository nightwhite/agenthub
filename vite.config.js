import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { parse as parseYaml } from 'yaml'
import * as k8s from '@kubernetes/client-node'
import { WebSocket, WebSocketServer } from 'ws'
import { Buffer } from 'node:buffer'
import { PassThrough } from 'node:stream'
import process from 'node:process'

const DEFAULT_K8S_SERVER = process.env.VITE_DEFAULT_K8S_SERVER || ''
const FALLBACK_PROXY_TARGET = DEFAULT_K8S_SERVER || 'https://127.0.0.1:6443'

const toScalar = (value) => {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^['"]|['"]$/g, '')
}

const dedupeTokens = (tokens = []) => {
  const seen = new Set()

  return tokens.filter((token) => {
    const normalized = toScalar(token)
    if (!normalized || seen.has(normalized)) return false
    seen.add(normalized)
    return true
  })
}

const getUserTokenCandidates = (userConfig = {}) => {
  const authProviderConfig = userConfig?.['auth-provider']?.config || userConfig?.authProvider?.config || {}
  const execEnv = Array.isArray(userConfig?.exec?.env) ? userConfig.exec.env : []

  return dedupeTokens([
    userConfig?.token,
    userConfig?.['id-token'],
    userConfig?.['access-token'],
    authProviderConfig?.['id-token'],
    authProviderConfig?.['access-token'],
    ...execEnv.filter((entry) => /token/i.test(entry?.name || '')).map((entry) => entry?.value),
  ])
}

const parseProxyKubeconfig = (authorizationHeader = '') => {
  if (!authorizationHeader || typeof authorizationHeader !== 'string') {
    return { kubeconfig: '', server: '', token: '' }
  }

  try {
    const kubeconfig = decodeURIComponent(authorizationHeader)
    const parsed = parseYaml(kubeconfig) || {}
    const contexts = Array.isArray(parsed.contexts) ? parsed.contexts : []
    const users = Array.isArray(parsed.users) ? parsed.users : []
    const clusters = Array.isArray(parsed.clusters) ? parsed.clusters : []
    const currentContextName = parsed['current-context']
    const selectedContext = contexts.find((item) => item?.name === currentContextName) || contexts[0]
    const selectedUser =
      users.find((item) => item?.name === selectedContext?.context?.user) || users[0]
    const selectedCluster =
      clusters.find((item) => item?.name === selectedContext?.context?.cluster) || clusters[0]

    return {
      kubeconfig,
      server: toScalar(selectedCluster?.cluster?.server),
      token: getUserTokenCandidates(selectedUser?.user || {})[0] || '',
    }
  } catch {
    return { kubeconfig: '', server: '', token: '' }
  }
}

const getRequestUrl = (req) => new URL(req?.url || '/', 'http://localhost')

const getRequestQueryParam = (req, key) => {
  if (!key) return ''
  return toScalar(getRequestUrl(req).searchParams.get(key) || '')
}

const resolveProxyBearerToken = (req) => {
  const parsedKubeconfig = parseProxyKubeconfig(req?.headers?.authorization)
  return parsedKubeconfig.token || getRequestQueryParam(req, 'k8sToken')
}

const resolveProxyTarget = (req) => {
  const requestUrl = getRequestUrl(req)
  const queryServer = requestUrl.searchParams.get('k8sServer')
  const parsedKubeconfig = parseProxyKubeconfig(req?.headers?.authorization)
  const fallbackServer = req?.headers?.['x-k8s-server']

  if (queryServer) {
    return queryServer
  }

  if (parsedKubeconfig.server) {
    return parsedKubeconfig.server
  }

  if (typeof fallbackServer === 'string' && fallbackServer.trim()) {
    return fallbackServer.trim()
  }

  return DEFAULT_K8S_SERVER
}

const applyProxyHeaders = (proxyReq, req) => {
  proxyReq.removeHeader('origin')
  proxyReq.removeHeader('referer')
  proxyReq.removeHeader('x-k8s-server')
  proxyReq.removeHeader('authorization-bearer')

  const bearerToken = resolveProxyBearerToken(req)
  if (bearerToken) {
    proxyReq.setHeader('authorization', `Bearer ${bearerToken}`)
  } else {
    proxyReq.removeHeader('authorization')
  }

  try {
    const targetUrl = new URL(resolveProxyTarget(req) || FALLBACK_PROXY_TARGET)
    proxyReq.setHeader('host', targetUrl.host)
  } catch {
    proxyReq.removeHeader('host')
  }
}

const isExecWsPath = (pathname = '') =>
  /^\/k8s-api\/api\/v1\/namespaces\/[^/]+\/pods\/[^/]+\/exec$/.test(pathname)

const getRequestedWsProtocols = (req) => {
  const raw = req?.headers?.['sec-websocket-protocol']
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

const buildExecWsTarget = (req) => {
  const targetBase = resolveProxyTarget(req) || FALLBACK_PROXY_TARGET
  const requestUrl = getRequestUrl(req)
  const targetUrl = new URL(requestUrl.pathname.replace(/^\/k8s-api/, ''), targetBase)

  for (const [key, value] of requestUrl.searchParams.entries()) {
    if (key === 'k8sToken' || key === 'k8sServer') continue
    targetUrl.searchParams.append(key, value)
  }

  targetUrl.protocol = targetUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  return targetUrl.toString()
}

const writeUpgradeError = (socket, statusCode, message) => {
  if (!socket?.writable) return
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${message}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(message)}`,
      '',
      message,
    ].join('\r\n'),
  )
  socket.destroy()
}

const K8S_STATUS_HEADERS = {
  'Content-Type': 'application/json',
}

const createStatusBody = (status, message, reason = '') => ({
  kind: 'Status',
  apiVersion: 'v1',
  metadata: {},
  status: status >= 400 ? 'Failure' : 'Success',
  message,
  reason: reason || message,
  code: status,
})

const writeJson = (res, status, payload) => {
  res.writeHead(status, K8S_STATUS_HEADERS)
  res.end(JSON.stringify(payload))
}

const readJsonBody = async (req) => {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (!chunks.length) return null

  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : null
}

const getKubeClientBundle = (req) => {
  const { kubeconfig } = parseProxyKubeconfig(req?.headers?.authorization)

  if (!kubeconfig) {
    const error = new Error('Missing kubeconfig authorization header')
    error.statusCode = 401
    error.body = createStatusBody(401, 'Unauthorized', 'Unauthorized')
    throw error
  }

  const kc = new k8s.KubeConfig()
  kc.loadFromString(kubeconfig)

  return {
    kc,
    k8sCore: kc.makeApiClient(k8s.CoreV1Api),
    k8sNetworking: kc.makeApiClient(k8s.NetworkingV1Api),
    k8sCustomObjects: kc.makeApiClient(k8s.CustomObjectsApi),
  }
}

const extractResponseBody = (result) => result?.body ?? result

const extractResponseStatus = (result, fallback = 200) => result?.response?.statusCode || fallback

const writeK8sResult = (res, result, fallbackStatus = 200) => {
  writeJson(res, extractResponseStatus(result, fallbackStatus), extractResponseBody(result))
}

const writeK8sError = (res, error) => {
  const status =
    error?.statusCode ||
    error?.response?.statusCode ||
    error?.body?.code ||
    500

  const payload =
    error?.body ||
    error?.response?.body ||
    createStatusBody(status, error?.message || 'Internal Server Error', status === 401 ? 'Unauthorized' : 'Error')

  writeJson(res, status, payload)
}

const createMiddlewareError = (statusCode, message, reason = 'Error') => {
  const error = new Error(message)
  error.statusCode = statusCode
  error.body = createStatusBody(statusCode, message, reason)
  return error
}

const isHandledFileTransferPath = (pathname = '') => /^\/k8s-api\/files\/(upload|download|list|read|save)$/.test(pathname)

const isHandledK8sPath = (pathname = '') =>
  /^\/k8s-api\/(api\/v1|apis\/devbox\.sealos\.io\/v1alpha2|apis\/networking\.k8s\.io\/v1)/.test(pathname)

const createBufferCollector = () => {
  const chunks = []
  const stream = new PassThrough()
  stream.on('data', (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })

  return {
    stream,
    getBuffer: () => Buffer.concat(chunks),
  }
}

const quoteShellArg = (value = '') => `'${String(value).replace(/'/g, `'\\''`)}'`

const sanitizeFileName = (value = '') => String(value || '').replace(/^.*[\\/]/, '').trim()

const normalizeTargetDirectory = (value = '') => {
  const normalized = String(value || '').trim() || '/home/admin'
  if (normalized === '/') return '/'
  return normalized.replace(/\/+$/, '') || '/'
}

const buildUploadTarget = (targetDirectory = '', fileName = '') => {
  const safeFileName = sanitizeFileName(fileName)
  if (!safeFileName) {
    throw createMiddlewareError(400, '缺少合法文件名', 'BadRequest')
  }

  const normalizedDirectory = normalizeTargetDirectory(targetDirectory)
  return {
    targetDirectory: normalizedDirectory,
    fileName: safeFileName,
    remotePath: normalizedDirectory === '/' ? `/${safeFileName}` : `${normalizedDirectory}/${safeFileName}`,
  }
}

const buildDownloadTarget = (remotePath = '') => {
  const normalizedRemotePath = String(remotePath || '').trim()
  if (!normalizedRemotePath) {
    throw createMiddlewareError(400, '缺少容器内文件路径', 'BadRequest')
  }

  return {
    remotePath: normalizedRemotePath,
    fileName: sanitizeFileName(normalizedRemotePath) || 'download.bin',
  }
}

const getParentDirectoryPath = (value = '') => {
  const normalized = String(value || '').trim()
  if (!normalized || normalized === '/') return '/'
  const segments = normalized.replace(/\/+$/, '').split('/').filter(Boolean)
  segments.pop()
  return segments.length ? `/${segments.join('/')}` : '/'
}

const buildDirectoryListCommand = (targetDirectory = '') => {
  const normalizedDirectory = normalizeTargetDirectory(targetDirectory)
  const script = String.raw`import datetime
import json
import os
import stat
import sys

target = os.environ.get('TARGET_DIR') or '/home/admin'
if not os.path.exists(target):
    sys.stderr.write('目录不存在')
    raise SystemExit(1)
if not os.path.isdir(target):
    sys.stderr.write('目标不是目录')
    raise SystemExit(1)

entries = []
for name in sorted(os.listdir(target), key=lambda value: (not os.path.isdir(os.path.join(target, value)), value.lower())):
    path = os.path.join(target, name) if target != '/' else '/' + name
    info = os.stat(path)
    is_directory = stat.S_ISDIR(info.st_mode)
    entries.append({
        'name': name,
        'path': path,
        'kind': 'directory' if is_directory else 'file',
        'size': None if is_directory else int(info.st_size),
        'updatedAt': datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).astimezone().isoformat(),
    })

print(json.dumps({
    'directory': target,
    'parentDirectory': '/' if target == '/' else os.path.dirname(target.rstrip('/')) or '/',
    'entries': entries,
}, ensure_ascii=False))`

  return [
    'sh',
    '-lc',
    [
      `TARGET_DIR=${quoteShellArg(normalizedDirectory)}`,
      'PYTHON_BIN=""',
      'if command -v python3 >/dev/null 2>&1; then PYTHON_BIN=python3; elif command -v python >/dev/null 2>&1; then PYTHON_BIN=python; fi',
      'if [ -z "$PYTHON_BIN" ]; then echo "容器内缺少 Python，暂不支持目录浏览" >&2; exit 1; fi',
      `"$PYTHON_BIN" - <<'PY'`,
      script,
      'PY',
    ].join('\n'),
  ]
}

const buildReadFileCommand = (remotePath = '') => {
  const target = buildDownloadTarget(remotePath)
  return ['sh', '-lc', `if [ -d ${quoteShellArg(target.remotePath)} ]; then echo "当前路径是目录，不能直接预览" >&2; exit 1; fi; cat ${quoteShellArg(target.remotePath)}`]
}

const buildSaveFileCommand = (remotePath = '') => {
  const target = buildDownloadTarget(remotePath)
  const parentDirectory = getParentDirectoryPath(target.remotePath)
  return ['sh', '-lc', `mkdir -p ${quoteShellArg(parentDirectory)} && cat > ${quoteShellArg(target.remotePath)}`]
}

const getExecFailureMessage = ({ status, stderrBuffer }) => {
  const stderrText = stderrBuffer?.toString('utf8').trim() || ''

  if (status?.status === 'Failure') {
    return status?.message || stderrText || '命令执行失败'
  }

  if (typeof status?.code === 'number' && status.code >= 400) {
    return status?.message || stderrText || '命令执行失败'
  }

  if (stderrText && /(No such file|not found|Permission denied|Is a directory|cannot create|can't create)/i.test(stderrText)) {
    return stderrText
  }

  return ''
}

const execPodCommand = async ({ kc, namespace, podName, containerName, command, stdinBuffer }) => {
  const stdoutCollector = createBufferCollector()
  const stderrCollector = createBufferCollector()
  const stdinStream = new PassThrough()
  const exec = new k8s.Exec(kc)

  if (stdinBuffer?.length) {
    stdinStream.write(stdinBuffer)
  }
  stdinStream.end()

  const status = await new Promise((resolve, reject) => {
    exec
      .exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutCollector.stream,
        stderrCollector.stream,
        stdinStream,
        false,
        (value) => resolve(value || null),
      )
      .catch(reject)
  })

  return {
    status,
    stdout: stdoutCollector.getBuffer(),
    stderr: stderrCollector.getBuffer(),
  }
}

const createViteK8sMiddlewarePlugin = () => ({
  name: 'agenthub-k8s-middleware',
  configureServer(server) {
    const execWss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => {
        for (const protocol of protocols) {
          return protocol
        }
        return false
      },
    })

    const cleanupExecBridge = new Set()

    server.httpServer?.prependListener('upgrade', (req, socket, head) => {
      const requestUrl = getRequestUrl(req)
      if (!isExecWsPath(requestUrl.pathname)) {
        return
      }

      const bearerToken = resolveProxyBearerToken(req)
      if (!bearerToken) {
        writeUpgradeError(socket, 401, 'Missing Kubernetes bearer token')
        return
      }

      let targetUrl = ''
      try {
        targetUrl = buildExecWsTarget(req)
      } catch (error) {
        console.error('[k8s-api] build exec websocket target failed', error)
        writeUpgradeError(socket, 500, 'Failed to build Kubernetes exec target')
        return
      }

      const requestedProtocols = getRequestedWsProtocols(req)

      execWss.handleUpgrade(req, socket, head, (clientWs) => {
        const upstreamWs = new WebSocket(
          targetUrl,
          requestedProtocols.length ? requestedProtocols : undefined,
          {
            rejectUnauthorized: false,
            headers: {
              Authorization: `Bearer ${bearerToken}`,
            },
          },
        )

        const closeBoth = (code = 1011, reason = '') => {
          if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
            clientWs.close(code, reason)
          }
          if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
            upstreamWs.close(code, reason)
          }
        }

        const bridge = { clientWs, upstreamWs }
        cleanupExecBridge.add(bridge)

        upstreamWs.on('open', () => {
          console.info('[k8s-api] exec websocket bridged', {
            targetUrl,
            protocol: upstreamWs.protocol || requestedProtocols[0] || '',
          })
        })

        upstreamWs.on('message', (data, isBinary) => {
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data, { binary: isBinary })
          }
        })

        clientWs.on('message', (data, isBinary) => {
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.send(data, { binary: isBinary })
          }
        })

        upstreamWs.on('close', (code, reason) => {
          cleanupExecBridge.delete(bridge)
          if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
            clientWs.close(code || 1000, reason?.toString?.() || '')
          }
        })

        clientWs.on('close', (code, reason) => {
          cleanupExecBridge.delete(bridge)
          if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) {
            upstreamWs.close(code || 1000, reason?.toString?.() || '')
          }
        })

        upstreamWs.on('error', (error) => {
          console.error('[k8s-api] upstream exec websocket failed', {
            message: error?.message || '',
            targetUrl,
          })
          closeBoth(1011, 'Upstream exec websocket failed')
        })

        clientWs.on('error', (error) => {
          console.error('[k8s-api] client exec websocket failed', {
            message: error?.message || '',
          })
          closeBoth(1011, 'Client exec websocket failed')
        })
      })
    })

    server.httpServer?.once('close', () => {
      for (const { clientWs, upstreamWs } of cleanupExecBridge) {
        try {
          clientWs.close()
        } catch {
          // ignore close error
        }
        try {
          upstreamWs.close()
        } catch {
          // ignore close error
        }
      }
      cleanupExecBridge.clear()
      execWss.close()
    })

    server.middlewares.use(async (req, res, next) => {
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'OPTIONS' || method === 'HEAD') {
        next()
        return
      }

      const requestUrl = new URL(req.url || '/', 'http://localhost')
      const fileTransferRequest = isHandledFileTransferPath(requestUrl.pathname)
      if (!fileTransferRequest && !isHandledK8sPath(requestUrl.pathname)) {
        next()
        return
      }

      try {
        const { kc, k8sCore, k8sNetworking, k8sCustomObjects } = getKubeClientBundle(req)

        if (requestUrl.pathname === '/k8s-api/files/upload') {
          if (method !== 'POST') {
            throw createMiddlewareError(405, 'Method Not Allowed', 'MethodNotAllowed')
          }

          const body = (await readJsonBody(req)) || {}
          const namespace = toScalar(body?.namespace)
          const podName = toScalar(body?.podName)
          const containerName = toScalar(body?.containerName)
          const contentBase64 = typeof body?.contentBase64 === 'string' ? body.contentBase64 : null

          if (!namespace || !podName || !containerName) {
            throw createMiddlewareError(400, '缺少 Pod 上传参数', 'BadRequest')
          }
          if (contentBase64 === null) {
            throw createMiddlewareError(400, '缺少文件内容', 'BadRequest')
          }

          const target = buildUploadTarget(body?.targetDirectory, body?.fileName)
          const fileBuffer = Buffer.from(contentBase64, 'base64')
          const result = await execPodCommand({
            kc,
            namespace,
            podName,
            containerName,
            command: ['sh', '-lc', `mkdir -p ${quoteShellArg(target.targetDirectory)} && cat > ${quoteShellArg(target.remotePath)}`],
            stdinBuffer: fileBuffer,
          })
          const failureMessage = getExecFailureMessage({ status: result.status, stderrBuffer: result.stderr })

          if (failureMessage) {
            throw createMiddlewareError(result.status?.code || 500, `上传失败: ${failureMessage}`, result.status?.reason || 'ExecFailed')
          }

          writeJson(res, 200, {
            ok: true,
            namespace,
            podName,
            containerName,
            fileName: target.fileName,
            remotePath: target.remotePath,
            size: fileBuffer.length,
          })
          return
        }

        if (requestUrl.pathname === '/k8s-api/files/list') {
          if (method !== 'POST') {
            throw createMiddlewareError(405, 'Method Not Allowed', 'MethodNotAllowed')
          }

          const body = (await readJsonBody(req)) || {}
          const namespace = toScalar(body?.namespace)
          const podName = toScalar(body?.podName)
          const containerName = toScalar(body?.containerName)

          if (!namespace || !podName || !containerName) {
            throw createMiddlewareError(400, '缺少目录浏览参数', 'BadRequest')
          }

          const result = await execPodCommand({
            kc,
            namespace,
            podName,
            containerName,
            command: buildDirectoryListCommand(body?.directory),
          })
          const failureMessage = getExecFailureMessage({ status: result.status, stderrBuffer: result.stderr })

          if (failureMessage) {
            throw createMiddlewareError(result.status?.code || 500, `读取目录失败: ${failureMessage}`, result.status?.reason || 'ExecFailed')
          }

          let payload = null
          try {
            payload = JSON.parse(result.stdout.toString('utf8') || '{}')
          } catch {
            throw createMiddlewareError(500, '目录结果解析失败', 'ExecFailed')
          }

          writeJson(res, 200, payload)
          return
        }

        if (requestUrl.pathname === '/k8s-api/files/read') {
          if (method !== 'POST') {
            throw createMiddlewareError(405, 'Method Not Allowed', 'MethodNotAllowed')
          }

          const body = (await readJsonBody(req)) || {}
          const namespace = toScalar(body?.namespace)
          const podName = toScalar(body?.podName)
          const containerName = toScalar(body?.containerName)

          if (!namespace || !podName || !containerName) {
            throw createMiddlewareError(400, '缺少文件读取参数', 'BadRequest')
          }

          const target = buildDownloadTarget(body?.remotePath)
          const result = await execPodCommand({
            kc,
            namespace,
            podName,
            containerName,
            command: buildReadFileCommand(target.remotePath),
          })
          const failureMessage = getExecFailureMessage({ status: result.status, stderrBuffer: result.stderr })

          if (failureMessage) {
            throw createMiddlewareError(result.status?.code || 500, `读取文件失败: ${failureMessage}`, result.status?.reason || 'ExecFailed')
          }

          if (result.stdout.includes(0)) {
            throw createMiddlewareError(415, '当前文件是二进制内容，暂不支持在线预览', 'UnsupportedMediaType')
          }

          if (result.stdout.length > 2 * 1024 * 1024) {
            throw createMiddlewareError(413, '文件过大，暂不支持在线预览，请下载后查看', 'PayloadTooLarge')
          }

          writeJson(res, 200, {
            ok: true,
            fileName: target.fileName,
            remotePath: target.remotePath,
            size: result.stdout.length,
            contentBase64: result.stdout.toString('base64'),
          })
          return
        }

        if (requestUrl.pathname === '/k8s-api/files/download') {
          if (method !== 'POST') {
            throw createMiddlewareError(405, 'Method Not Allowed', 'MethodNotAllowed')
          }

          const body = (await readJsonBody(req)) || {}
          const namespace = toScalar(body?.namespace)
          const podName = toScalar(body?.podName)
          const containerName = toScalar(body?.containerName)

          if (!namespace || !podName || !containerName) {
            throw createMiddlewareError(400, '缺少 Pod 下载参数', 'BadRequest')
          }

          const target = buildDownloadTarget(body?.remotePath)
          const result = await execPodCommand({
            kc,
            namespace,
            podName,
            containerName,
            command: ['sh', '-lc', `cat ${quoteShellArg(target.remotePath)}`],
          })
          const failureMessage = getExecFailureMessage({ status: result.status, stderrBuffer: result.stderr })

          if (failureMessage) {
            throw createMiddlewareError(result.status?.code || 500, `下载失败: ${failureMessage}`, result.status?.reason || 'ExecFailed')
          }

          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(result.stdout.length),
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(target.fileName)}`,
          })
          res.end(result.stdout)
          return
        }

        if (requestUrl.pathname === '/k8s-api/files/save') {
          if (method !== 'POST') {
            throw createMiddlewareError(405, 'Method Not Allowed', 'MethodNotAllowed')
          }

          const body = (await readJsonBody(req)) || {}
          const namespace = toScalar(body?.namespace)
          const podName = toScalar(body?.podName)
          const containerName = toScalar(body?.containerName)
          const contentBase64 = typeof body?.contentBase64 === 'string' ? body.contentBase64 : null

          if (!namespace || !podName || !containerName) {
            throw createMiddlewareError(400, '缺少文件保存参数', 'BadRequest')
          }
          if (contentBase64 === null) {
            throw createMiddlewareError(400, '缺少要保存的内容', 'BadRequest')
          }

          const target = buildDownloadTarget(body?.remotePath)
          const fileBuffer = Buffer.from(contentBase64, 'base64')
          const result = await execPodCommand({
            kc,
            namespace,
            podName,
            containerName,
            command: buildSaveFileCommand(target.remotePath),
            stdinBuffer: fileBuffer,
          })
          const failureMessage = getExecFailureMessage({ status: result.status, stderrBuffer: result.stderr })

          if (failureMessage) {
            throw createMiddlewareError(result.status?.code || 500, `保存失败: ${failureMessage}`, result.status?.reason || 'ExecFailed')
          }

          writeJson(res, 200, {
            ok: true,
            fileName: target.fileName,
            remotePath: target.remotePath,
            size: fileBuffer.length,
            updatedAt: new Date().toISOString(),
          })
          return
        }

        const pathname = requestUrl.pathname.replace(/^\/k8s-api/, '')
        const segments = pathname.split('/').filter(Boolean)
        const labelSelector = requestUrl.searchParams.get('labelSelector') || undefined

        if (segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'namespaces') {
          const namespace = segments[3]
          const resource = segments[4]
          const name = segments[5]

          if (resource === 'services') {
            if (method === 'GET' && !name) {
              writeK8sResult(
                res,
                await k8sCore.listNamespacedService(
                  namespace,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  labelSelector,
                ),
              )
              return
            }

            if (method === 'GET' && name) {
              writeK8sResult(res, await k8sCore.readNamespacedService(name, namespace))
              return
            }

            if (method === 'POST') {
              writeK8sResult(res, await k8sCore.createNamespacedService(namespace, await readJsonBody(req)), 201)
              return
            }

            if (method === 'PUT' && name) {
              writeK8sResult(res, await k8sCore.replaceNamespacedService(name, namespace, await readJsonBody(req)))
              return
            }

            if (method === 'DELETE' && name) {
              writeK8sResult(res, await k8sCore.deleteNamespacedService(name, namespace))
              return
            }
          }

          if (resource === 'pods' && method === 'GET') {
            if (name) {
              writeK8sResult(res, await k8sCore.readNamespacedPod(name, namespace))
              return
            }

            writeK8sResult(
              res,
              await k8sCore.listNamespacedPod(
                namespace,
                undefined,
                undefined,
                undefined,
                undefined,
                labelSelector,
              ),
            )
            return
          }
        }

        if (
          segments[0] === 'apis' &&
          segments[1] === 'networking.k8s.io' &&
          segments[2] === 'v1' &&
          segments[3] === 'namespaces'
        ) {
          const namespace = segments[4]
          const resource = segments[5]
          const name = segments[6]

          if (resource === 'ingresses') {
            if (method === 'GET' && !name) {
              writeK8sResult(
                res,
                await k8sNetworking.listNamespacedIngress(
                  namespace,
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  labelSelector,
                ),
              )
              return
            }

            if (method === 'GET' && name) {
              writeK8sResult(res, await k8sNetworking.readNamespacedIngress(name, namespace))
              return
            }

            if (method === 'POST') {
              writeK8sResult(res, await k8sNetworking.createNamespacedIngress(namespace, await readJsonBody(req)), 201)
              return
            }

            if (method === 'PUT' && name) {
              writeK8sResult(res, await k8sNetworking.replaceNamespacedIngress(name, namespace, await readJsonBody(req)))
              return
            }

            if (method === 'DELETE' && name) {
              writeK8sResult(res, await k8sNetworking.deleteNamespacedIngress(name, namespace))
              return
            }
          }
        }

        if (
          segments[0] === 'apis' &&
          segments[1] === 'devbox.sealos.io' &&
          segments[2] === 'v1alpha2' &&
          segments[3] === 'namespaces'
        ) {
          const namespace = segments[4]
          const resource = segments[5]
          const name = segments[6]

          if (resource === 'devboxes') {
            if (method === 'GET' && !name) {
              writeK8sResult(
                res,
                await k8sCustomObjects.listNamespacedCustomObject(
                  'devbox.sealos.io',
                  'v1alpha2',
                  namespace,
                  'devboxes',
                  undefined,
                  undefined,
                  undefined,
                  undefined,
                  labelSelector,
                ),
              )
              return
            }

            if (method === 'GET' && name) {
              writeK8sResult(
                res,
                await k8sCustomObjects.getNamespacedCustomObject(
                  'devbox.sealos.io',
                  'v1alpha2',
                  namespace,
                  'devboxes',
                  name,
                ),
              )
              return
            }

            if (method === 'POST') {
              writeK8sResult(
                res,
                await k8sCustomObjects.createNamespacedCustomObject(
                  'devbox.sealos.io',
                  'v1alpha2',
                  namespace,
                  'devboxes',
                  await readJsonBody(req),
                ),
                201,
              )
              return
            }

            if (method === 'PUT' && name) {
              writeK8sResult(
                res,
                await k8sCustomObjects.replaceNamespacedCustomObject(
                  'devbox.sealos.io',
                  'v1alpha2',
                  namespace,
                  'devboxes',
                  name,
                  await readJsonBody(req),
                ),
              )
              return
            }

            if (method === 'DELETE' && name) {
              writeK8sResult(
                res,
                await k8sCustomObjects.deleteNamespacedCustomObject(
                  'devbox.sealos.io',
                  'v1alpha2',
                  namespace,
                  'devboxes',
                  name,
                ),
              )
              return
            }
          }
        }

        next()
      } catch (error) {
        writeK8sError(res, error)
      }
    })
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), createViteK8sMiddlewarePlugin()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@xterm/')) {
            return 'xterm-vendor'
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react-vendor'
          }
          if (id.includes('node_modules/@labring/sealos-desktop-sdk')) {
            return 'sealos-sdk'
          }
          if (id.includes('node_modules')) {
            return 'vendor'
          }
        },
      },
    },
  },
  server: {
    allowedHosts: true,
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/k8s-api': {
        target: FALLBACK_PROXY_TARGET,
        changeOrigin: true,
        secure: false,
        ws: false,
        rewrite: (path) => path.replace(/^\/k8s-api/, ''),
        router: (req) => resolveProxyTarget(req),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            applyProxyHeaders(proxyReq, req)
          })

          proxy.on('proxyReqWs', (proxyReq, req) => {
            applyProxyHeaders(proxyReq, req)
          })
        },
      },
      '/chat-api': {
        target: 'https://nntlgzzjjfcz.staging-usw-1.sealos.io',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/chat-api/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
            proxyReq.setHeader('host', 'nntlgzzjjfcz.staging-usw-1.sealos.io')
          })
        },
      },
      '/chat-api-ws': {
        target: 'wss://nntlgzzjjfcz.staging-usw-1.sealos.io',
        changeOrigin: true,
        secure: false,
        ws: true,
        rewrite: (path) => path.replace(/^\/chat-api-ws/, ''),
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
            proxyReq.setHeader('host', 'nntlgzzjjfcz.staging-usw-1.sealos.io')
          })
        },
      },
    },
  },
})
