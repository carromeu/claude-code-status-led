#!/usr/bin/env node
// claude-led-daemon.js
// Observa ~/.claude-led/sessions/ e dirige o LED do RP2040-Zero via serial.
//
// Regras de agregação:
//   any waiting              -> RED_BLINK
//   all working (>=1)        -> GREEN_BLINK
//   mix working + idle       -> GREEN
//   zero sessões ou all idle -> OFF
//
// Hot-plug: se a placa não estiver presente, o daemon fica tentando reabrir.
// Sessões "fantasmas" (TTL) são ignoradas depois de IDLE_TTL_MS sem updates.

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { SerialPort } = require('serialport')

const STATE_DIR = path.join(os.homedir(), '.claude-led', 'sessions')
const IDLE_TTL_MS = 6 * 60 * 60 * 1000 // 6h: limpa sessão esquecida
const PING_INTERVAL_MS = 10_000        // manda estado a cada 10s (refresca watchdog do firmware)
const SCAN_INTERVAL_MS = 1_500         // reavaliação principal
const RECONNECT_INTERVAL_MS = 2_000    // tentativa de reconexão da serial

// --- Detecção da placa --------------------------------------------------------
// RP2040 CircuitPython: VID 0x239A (Adafruit) em builds oficiais, ou
// 0x2E8A (Raspberry Pi) dependendo do firmware. Vamos aceitar os dois.
// Usamos o segundo canal CDC (data), que geralmente é o /dev/ttyACM1.
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
  // prefere o segundo canal (CDC data) quando existem dois endpoints do mesmo device
  candidates.sort((a, b) => (a.path || '').localeCompare(b.path || ''))
  return candidates[candidates.length - 1].path
}

// --- Estado -------------------------------------------------------------------
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
      lastCommandSent = null // força reenvio
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

// --- Agregação ---------------------------------------------------------------
function readSessions() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }) } catch (_) {}
  const files = fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json'))
  const now = Date.now()
  const sessions = []
  for (const f of files) {
    const full = path.join(STATE_DIR, f)
    try {
      const raw = fs.readFileSync(full, 'utf8')
      const data = JSON.parse(raw)
      if (!data.status) continue
      if (now - (data.updated_at || 0) > IDLE_TTL_MS) {
        // sessão fantasma: remove
        try { fs.unlinkSync(full) } catch (_) {}
        continue
      }
      sessions.push(data)
    } catch (_) {
      // arquivo malformado — ignora
    }
  }
  return sessions
}

function decideCommand(sessions) {
  if (sessions.length === 0) return 'OFF'
  const hasWaiting = sessions.some((s) => s.status === 'waiting')
  if (hasWaiting) return 'RED_BLINK'
  const hasWorking = sessions.some((s) => s.status === 'working')
  const hasIdle = sessions.some((s) => s.status === 'idle')
  if (hasWorking && !hasIdle) return 'GREEN_BLINK'
  if (hasWorking && hasIdle) return 'GREEN'
  // só idle (ou status desconhecidos)
  return 'OFF'
}

function tick() {
  const sessions = readSessions()
  const cmd = decideCommand(sessions)
  // força reenvio periódico para renovar o watchdog do firmware
  const force = (Date.now() - lastCommandTs) >= PING_INTERVAL_MS
  sendCommand(cmd, { force })
}

// --- Main --------------------------------------------------------------------
console.log(`[claude-led] watching ${STATE_DIR}`)
openPort()
setInterval(tick, SCAN_INTERVAL_MS)

// Ao sair, apaga o LED
function shutdown() {
  try { if (port && port.writable) port.write('OFF\n') } catch (_) {}
  setTimeout(() => process.exit(0), 100)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
