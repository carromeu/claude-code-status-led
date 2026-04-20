# Especificação Técnica — Claude Code Status LED

> Documento de referência para agentes de IA e desenvolvedores humanos que precisem entender, modificar ou estender este projeto. Cobre arquitetura, protocolos, formatos de dados, fluxos de controle e decisões de design implementadas **até a versão 0.2.0**.

## 1. Visão geral

O projeto reflete em um LED WS2812 físico (conectado via USB-C) o estado agregado de múltiplas sessões do Claude Code e de alguns sinais ambientais do host, sem exigir nenhuma chamada manual durante o fluxo de trabalho.

### 1.1. Componentes

```
┌──────────────────────────────────────────────────────────────┐
│  N sessões do Claude Code (processos independentes)          │
└────────────────────────────┬─────────────────────────────────┘
                             │
                 hooks: UserPromptSubmit, PreToolUse,
                        PreCompact, Notification, Stop,
                        SessionEnd
                             ▼
        ~/.claude-led/sessions/<session_id>.json   (uma sessão por arquivo)
        ~/.claude-led/channels/<canal>.json        (canais com TTL)
                             │
                             │ polling 1,5 s
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  claude-led-daemon.js                                        │
│  - Lê sessões + canais                                       │
│  - Detectores passivos (rate limit, API outage, DevTools)    │
│  - Escolhe comando por prioridade                            │
│  - Envia via USB-CDC                                         │
│  - Reconecta em hot-plug                                     │
└────────────────────────────┬─────────────────────────────────┘
                             │ USB-CDC @ 115200 8N1
                             ▼
┌──────────────────────────────────────────────────────────────┐
│  RP2040-Zero + CircuitPython 9.x                             │
│  - code.py com watchdog de 30 s                              │
│  - WS2812 onboard em GP16 via `neopixel_write` built-in      │
└──────────────────────────────────────────────────────────────┘
```

### 1.2. Requisitos não funcionais atendidos

- Latência de mudança de estado ≤ 2 s (tick do daemon 1,5 s + overhead serial ~200 ms).
- Tolerância a falhas: watchdog de 30 s no firmware; daemon reconecta automaticamente em desconexão USB.
- Sem root recorrente: no macOS nenhum `sudo` é exigido após a instalação; no Linux apenas `usermod -aG dialout` e a instalação do udev rule.
- Zero dependência obscura: Node.js 18+, Python 3 do CircuitPython, `serialport` do npm.
- Autonomia total: nenhuma ferramenta precisa ser chamada manualmente no dia-a-dia.

---

## 2. Hardware

### 2.1. Placa alvo

**Waveshare RP2040-Zero**, com as seguintes características relevantes:

- Microcontrolador RP2040 (Raspberry Pi Pico) em formato minúsculo (~18 × 23 mm).
- WS2812 RGB endereçável **onboard em GP16**, sem cablagem externa.
- USB-C nativo com suporte a CDC duplo (console + data).
- Botões BOOT e RESET físicos — flash inicial via drag-and-drop de UF2.

Compatível com outros RP2040 que tenham WS2812 onboard — basta garantir que `board.NEOPIXEL` resolve para o pino correto no CircuitPython.

### 2.2. USB IDs aceitos

O daemon aceita as placas cujo `vendorId` pertença ao conjunto:

| VID    | Fabricante            |
|--------|-----------------------|
| `239A` | Adafruit              |
| `2E8A` | Raspberry Pi Ltd.     |

Se você flashar um firmware CircuitPython oficial no Waveshare RP2040-Zero, o VID é `2E8A` (Raspberry Pi). Builds custom da Adafruit usam `239A`.

---

## 3. Firmware (`firmware/`)

### 3.1. Arquivos

- **`boot.py`** — executado uma vez no hard reset (power-cycle); habilita o canal CDC `data`. Um soft reboot (editar arquivos em `/Volumes/CIRCUITPY` disparado pelo CircuitPython) **não** re-executa o `boot.py`.
- **`code.py`** — executado sempre que o CircuitPython detecta mudança em arquivos do volume CIRCUITPY. Implementa o loop principal e o protocolo serial.

### 3.2. Escolha do runtime

Foi deliberadamente escolhido **CircuitPython 9.x** em vez de MicroPython ou C/Pico SDK pelos seguintes motivos:

1. `board.NEOPIXEL` e `usb_cdc.data` prontos para uso — sem PIO custom, sem compilação.
2. Código legível (~220 linhas) com legibilidade equivalente a Python standard.
3. Performance mais que suficiente — o LED pisca a no máximo 3,33 Hz (RED_FAST a 0,3 s), não a kHz.

### 3.3. Uso de `neopixel_write` built-in (e **não** da lib `neopixel`)

**Importante**: o firmware usa o módulo built-in `neopixel_write` do núcleo do CircuitPython, e **não** a biblioteca `neopixel` externa (que vira `/lib/neopixel.mpy` no volume CIRCUITPY).

Motivo histórico: uma versão anterior do firmware importava `neopixel` e resultava em `ImportError: no module named 'neopixel'` logo após o boot, indicado pelo padrão de 2 blinks vermelhos do status LED do CircuitPython. A lib externa não acompanha o firmware core e precisaria ser copiada manualmente.

Uso correto:

```python
import digitalio
import neopixel_write
import board

pin = digitalio.DigitalInOut(board.NEOPIXEL)
pin.direction = digitalio.Direction.OUTPUT
neopixel_write.neopixel_write(pin, bytearray([g, r, b]))  # ordem GRB!
```

A ordem dos bytes para WS2812 é **GRB** (não RGB).

### 3.4. Canal CDC duplo

O `boot.py` chama:

```python
import usb_cdc
usb_cdc.enable(console=True, data=True)
```

Isso cria **dois** endpoints CDC no mesmo dispositivo USB:

| Endpoint | macOS (exemplo) | Uso                                   |
|----------|-----------------|---------------------------------------|
| console  | `/dev/cu.usbmodem4101` | REPL interativo do CircuitPython |
| data     | `/dev/cu.usbmodem4103` | Canal de comando usado pelo daemon |

O daemon escolhe o endpoint de **maior ordem lexicográfica** entre os dispositivos do mesmo VID — no Linux, `ttyACM1` (data) sobre `ttyACM0` (console); no macOS, `usbmodem4103` sobre `usbmodem4101`.

Se o daemon só enxergar um endpoint, o `boot.py` não está ativo (a placa pode ter passado apenas por soft reboot após o flash inicial — veja 3.1). Como fallback defensivo, o `code.py` tenta `usb_cdc.data` e cai para `usb_cdc.console` se o primeiro for `None`.

### 3.5. Protocolo serial

- **Baudrate**: 115200
- **Frame**: 8N1
- **Codificação**: texto ASCII, comandos separados por `\n`, case-insensitive
- **Comandos desconhecidos**: ignorados silenciosamente

#### 3.5.1. Comandos suportados

| Comando        | Efeito                                        | Prioridade do canal associado |
|----------------|-----------------------------------------------|-------------------------------|
| `OFF`          | Apaga o LED                                   | 0 (default)                   |
| `RED_SOLID`    | Vermelho contínuo                             | 100 (rate limit)              |
| `RED_FAST`     | Vermelho piscando 0,3 s                       | 90 (sessão aguardando)        |
| `RED_BLINK`    | Vermelho piscando 0,5 s (alias MVP v0.1.0)    | —                             |
| `MAGENTA_FAST` | Magenta piscando 0,3 s                        | 75 (API em major/partial outage) |
| `MAGENTA_PULSE`| Magenta com pulse senoidal, período 3 s       | 15 (API em degraded_performance — ambient, v0.2.2+) |
| `BLUE_BLINK`   | Azul piscando 0,5 s                           | 60 (Chrome DevTools)          |
| `BLUE_PULSE`   | Azul com pulse senoidal, período 2 s          | 50 (tool MCP rodando)         |
| `GREEN_PULSE`  | Verde com pulse senoidal, período 2 s         | 40 (todas sessões working — regime estacionário, v0.2.1+) |
| `GREEN_BLINK`  | Verde piscando 0,5 s                          | 30 (mix working + idle — transição, v0.2.1+) |
| `GREEN`        | Verde contínuo                                | — (alias legado, não usado pelo daemon desde v0.2.1) |
| `YELLOW_SLOW`  | Amarelo piscando 1,0 s                        | 20 (compactação de contexto)  |
| `ORANGE_BLINK` | Laranja piscando 0,5 s (reservado para crash) | 80 (planejado para v0.3.0)    |
| `PING`         | Responde `PONG\n`                             | —                             |

Todos os comandos do MVP v0.1.0 permanecem válidos como aliases para garantir compatibilidade retroativa.

#### 3.5.2. Efeitos implementados

O firmware mantém uma `STATE_TABLE` que mapeia cada comando para uma tupla `(cor_RGB, efeito, parâmetro)`:

- **`solid`** (parâmetro `None`): cor constante até próximo comando.
- **`blink`** (parâmetro: intervalo em segundos): alterna cor/apagado a cada `intervalo`.
- **`pulse`** (parâmetro: período em segundos): modula o brightness por uma senoidal de período indicado; `brightness(t) = 0,55 + 0,45 · sin(2π · t/T)`, multiplicado pelo `BRIGHTNESS` global (0,25).

### 3.6. Watchdog de segurança

O firmware mantém `last_command_ts` atualizado a cada comando recebido. Em cada iteração do loop principal:

```
if estado != OFF e (monotonic() - last_command_ts) > 30s:
    estado = OFF
```

Isso garante que o LED nunca fique travado num estado "alerta" caso o host trave, o daemon morra ou o cabo USB entre em falha intermitente. O daemon contrapõe re-enviando o comando atual a cada 10 s (via `PING_INTERVAL_MS`) para manter o watchdog alimentado em operação normal.

### 3.7. Brilho global

Constante `BRIGHTNESS = 0.25` no firmware limita a intensidade máxima de qualquer canal. Valores 0,20–0,35 são confortáveis para uso ao lado de um monitor; acima de 0,50 o LED tende a ofuscar.

---

## 4. Hooks do Claude Code (`hooks/`)

### 4.1. Filosofia

Os hooks do Claude Code disparam scripts arbitrários em resposta a eventos do ciclo de vida da sessão. Cada hook do projeto é um processo efêmero que:

1. Lê o payload JSON do evento de `stdin`.
2. Extrai `session_id` e `cwd`.
3. Escreve o novo estado atômico em `~/.claude-led/sessions/<session_id>.json` **ou** em `~/.claude-led/channels/<canal>.json`.
4. Termina imediatamente.

Regras invioláveis:

- **Nunca bloqueia** o Claude Code (timeout de 500 ms para ler stdin).
- **Nunca modifica decisões** (apenas observa).
- **Nunca falha ruidosamente** — erros vão para `~/.claude-led/sessions/hook.log` e o processo sai com código 0.

### 4.2. Eventos mapeados

| Evento do Claude Code | Ação do hook                                                     |
|-----------------------|------------------------------------------------------------------|
| `UserPromptSubmit`    | `writeState(session_id, 'working')`                              |
| `PreToolUse`          | `writeState(session_id, 'working')` — flipa waiting → working    |
| `PreToolUse` (matcher `mcp__.*`) | `writeChannel('mcp', TTL 30 s)` + working             |
| `PreCompact`          | `writeChannel('precompact', TTL 120 s)`                          |
| `Notification`        | `writeState(session_id, 'waiting')` **apenas** se tipo conter `permission` ou `elicit` |
| `Stop`                | `writeState(session_id, 'idle')`                                 |
| `SessionEnd`          | remove o arquivo da sessão                                       |

### 4.3. Escolhas de design em cada hook

- **`UserPromptSubmit` e `PreToolUse` ambos marcam `working`**. Redundância intencional: o `UserPromptSubmit` marca no início do turno; o `PreToolUse` é essencial para sair de `waiting` quando o usuário responde a um AskUserQuestion ou permission prompt interno (que não dispara `UserPromptSubmit` novo).
- **`Notification` é restritivo**. Historicamente o hook marcava `waiting` como fallback para notificações sem tipo, mas isso gerou falsos-positivos: notificações do sistema macOS (ex.: desconexão de iPad) e `idle_prompt` do próprio Claude Code (lembrete periódico após ~60 s sem atividade) sequestravam o LED. A regra atual exige match explícito em `permission` ou `elicit`.
- **Audit log**. Toda `Notification` recebida é logada em `~/.claude-led/sessions/hook.log` com o `notification_type` e se foi tratada como `waiting`. Facilita diagnosticar novos falsos-positivos em produção.
- **Matcher `mcp__.*` no PreToolUse**. Canal separado, não captura tools nativas (`Bash`, `Read`, `Grep`, etc.) que gerariam ruído inútil — só MCP tools externas, que tipicamente são mais lentas e merecem visibilidade dedicada.

### 4.4. Escrita atômica

Toda gravação de estado segue o padrão `write + rename`:

```js
const tmp = `${file}.tmp`
fs.writeFileSync(tmp, JSON.stringify(payload))
fs.renameSync(tmp, file)
```

No POSIX, o `rename` é atômico no mesmo filesystem. Isso elimina race conditions entre múltiplos hooks concorrentes e garante que o daemon nunca lê um JSON parcialmente escrito.

---

## 5. Daemon (`host/claude-led-daemon.js`)

### 5.1. Intervalo de operação

- **`SCAN_INTERVAL_MS = 1500`** — tick principal. A cada 1,5 s o daemon relê sessões + canais, decide o comando, envia.
- **`PING_INTERVAL_MS = 10000`** — a cada 10 s o daemon força o reenvio do comando atual mesmo que não tenha mudado, para manter o watchdog do firmware alimentado.
- **`RECONNECT_INTERVAL_MS = 2000`** — tentativa de reconexão serial em intervalos de 2 s quando a placa não é detectada.
- **`STALE_WORKING_MS = 300000`** (5 min, v0.2.3+) — sessão `working` sem atualização por mais que isso é tratada como `idle` em memória (fallback para user interrupts). Detalhe em 5.4.1.

### 5.2. Detecção da placa

```js
SerialPort.list()
  .filter(vendorId ∈ {239a, 2e8a})
  .map(path → /dev/cu.* no macOS)
  .sort(path)
  .last()  // maior lexicográfico = CDC data
```

**Peculiaridade do macOS**: `SerialPort.list()` só retorna paths no formato `/dev/tty.usbmodem*`, mesmo que `/dev/cu.usbmodem*` (espelho do mesmo dispositivo) exista no filesystem. O daemon converte o prefixo `tty.` → `cu.` porque o `cu.` é:

- **Non-blocking no `open(2)`** — não aguarda sinal DCD (que o USB-CDC não tem).
- **Recomendado para dispositivos que iniciam a comunicação** — evita deadlocks em abertura simultânea.

Sem essa conversão, `findPort()` retorna `null` e o daemon entra em loop infinito silencioso de reconexão.

### 5.3. Hot-plug

A função `openPort()` é chamada recursivamente. O ciclo de vida é:

1. Tenta `findPort()` → se não encontrou, reagenda em 2 s.
2. Abre `new SerialPort({ autoOpen: false })` e chama `sp.open()`.
3. Se abrir, guarda a referência global e registra handlers de `error` + `close`.
4. Qualquer `close` ou `error` fecha o port, zera a referência e reagenda.

Resultado: puxar o cabo USB não crasha o daemon. Replugar traz o LED de volta ao estado correto em até 3 s.

### 5.4. Sessões

Diretório: `~/.claude-led/sessions/`

Cada arquivo `<session_id>.json` tem a forma:

```json
{
  "session_id": "95898ee3-e297-49aa-b48f-f52160dd7e48",
  "status": "working",
  "updated_at": 1776625033781,
  "cwd": "/Users/camilo/Projects/led"
}
```

Campos:
- **`session_id`**: UUID da sessão do Claude Code.
- **`status`**: um de `working` | `idle` | `waiting`.
- **`updated_at`**: epoch em ms.
- **`cwd`**: diretório de trabalho (para identificação e futura feature de cor-por-projeto).

Arquivos com `updated_at` mais antigo que `IDLE_TTL_MS` (6 h) são removidos automaticamente em tempo de leitura — cobre o caso de sessão que morreu sem disparar `SessionEnd`.

#### 5.4.1. Stale-working fallback (v0.2.3+)

O Claude Code **não dispara nenhum hook** quando o usuário interrompe o turno com ESC ou Ctrl+C — confirmado na documentação oficial ("`Stop` hooks do not fire in response to user interrupts"). Sem isso, uma sessão que foi interrompida fica travada em `status: working` até o próximo `UserPromptSubmit` ou `PreToolUse`, e o LED continua refletindo "trabalhando" mesmo com a sessão efetivamente parada.

Fallback heurístico no daemon: sessões com `status === 'working'` cujo `updated_at` seja anterior a `STALE_WORKING_MS` (5 min por padrão) são **tratadas como `idle`** em memória — apenas na agregação do tick. O arquivo em disco não é modificado; o próximo hook real da sessão (qualquer `UserPromptSubmit`, `PreToolUse`) restaura o estado correto naturalmente.

5 minutos foi escolhido porque o `PreToolUse` dispara a cada tool call do Claude, incluindo operações rápidas como `Read`, `Grep`, `Edit`. Cinco minutos sem **nenhum** tool call é raro em uso normal — indicativo forte de interrupt ou trava. Prompts muito longos em que o Claude pensa sem chamar tools (reasoning-heavy sem exploração) ainda existem, mas são exceção; se forem frequentes, aumentar o valor da constante.

### 5.5. Canais

Diretório: `~/.claude-led/channels/`

Cada arquivo `<nome>.json` tem a forma:

```json
{
  "channel": "mcp",
  "activated_at": 1776625033781,
  "expires_at": 1776625063781,
  "tool_name": "mcp__obsidian__view",
  "session_id": "95898ee3-..."
}
```

Canais expirados (`now > expires_at`) são ignorados e removidos em tempo de leitura. A flexibilidade do formato permite adicionar canais futuros sem mudar a infraestrutura — basta criar um arquivo novo em `channels/` e uma regra em `decideCommand()`.

### 5.6. Detectores passivos internos

Três detectores rodam dentro do daemon, cada um com cache próprio:

| Detector           | Fonte                                            | Cache  | Falha silenciosa                   |
|--------------------|--------------------------------------------------|--------|------------------------------------|
| `checkRateLimit`   | `~/.claude/claudewatch-usage.json`               | 60 s   | Arquivo ausente → canal inerte     |
| `checkApiOutage`   | `https://status.claude.com/api/v2/components.json` | 30 s | Timeout/erro → assume operacional. Retorna severidade: `null` \| `'degraded'` \| `'partial'` \| `'major'` |
| `checkChromeDevtools` | `lsof -iTCP:9222 -sTCP:LISTEN -t`             | 3 s    | `lsof` falha → canal inerte        |

**Padrão fire-and-forget**: os detectores com I/O lento (HTTP, subprocess) retornam o valor em cache e disparam a atualização assíncrona em background. Isso impede que o tick do daemon (1,5 s) fique bloqueado aguardando rede.

Detalhe `checkRateLimit`: o schema exato do `claudewatch-usage.json` varia entre versões do claudewatch. O detector é defensivo — percorre recursivamente o JSON procurando qualquer número que possa ser um percentual (`value`, `percent`, `pct`) e considera "atingido" se qualquer um for ≥ 100.

Detalhe `checkApiOutage` (v0.2.2+): consulta a página de status pública da Anthropic, procura componentes cujo nome contenha "api" e computa a **pior severidade** encontrada entre `degraded_performance`, `partial_outage` e `major_outage`. A função retorna a severidade como string (ou `null` se tudo estiver `operational`). Dois canais consomem o resultado: prio 75 (`MAGENTA_FAST`) ativa em `major`/`partial`; prio 15 (`MAGENTA_PULSE`) ativa só em `degraded`. Em casos de timeout ou erro de rede, retorna `null` — prefere ocultar o canal a gerar alarme falso durante problemas locais de conectividade.

Detalhe `checkChromeDevtools`: qualquer processo escutando na porta 9222 dispara o canal. Na prática inclui Playwright, Puppeteer, Cypress e DevTools aberto manualmente. Apps Electron em modo dev (VSCode, Discord, Slack) ocasionalmente escutam na 9222 — é aceito como "true positive relaxado" nesta versão; uma futura v0.4.0 terá config `ignore_processes` para filtragem.

### 5.7. Tabela de prioridade

A função `decideCommand()` aplica as seguintes regras, em ordem decrescente de prioridade — a primeira que retornar `true` vence:

```js
[100, 'RED_SOLID',    () => checkRateLimit()],
[ 90, 'RED_FAST',     () => sessions.some(s => s.status === 'waiting')],
[ 75, 'MAGENTA_FAST', () => checkApiOutage()],
[ 60, 'BLUE_BLINK',   () => checkChromeDevtools()],
[ 50, 'BLUE_PULSE',   () => channels.has('mcp')],
[ 40, 'GREEN_PULSE',  () => hasWorking && !hasIdle],   // v0.2.1+
[ 30, 'GREEN_BLINK',  () => hasWorking && hasIdle],    // v0.2.1+
[ 20, 'YELLOW_SLOW',  () => channels.has('precompact')],
[ 15, 'MAGENTA_PULSE', () => checkApiOutage() === 'degraded']   // v0.2.2+
```

Nenhuma regra bate → `'OFF'`.

Decisões de prioridade mais notáveis:

- **Rate limit > waiting**: se a API está travada, aprovar um waiting local não adianta — melhor mostrar o bloqueio "duro".
- **MCP tool > todas-working**: uma tool MCP em execução frequentemente é mais lenta que uma tool nativa; a informação específica vale mais que a agregação genérica.
- **Todas-working é pulse, mix é blink (v0.2.1+)**: inversão deliberada da intuição "mais atividade = mais piscante". A razão: "todas working" é **regime estacionário** (nada novo para olhar — pulse ambiente basta); "mix working + idle" é **transição** (alguma sessão acabou de terminar, vale a pena checar — blink chama mais atenção periférica).
- **PreCompact < tudo-idle**: compactação é de baixa urgência e apenas informativa, não deve suprimir sinais mais urgentes.

### 5.8. Envio de comando com throttle

A função `sendCommand(cmd, { force })`:

```js
if (!force && cmd === lastCommandSent && (now - lastCommandTs) < PING_INTERVAL_MS) return
```

Não reenvia o mesmo comando em menos de 10 s. Quando passa dos 10 s, o próximo tick marca `force = true` e o comando é reenviado — alimentando o watchdog do firmware.

### 5.9. Desligamento gracioso

Ao receber `SIGINT` ou `SIGTERM`, o daemon envia `OFF\n` ao firmware antes de encerrar. Garante que um restart manual do serviço não deixa o LED aceso acidentalmente.

---

## 6. Auto-start como serviço

### 6.1. macOS — LaunchAgent

Arquivo: `~/Library/LaunchAgents/com.carromeu.claude-led.plist` (gerado a partir do template `launchd/com.carromeu.claude-led.plist` substituindo `__NODE__` e `__HOME__`).

Configuração relevante:
- **`RunAtLoad = true`**, **`KeepAlive = true`** — inicia no login e reinicia em caso de crash.
- **`ThrottleInterval = 5`** — respawn limitado a uma vez por 5 s.
- **`ProcessType = Background`** — prioridade reduzida, sem aparecer no Dock.
- **`StandardOutPath`** e **`StandardErrorPath`** apontando para `~/.claude-led/daemon.log` e `daemon.err.log`.

Carga:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.carromeu.claude-led.plist
```

Descarga:
```bash
launchctl bootout gui/$(id -u)/com.carromeu.claude-led
```

Restart:
```bash
launchctl kickstart -k gui/$(id -u)/com.carromeu.claude-led
```

### 6.2. Linux — systemd user unit

Arquivo: `~/.config/systemd/user/claude-led.service` (copiado direto de `systemd/claude-led.service`).

Configuração relevante:
- **`Restart = always`**, **`RestartSec = 3`** — respawn a cada 3 s em falha.
- **`WantedBy = default.target`** — inicia no login do usuário.

Também é necessário instalar a udev rule `systemd/99-claude-led.rules` em `/etc/udev/rules.d/` e adicionar o usuário ao grupo `dialout` para ter acesso a `/dev/ttyACM*` sem sudo.

### 6.3. Caminho do Node.js

O `ProgramArguments` do plist aponta para um binário absoluto do Node.js (ex.: `/Users/camilo/.nvm/versions/node/v24.14.0/bin/node`). Se o usuário mudar de versão via `nvm`, o plist precisa ser regerado:

```bash
NODE_BIN=$(which node)
sed -e "s|__NODE__|${NODE_BIN}|g" -e "s|__HOME__|${HOME}|g" \
  launchd/com.carromeu.claude-led.plist \
  > ~/Library/LaunchAgents/com.carromeu.claude-led.plist
launchctl kickstart -k gui/$(id -u)/com.carromeu.claude-led
```

---

## 7. Estrutura de diretórios

### 7.1. Repositório (`/Users/camilo/Projects/led`)

```
.
├── .gitignore
├── README.md
├── PROMPT-INSTALL.md           # prompt original de instalação (Linux)
├── PROMPT-PUBLISH.md           # prompt original de handoff GitHub
├── docs/
│   └── tech-spec.md            # este documento
├── firmware/
│   ├── boot.py
│   └── code.py
├── host/
│   ├── claude-led-daemon.js
│   └── package.json
├── hooks/
│   ├── claude-led-hook.js
│   └── settings.snippet.json
├── launchd/
│   └── com.carromeu.claude-led.plist    # template (macOS)
└── systemd/
    ├── 99-claude-led.rules
    └── claude-led.service
```

### 7.2. Instalação em runtime

```
~/.claude-led/
├── host/
│   ├── claude-led-daemon.js
│   ├── package.json
│   └── node_modules/           # instalado via npm
├── hooks/
│   └── claude-led-hook.js
├── sessions/
│   ├── <session_id_1>.json     # uma sessão por arquivo
│   ├── <session_id_2>.json
│   └── hook.log                # audit log de Notification
├── channels/
│   ├── mcp.json                # TTL 30 s
│   └── precompact.json         # TTL 120 s
├── daemon.log                  # stdout do daemon (LaunchAgent)
└── daemon.err.log              # stderr do daemon (LaunchAgent)
```

No macOS o plist do LaunchAgent vai em `~/Library/LaunchAgents/com.carromeu.claude-led.plist`. No Linux o unit vai em `~/.config/systemd/user/claude-led.service`.

---

## 8. Fluxos críticos

### 8.1. Primeiro flash do firmware

1. Placa em modo BOOTSEL: segurar BOOT, plugar USB-C, soltar BOOT. Deve montar `/Volumes/RPI-RP2` (macOS) ou `/mnt/RPI-RP2` (Linux).
2. Baixar a UF2 estável mais recente de `https://downloads.circuitpython.org/bin/waveshare_rp2040_zero/en_US/` (no momento da v0.2.0, `9.2.1`).
3. Copiar a UF2 para o volume montado. A placa reinicia sozinha e monta como `/Volumes/CIRCUITPY`.
4. Copiar `firmware/boot.py` e `firmware/code.py` para `/Volumes/CIRCUITPY/`.
5. **Hard reset obrigatório** (desconectar e reconectar o cabo). Sem isso, o `boot.py` não é aplicado e só aparece 1 endpoint CDC no sistema — insuficiente para o protocolo duplo.
6. Verificar que aparecem 2 endpoints: `ls /dev/cu.usbmodem*` deve mostrar dois caminhos.

### 8.2. Atualização do firmware (após o primeiro flash)

Com o CIRCUITPY montado:

```bash
cp firmware/code.py /Volumes/CIRCUITPY/code.py
```

O CircuitPython detecta a mudança e faz auto-reload. Não requer hard reset — a não ser que o `boot.py` tenha mudado.

### 8.3. Diagnóstico via REPL

Para acessar o REPL do CircuitPython (inspecionar erros, testar código):

```bash
screen /dev/cu.usbmodem4101 115200   # ou tio, minicom, etc.
# Ctrl-C para parar o code.py e ver traceback
# Ctrl-D para soft reboot
# Sair do screen: Ctrl-A K
```

O REPL está sempre em `usbmodem*1` (impar), o canal data em `usbmodem*3` (também impar mas mais alto).

---

## 9. Troubleshooting específico por plataforma

### 9.1. macOS — USB-CDC enumerado como "modem"

O macOS classifica automaticamente qualquer dispositivo USB-CDC como serviço de rede "modem" em Configurações do Sistema → Rede. No setup padrão, o macOS pode tentar rotear tráfego via essa interface (PPP), quebrando DNS ou latência.

Solução: desativar os serviços de rede sem removê-los (preserva `/dev/cu.usbmodem*` funcional):

```bash
sudo networksetup -setnetworkserviceenabled "RP2040-Zero" off
sudo networksetup -setnetworkserviceenabled "RP2040-Zero 2" off
```

Verificação:

```bash
networksetup -getnetworkserviceenabled "RP2040-Zero"     # Disabled
networksetup -getnetworkserviceenabled "RP2040-Zero 2"   # Disabled
```

A configuração é persistente por serviço mas pode se perder se o macOS recriar a interface (raro, ocorre em atualizações de versão ou mudança de porta USB). Nesse caso, re-executar os comandos.

### 9.2. Linux — Permissão em `/dev/ttyACM*`

Requer duas coisas:

1. Instalar a udev rule (`systemd/99-claude-led.rules`) em `/etc/udev/rules.d/`. Ela dá `MODE=0660` e `GROUP=dialout` aos devices com os VIDs aceitos.
2. Adicionar o usuário ao grupo `dialout` via `sudo usermod -aG dialout "$USER"`. O grupo só vale após logout/login.

Verificação: `ls -l /dev/ttyACM*` deve mostrar group `dialout`; `groups` deve mostrar `dialout` entre os grupos do usuário.

### 9.3. LED trava em branco após copiar novo `code.py`

Sintoma: após copiar `code.py` em CIRCUITPY, o LED fica aceso branco em vez de respondendo ao protocolo.

Causa: o REPL do CircuitPython, quando assume controle (por exemplo após Ctrl-C ou crash do code.py), usa o NeoPixel onboard como status LED e ilumina branco em idle.

Soluções:
- Ctrl-D no REPL (`screen /dev/cu.usbmodem4101 115200`) para re-executar `code.py`.
- Desconectar e reconectar o cabo (hard reset).

### 9.4. LED pisca 2× vermelho em loop

Sintoma: logo após o flash, o LED faz um padrão específico de "2 blinks vermelhos, pausa, 2 blinks, pausa" indefinidamente.

Causa: é o padrão de erro do CircuitPython sinalizando **exception não tratada** no código do usuário. Versões antigas do firmware deste projeto importavam `neopixel` (lib externa que não vem no core) e caíam em `ImportError`.

Solução: garantir que `firmware/code.py` usa `neopixel_write` built-in (seção 3.3). Verificar o traceback via REPL (`screen /dev/cu.usbmodem4101 115200`, Ctrl-C).

### 9.5. Daemon "watching" mas nunca "conectado"

Sintoma: `tail ~/.claude-led/daemon.log` mostra apenas linhas `[claude-led] watching ...`, sem `[claude-led] conectado em ...`.

Causa: o daemon não encontra portas candidatas. Normalmente significa:
- Placa não plugada, **ou**
- Placa em BOOTSEL (sem firmware CircuitPython), **ou**
- `findPort()` retornando `null` por bug de plataforma.

Diagnóstico:

```bash
# lista todas as portas que o serialport vê
node -e "require('serialport').SerialPort.list().then(l=>console.log(JSON.stringify(l,null,2)))"
```

No macOS, verificar também se os paths estão sendo convertidos `tty.` → `cu.` (seção 5.2). Se faltou, é bug do daemon.

---

## 10. Limitações conhecidas e roadmap

### 10.1. Escopo atual (v0.2.3)

- 8 canais ativos + default (off). Abaixo do limite cognitivo de ~10.
- Detectores hardcoded — nenhuma configuração externa permite habilitar/desabilitar canais individualmente sem editar `claude-led-daemon.js`.
- Nenhum detector de crash/erro em sessão — descrito na nota 05 do projeto com prioridade 80.
- Protocolo serial textual com comandos nomeados (`RED_SOLID`, `BLUE_PULSE`, etc.) — não parametrizável via `SET R G B` genérico.
- Brilho global fixo em `0.25` no firmware; sem quiet mode (redução automática após inatividade).
- Sem CLI de inspeção — debug feito via `tail` + `cat` nos diretórios de estado.

### 10.2. Planejado

Descrito em detalhe na nota 05 do vault Obsidian do projeto.

- **v0.3.0**: detector de crash/erro em sessão (heurística combinando `Stop` + análise de stderr). Configuração JSON opcional em `~/.claude-led/config.json` para habilitar/desabilitar canais.
- **v0.4.0**: quiet mode — reduz brilho em 50 % após 30 min no mesmo estado. CLI de inspeção (`claude-led status`, `claude-led channels`, `claude-led test <cmd>`).
- **v0.5.0+**: refactor do firmware para protocolo paramétrico (`SET R G B`, `BLINK R G B ms_on ms_off`, `PULSE R G B period_ms`). Daemon com sistema de canais verdadeiro e pluggable.
- **Pós-v0.4.0**: `boot.py` com `storage.disable_usb_drive()` para esconder CIRCUITPY do Finder (plug/unplug trivial). Adiado porque o firmware ainda muda com frequência e o drag-and-drop é vital para desenvolvimento.

---

## 11. Padrões de commit

Seguindo Conventional Commits:

- **`feat(v0.X.Y): ...`** — nova versão ou feature significativa.
- **`fix(<escopo>): ...`** — correção. Escopos: `firmware`, `host`, `hook`, `docs`.
- **`docs: ...`** — alterações em README, docs, comentários.
- **`chore: ...`** — manutenção, versionamento, gitignore.

Co-autoria do Claude Code é marcada com:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## 12. Referências externas

- [CircuitPython — Adafruit](https://circuitpython.org/)
- [CircuitPython UF2s para Waveshare RP2040-Zero](https://circuitpython.org/board/waveshare_rp2040_zero/)
- [Documentação do `usb_cdc` em CircuitPython](https://docs.circuitpython.org/en/latest/shared-bindings/usb_cdc/)
- [Módulo `serialport` para Node.js](https://serialport.io/docs/)
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [launchd plist reference](https://www.manpagez.com/man/5/launchd.plist/)
