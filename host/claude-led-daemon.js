#!/usr/bin/env node
// claude-led-daemon.js (v0.2.0)
// Observa ~/.claude-led/{sessions,channels}/ + detectores passivos
// e dirige o LED do RP2040-Zero via serial.
//
// Canais suportados (ordenados por prioridade, maior primeiro):
//
//   100  rate_limit        RED_SOLID      leitura ~/.claude/claudewatch-usage.json
//    90  sessions:waiting  RED_FAST       hook Notification (permission/elicit)
//    85  session_issue     ORANGE_BLINK   hook StopFailure (API error per-turn)
//    75  api_outage:major  MAGENTA_FAST   status.claude.com = major/partial_outage
//    60  chrome_devtools   BLUE_BLINK     lsof -iTCP:9222 -sTCP:LISTEN
//    50  mcp               BLUE_PULSE     hook PreToolUse matcher mcp__*
//    40  sessions:working  GREEN_PULSE    todas as sessões ativas em working
//    30  sessions:mix      GREEN_BLINK    working + idle simultâneos (transição)
//    20  precompact        YELLOW_SLOW    hook PreCompact
//    15  api_outage:degrad MAGENTA_PULSE  status.claude.com = degraded_performance
//     0  (default)         OFF            nada ativo
//
// Hot-plug: se a placa não estiver presente, o daemon fica tentando reabrir.

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')
const { SerialPort } = require('serialport')

const HOME = os.homedir()
const CLAUDE_LED_DIR = path.join(HOME, '.claude-led')
const STATE_DIR = path.join(CLAUDE_LED_DIR, 'sessions')
const CHANNELS_DIR = path.join(CLAUDE_LED_DIR, 'channels')
const CLAUDEWATCH_FILE = path.join(HOME, '.claude', 'claudewatch-usage.json')

const IDLE_TTL_MS = 6 * 60 * 60 * 1000 // 6h: limpa sessão esquecida
const STALE_WORKING_MS = 5 * 60 * 1000 // 5min: sessão 'working' sem updates
                                        // é considerada stale (interrupt/trava)
                                        // e tratada como idle em memória. O Claude
                                        // Code NÃO dispara hook em user interrupt
                                        // (ESC/Ctrl+C) — só fallback é timeout.
const PING_INTERVAL_MS = 10_000        // reenvio periódico (refresca watchdog do firmware)
const SCAN_INTERVAL_MS = 1_500         // reavaliação principal

const RECONNECT_INTERVAL_MS = 2_000

// Caches dos detectores passivos
const CACHE_RATE_LIMIT_MS = 60_000
const CACHE_API_OUTAGE_MS = 30_000
const CACHE_CHROME_DEVTOOLS_MS = 3_000

// --- Detecção da placa --------------------------------------------------------
const ACCEPTED_VIDS = ['239a', '2e8a']

async function findPort() {
  const ports = await SerialPort.list()
  let candidates = ports.filter((p) => {
    const vid = (p.vendorId || '').toLowerCase()
    return ACCEPTED_VIDS.includes(vid)
  })
  if (process.platform === 'darwin') {
    // No macOS, SerialPort.list() só reporta /dev/tty.usbmodem*, mas o
    // /dev/cu.usbmodem* espelhado existe e é preferível: open() é non-blocking
    // e não depende de DCD (USB-CDC não tem carrier real). Convertemos o prefixo.
    candidates = candidates.map((p) => ({
      ...p,
      path: (p.path || '').replace(/^\/dev\/tty\./, '/dev/cu.')
    }))
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.path || '').localeCompare(b.path || ''))
  return candidates[candidates.length - 1].path
}

// --- Serial state -------------------------------------------------------------
let port = null
let lastCommandSent = null
let lastCommandTs = 0

function openPort() {
  findPort().then((devPath) => {
    if (!devPath) {
      setTimeout(openPort, RECONNECT_INTERVAL_MS)
      return
    }
    const sp = new SerialPort({ path: devPath, baudRate: 115200, autoOpen: false })
    sp.open((err) => {
      if (err) {
        setTimeout(openPort, RECONNECT_INTERVAL_MS)
        return
      }
      port = sp
      lastCommandSent = null
      console.log(`[claude-led] conectado em ${devPath}`)
    })
    sp.on('error', () => { try { sp.close() } catch (_) {} })
    sp.on('close', () => {
      console.log('[claude-led] porta fechada, tentando reconectar…')
      port = null
      lastCommandSent = null
      setTimeout(openPort, RECONNECT_INTERVAL_MS)
    })
  }).catch(() => setTimeout(openPort, RECONNECT_INTERVAL_MS))
}

function sendCommand(cmd, { force = false } = {}) {
  const now = Date.now()
  if (!force && cmd === lastCommandSent && (now - lastCommandTs) < PING_INTERVAL_MS) return
  if (!port || !port.writable) return
  try {
    port.write(`${cmd}\n`)
    lastCommandSent = cmd
    lastCommandTs = now
  } catch (_) { /* noop */ }
}

// --- Sessions -----------------------------------------------------------------
function readSessions() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch (_) {}
  let files = []
  try { files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')) } catch (_) {}
  const now = Date.now()
  const sessions = []
  for (const f of files) {
    const full = path.join(STATE_DIR, f)
    try {
      const raw = fs.readFileSync(full, 'utf8')
      const data = JSON.parse(raw)
      if (!data.status) continue
      if (now - (data.updated_at || 0) > IDLE_TTL_MS) {
        try { fs.unlinkSync(full) } catch (_) {}
        continue
      }
      // Sessão 'working' sem updates há > STALE_WORKING_MS é tratada como idle.
      // Motivo: o Claude Code não dispara hook em user interrupt (ESC/Ctrl+C),
      // então a sessão fica travada em 'working' até o próximo UserPromptSubmit
      // ou PreToolUse. Preservamos o arquivo no disco para não competir com
      // hooks reais da mesma sessão — só sobrescrevemos o status em memória.
      if (data.status === 'working' && now - (data.updated_at || 0) > STALE_WORKING_MS) {
        data = { ...data, status: 'idle', _stale: true }
      }
      sessions.push(data)
    } catch (_) { /* ignore malformed */ }
  }
  return sessions
}

// --- Channels (hook-written) --------------------------------------------------
function readChannels() {
  try { fs.mkdirSync(CHANNELS_DIR, { recursive: true }) } catch (_) {}
  let files = []
  try { files = fs.readdirSync(CHANNELS_DIR).filter((f) => f.endsWith('.json')) } catch (_) {}
  const now = Date.now()
  const active = new Set()
  for (const f of files) {
    const full = path.join(CHANNELS_DIR, f)
    try {
      const raw = fs.readFileSync(full, 'utf8')
      const data = JSON.parse(raw)
      if (!data.channel || !data.expires_at) continue
      if (now > data.expires_at) {
        try { fs.unlinkSync(full) } catch (_) {}
        continue
      }
      active.add(data.channel)
    } catch (_) { /* ignore malformed */ }
  }
  return active
}

// --- Passive detectors --------------------------------------------------------
const detectorCache = {
  rate_limit: { ts: 0, value: false },
  // api_outage.value é severidade: null | 'degraded' | 'partial' | 'major'
  api_outage: { ts: 0, value: null },
  chrome_devtools: { ts: 0, value: false }
}

function checkRateLimit() {
  const now = Date.now()
  if (now - detectorCache.rate_limit.ts < CACHE_RATE_LIMIT_MS) {
    return detectorCache.rate_limit.value
  }
  let hit = false
  try {
    const raw = fs.readFileSync(CLAUDEWATCH_FILE, 'utf8')
    const data = JSON.parse(raw)
    // Qualquer percentual >= 100 conta como atingido.
    const pcts = []
    for (const k of Object.keys(data || {})) {
      const v = data[k]
      if (typeof v === 'number') pcts.push(v)
      if (v && typeof v === 'object' && typeof v.percent === 'number') pcts.push(v.percent)
      if (v && typeof v === 'object' && typeof v.pct === 'number') pcts.push(v.pct)
    }
    hit = pcts.some((p) => p >= 100)
  } catch (_) {
    hit = false // arquivo ausente = canal inerte, não é erro
  }
  detectorCache.rate_limit = { ts: now, value: hit }
  return hit
}

// Retorna a severidade máxima dos componentes "api" no status page.
// null | 'degraded' | 'partial' | 'major'.
// Fire-and-forget: usa cache anterior enquanto refresca. Em falha de rede,
// assume null (operacional) para não soar alarme falso durante problemas locais.
function checkApiOutage() {
  const now = Date.now()
  if (now - detectorCache.api_outage.ts < CACHE_API_OUTAGE_MS) {
    return detectorCache.api_outage.value
  }
  const stamp = now
  ;(async () => {
    try {
      const ctrl = new AbortController()
      const to = setTimeout(() => ctrl.abort(), 5000)
      const r = await fetch('https://status.claude.com/api/v2/components.json', { signal: ctrl.signal })
      clearTimeout(to)
      const data = await r.json()
      const components = data?.components || []
      // Escolhe a pior severidade entre componentes cujo nome contém "api".
      // Ordem: major > partial > degraded > null.
      const rank = { major: 3, partial: 2, degraded: 1 }
      let worst = null
      for (const c of components) {
        const name = String(c.name || '').toLowerCase()
        if (!name.includes('api')) continue
        const status = String(c.status || '').toLowerCase()
        let sev = null
        if (status === 'major_outage') sev = 'major'
        else if (status === 'partial_outage') sev = 'partial'
        else if (status === 'degraded_performance') sev = 'degraded'
        if (sev && (!worst || rank[sev] > rank[worst])) worst = sev
      }
      detectorCache.api_outage = { ts: stamp, value: worst }
    } catch (_) {
      detectorCache.api_outage = { ts: stamp, value: null }
    }
  })()
  return detectorCache.api_outage.value
}

function checkChromeDevtools() {
  const now = Date.now()
  if (now - detectorCache.chrome_devtools.ts < CACHE_CHROME_DEVTOOLS_MS) {
    return detectorCache.chrome_devtools.value
  }
  const stamp = now
  // Executa `lsof` async — se alguém escuta a 9222, retorna PID(s) na stdout.
  execFile('lsof', ['-iTCP:9222', '-sTCP:LISTEN', '-t'], { timeout: 2000 }, (err, stdout) => {
    const active = !err && stdout && stdout.trim().length > 0
    detectorCache.chrome_devtools = { ts: stamp, value: !!active }
  })
  return detectorCache.chrome_devtools.value
}

// --- Aggregation --------------------------------------------------------------
function decideCommand() {
  const sessions = readSessions()
  const channels = readChannels()

  // Lista em ordem decrescente de prioridade; primeiro que bater vence.
  // [prio, cmd, condition]
  const rules = [
    [100, 'RED_SOLID',    () => checkRateLimit()],
    [ 90, 'RED_FAST',     () => sessions.some((s) => s.status === 'waiting')],
    [ 85, 'ORANGE_BLINK', () => channels.has('session_issue')],
    [ 75, 'MAGENTA_FAST', () => {
      const sev = checkApiOutage()
      return sev === 'major' || sev === 'partial'
    }],
    [ 60, 'BLUE_BLINK',   () => checkChromeDevtools()],
    [ 50, 'BLUE_PULSE',   () => channels.has('mcp')],
    [ 40, 'GREEN_PULSE',  () => {
      // todas as sessões ativas estão trabalhando: regime estacionário,
      // sem transição recente — pulse (ambiente) em vez de blink (alerta)
      const hasWorking = sessions.some((s) => s.status === 'working')
      const hasIdle = sessions.some((s) => s.status === 'idle')
      return hasWorking && !hasIdle
    }],
    [ 30, 'GREEN_BLINK',  () => {
      // mix working + idle: alguma sessão acabou de terminar, estado de
      // transição que merece olhar — blink chama mais atenção periférica
      const hasWorking = sessions.some((s) => s.status === 'working')
      const hasIdle = sessions.some((s) => s.status === 'idle')
      return hasWorking && hasIdle
    }],
    [ 20, 'YELLOW_SLOW',  () => channels.has('precompact')],
    [ 15, 'MAGENTA_PULSE', () => checkApiOutage() === 'degraded']
  ]

  for (const [, cmd, test] of rules) {
    try { if (test()) return cmd } catch (_) { /* detector falhou, pula */ }
  }
  return 'OFF'
}

function tick() {
  const cmd = decideCommand()
  const force = (Date.now() - lastCommandTs) >= PING_INTERVAL_MS
  sendCommand(cmd, { force })
}

// --- Main --------------------------------------------------------------------
console.log(`[claude-led] watching ${STATE_DIR} + ${CHANNELS_DIR}`)
try { fs.mkdirSync(CHANNELS_DIR, { recursive: true }) } catch (_) {}
openPort()
setInterval(tick, SCAN_INTERVAL_MS)

function shutdown() {
  try { if (port && port.writable) port.write('OFF\n') } catch (_) {}
  setTimeout(() => process.exit(0), 100)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
