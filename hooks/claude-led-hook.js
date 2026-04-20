#!/usr/bin/env node
// claude-led-hook.js
// Hook universal do Claude Code. Lê o JSON do evento em stdin, grava o estado
// atual da sessão num arquivo, e termina. Nunca bloqueia nem modifica decisões.
//
// Uso no ~/.claude/settings.json (ver settings.json neste pacote).
//
// Args: --event <UserPromptSubmit|PreToolUse|PreToolUseMcp|PreCompact|Stop|StopFailure|Notification|SessionEnd>

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const STATE_DIR = path.join(os.homedir(), '.claude-led', 'sessions')
const CHANNELS_DIR = path.join(os.homedir(), '.claude-led', 'channels')

// Canais globais (não-sessão) com TTL, usados pelo daemon v0.2.0+.
// Cada canal vive como ~/.claude-led/channels/<name>.json com { expires_at }.
// O daemon lê a cada tick e ignora os expirados.
function writeChannel(name, ttlMs, extra = {}) {
  fs.mkdirSync(CHANNELS_DIR, { recursive: true })
  const file = path.join(CHANNELS_DIR, `${name}.json`)
  const now = Date.now()
  const payload = {
    channel: name,
    activated_at: now,
    expires_at: now + ttlMs,
    ...extra
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(payload))
  fs.renameSync(tmp, file)
}

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

function auditLog(event, input, note = '') {
  // Audit log unificado: registra TODO evento recebido com campos-chave
  // do payload. Fundamental para diagnosticar casos de LED em estado
  // inesperado em produção.
  try {
    ensureDir(STATE_DIR)
    const keys = Object.keys(input || {}).slice(0, 20).join(',')
    const line = `[${new Date().toISOString()}] event=${event} ` +
      `session=${(input.session_id || 'unknown').slice(0, 8)} ` +
      `type=${input.notification_type || input.type || '-'} ` +
      `tool=${input.tool_name || '-'} ` +
      `keys=[${keys}]` +
      (note ? ` note=${note}` : '')
    fs.appendFileSync(path.join(STATE_DIR, 'hook.log'), line + '\n')
  } catch (_) { /* noop */ }
}

;(async () => {
  try {
    const { event } = parseArgs(process.argv)
    const raw = await readStdin()
    let input = {}
    try { input = raw ? JSON.parse(raw) : {} } catch (_) { input = {} }

    const sessionId = input.session_id || process.env.CLAUDE_SESSION_ID || 'unknown'
    const cwd = input.cwd || process.cwd()

    auditLog(event || '(no-event)', input)

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

      case 'PreToolUseMcp': {
        // Disparado apenas quando PreToolUse tem matcher 'mcp__*'.
        // Marca o canal 'mcp' com TTL 30s — se o tool call demorar mais,
        // o hook é chamado de novo (PreToolUse dispara antes de cada tool).
        const toolName = input.tool_name || input.tool || ''
        writeChannel('mcp', 30_000, { tool_name: toolName, session_id: sessionId })
        // Mantém a semântica de 'working' na sessão.
        writeState(sessionId, 'working', { cwd })
        break
      }

      case 'PreCompact':
        // Claude Code vai compactar o contexto — operação demorada.
        // TTL 120s cobre com folga (usualmente <30s). Se houver outra
        // compactação, o arquivo é reescrito com TTL renovado.
        writeChannel('precompact', 120_000, { session_id: sessionId })
        break

      case 'Stop':
        // Claude terminou o turno sem pedir nada => ocioso
        writeState(sessionId, 'idle', { cwd })
        break

      case 'Notification': {
        // Só tratamos como 'waiting' notifications que realmente bloqueiam
        // o turno: permission_prompt e elicitation_dialog. idle_prompt
        // (lembrete periódico do Claude Code após ~60s sem atividade) NÃO
        // é bloqueante — o usuário pode simplesmente ignorar —, então não
        // deve sequestrar o LED. Tipos desconhecidos preservam o estado.
        const t = (input.notification_type || input.type || '').toLowerCase()
        const isWaiting =
          t.includes('permission') ||
          t.includes('elicit')
        // (audit log do tipo já registrado pelo auditLog() acima)
        if (isWaiting) {
          writeState(sessionId, 'waiting', { cwd, notification_type: t })
        }
        break
      }

      case 'StopFailure': {
        // Turno terminou por API error (rate limit do servidor, timeout,
        // erro 5xx, contexto estourado, etc.). Diferente do canal global
        // api_outage (status.claude.com) — este é per-session/per-turn.
        // Sinaliza via canal session_issue com TTL 60s -> ORANGE_BLINK
        // prio 85 no daemon. Marca a sessão como idle (turno acabou).
        writeChannel('session_issue', 60_000, {
          session_id: sessionId,
          source: 'StopFailure',
          last_message: (input.last_assistant_message || '').slice(0, 200)
        })
        writeState(sessionId, 'idle', { cwd })
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
