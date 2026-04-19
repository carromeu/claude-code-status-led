#!/usr/bin/env node
// claude-led-hook.js
// Hook universal do Claude Code. Lê o JSON do evento em stdin, grava o estado
// atual da sessão num arquivo, e termina. Nunca bloqueia nem modifica decisões.
//
// Uso no ~/.claude/settings.json (ver settings.json neste pacote).
//
// Args: --event <UserPromptSubmit|PreToolUse|Stop|Notification|SessionEnd>

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const STATE_DIR = path.join(os.homedir(), '.claude-led', 'sessions')

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readStdin() {
  return new Promise((resolve) => {
    let data = ''
    if (process.stdin.isTTY) return resolve('')
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    // segurança: timeout de 500ms para não segurar o Claude Code
    setTimeout(() => resolve(data), 500)
  })
}

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--event' && argv[i + 1]) { out.event = argv[++i] }
  }
  return out
}

function writeState(sessionId, status, extra = {}) {
  ensureDir(STATE_DIR)
  const file = path.join(STATE_DIR, `${sessionId}.json`)
  const payload = {
    session_id: sessionId,
    status, // 'working' | 'idle' | 'waiting'
    updated_at: Date.now(),
    ...extra
  }
  // escrita atômica
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload))
  fs.renameSync(tmp, file)
}

function removeState(sessionId) {
  const file = path.join(STATE_DIR, `${sessionId}.json`)
  try { fs.unlinkSync(file) } catch (_) { /* noop */ }
}

;(async () => {
  try {
    const { event } = parseArgs(process.argv)
    const raw = await readStdin()
    let input = {}
    try { input = raw ? JSON.parse(raw) : {} } catch (_) { input = {} }

    const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || 'unknown'
    const cwd = input.cwd || process.cwd()

    switch (event) {
      case 'UserPromptSubmit':
        // usuário acabou de submeter prompt => Claude está trabalhando
        writeState(sessionId, 'working', { cwd })
        break

      case 'PreToolUse':
        // Claude invocou uma ferramenta => claramente trabalhando.
        // Serve para sair de 'waiting' quando o usuário responde um prompt
        // interno (ex.: AskUserQuestion, permission prompt) sem novo
        // UserPromptSubmit. Ruído é amortecido pelo tick de 1.5s do daemon.
        writeState(sessionId, 'working', { cwd })
        break

      case 'Stop':
        // Claude terminou o turno sem pedir nada => ocioso
        writeState(sessionId, 'idle', { cwd })
        break

      case 'Notification': {
        // matcher típicos: permission_prompt, idle_prompt, elicitation_dialog
        // todos significam "precisa do humano" => elucidação.
        // Se o tipo não bater em nenhum padrão conhecido, NÃO escrevemos —
        // preserva o estado anterior. Evita falsos-positivos de system
        // notifications externas (ex.: eventos USB/hotplug do macOS).
        const t = (input.notification_type || input.type || '').toLowerCase()
        const isWaiting =
          t.includes('permission') ||
          t.includes('idle') ||
          t.includes('elicit') ||
          t.includes('input')
        if (isWaiting) {
          writeState(sessionId, 'waiting', { cwd, notification_type: t })
        }
        break
      }

      case 'SessionEnd':
        removeState(sessionId)
        break

      default:
        // evento desconhecido — ignora
        break
    }
  } catch (err) {
    // nunca falhar o hook; logar em arquivo é opcional
    try {
      ensureDir(STATE_DIR)
      fs.appendFileSync(
        path.join(STATE_DIR, 'hook.log'),
        `[${new Date().toISOString()}] ${err.stack || err.message}\n`
      )
    } catch (_) { /* noop */ }
  } finally {
    process.exit(0)
  }
})()
