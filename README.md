# Claude Code Status LED — RP2040-Zero

Reflete em um LED WS2812 onboard de uma placa **Waveshare RP2040-Zero** (via USB-C) o estado agregado de **múltiplas sessões do Claude Code** rodando em paralelo, além de sinais ambientais do host (rate limit, status da API Anthropic, Chrome DevTools, tools MCP em execução e compactação de contexto).

Princípio central: **detecção 100% passiva**. Uma vez instalado, nenhuma ação manual é necessária no dia a dia — o LED apenas reflete o estado do ambiente.

> A documentação técnica completa (arquitetura, protocolos, formatos) está em **[`docs/tech-spec.md`](docs/tech-spec.md)**.

## Estados visuais

Canais em ordem decrescente de prioridade (maior vence):

| Prio | LED                         | Canal                       | Fonte de dados (passiva)                              |
|-----:|-----------------------------|-----------------------------|--------------------------------------------------------|
| 100  | 🔴 vermelho contínuo        | Rate limit atingido         | `~/.claude/claudewatch-usage.json` (≥ 100 %)           |
|  90  | 🔴 vermelho piscando 0,3 s  | Sessão aguardando você      | hook `Notification` (permission/elicit)                |
|  75  | 🟣 magenta piscando rápido  | API Anthropic em outage (`major_outage` ou `partial_outage`) | `status.claude.com/api/v2/components.json` |
|  60  | 🔵 azul piscando 0,5 s      | Chrome DevTools ativo       | `lsof -iTCP:9222 -sTCP:LISTEN`                         |
|  50  | 🔵 azul pulse senoidal      | Tool MCP em execução        | hook `PreToolUse` matcher `mcp__.*` (TTL 30 s)         |
|  40  | 🟢 verde pulse senoidal     | Todas as sessões trabalhando (regime estacionário) | agregação de `~/.claude-led/sessions/*.json` |
|  30  | 🟢 verde piscando 0,5 s     | Mix trabalhando + ocioso (transição — alguma terminou) | idem                                  |
|  20  | 🟡 amarelo piscando 1 s     | Compactação de contexto     | hook `PreCompact` (TTL 120 s)                          |
|  15  | 🟣 magenta pulse 3 s        | API em `degraded_performance` (lenta mas operacional) | idem endpoint de status         |
|   0  | ⚫ apagado                  | Nada ativo                  | default                                                |

Se uma fonte não existir no seu setup (ex.: `claudewatch` não instalado), o canal correspondente fica inerte sem quebrar o restante.

> **Interrupt (v0.2.3+)**: o Claude Code não dispara nenhum hook quando você ESC ou Ctrl+C no meio de um turno. Fallback heurístico no daemon: sessão `working` sem atualização por 5 min é tratada como `idle` em memória. O próximo prompt real restaura o estado correto.

## Arquitetura em 30 segundos

```
Claude Code (N sessões)
    │
    │ hooks: UserPromptSubmit, PreToolUse, PreCompact,
    │        Notification, Stop, SessionEnd
    ▼
~/.claude-led/sessions/<session_id>.json
~/.claude-led/channels/<canal>.json
    │
    │ polling 1,5 s + detectores internos (rate limit,
    │ API outage, Chrome DevTools)
    ▼
claude-led-daemon.js  (decide por prioridade)
    │  USB-CDC @ 115200
    ▼
RP2040-Zero / firmware/code.py  (WS2812 no GP16)
```

Detalhes em [`docs/tech-spec.md`](docs/tech-spec.md).

## Pré-requisitos

- **Hardware**: Waveshare RP2040-Zero (ou outro RP2040 com WS2812 onboard).
- **Sistema**: macOS 13+ ou Linux com systemd. Testado extensivamente no macOS 15/26 (arm64).
- **Software**:
  - Node.js 18 ou mais recente no `PATH`.
  - `jq` (para o merge dos hooks no `settings.json`).
  - Python 3 (presente por padrão em macOS/Linux modernos).

## Instalação — macOS

### 1. Flash do firmware (primeira vez)

1. Coloque a placa em modo BOOTSEL: **segure BOOT**, conecte o cabo USB-C, **solte BOOT**. O volume `/Volumes/RPI-RP2` aparece.
2. Baixe a UF2 estável mais recente do CircuitPython para Waveshare RP2040-Zero em [circuitpython.org/board/waveshare_rp2040_zero](https://circuitpython.org/board/waveshare_rp2040_zero/) e copie para `/Volumes/RPI-RP2/`.
3. A placa reinicia sozinha e monta como `/Volumes/CIRCUITPY`. Copie o firmware do projeto:

   ```bash
   cp firmware/boot.py /Volumes/CIRCUITPY/boot.py
   cp firmware/code.py /Volumes/CIRCUITPY/code.py
   sync
   ```

4. **Hard reset obrigatório**: desconecte e reconecte o cabo USB-C. Sem isso o `boot.py` não é aplicado (seção "Fluxos críticos" do tech-spec).
5. Verifique que aparecem dois endpoints CDC:

   ```bash
   ls /dev/cu.usbmodem*
   # esperado: dois caminhos, ex.: /dev/cu.usbmodem4101 e /dev/cu.usbmodem4103
   ```

### 2. Daemon + hooks

```bash
# Copia fontes para ~/.claude-led
mkdir -p ~/.claude-led
cp -r host ~/.claude-led/host
cp -r hooks ~/.claude-led/hooks
mkdir -p ~/.claude-led/channels

# Dependências do Node
cd ~/.claude-led/host
npm install

chmod +x ~/.claude-led/host/claude-led-daemon.js
chmod +x ~/.claude-led/hooks/claude-led-hook.js
```

### 3. LaunchAgent (auto-start no login)

Substitua os placeholders no template e carregue:

```bash
NODE_BIN=$(which node)
sed -e "s|__NODE__|${NODE_BIN}|g" -e "s|__HOME__|${HOME}|g" \
  launchd/com.carromeu.claude-led.plist \
  > ~/Library/LaunchAgents/com.carromeu.claude-led.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.carromeu.claude-led.plist
```

Verificar:

```bash
launchctl print gui/$(id -u)/com.carromeu.claude-led | grep state
# esperado: state = running

tail -n 5 ~/.claude-led/daemon.log
# esperado: [claude-led] conectado em /dev/cu.usbmodem4103
```

### 4. Hooks globais do Claude Code

Merge do snippet em `~/.claude/settings.json` (preserva hooks existentes):

```bash
SNIPPET=hooks/settings.snippet.json
SETTINGS=~/.claude/settings.json
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
cp "$SETTINGS" "$SETTINGS.bak-pre-claude-led-$(date +%s)"

tmp=$(mktemp)
jq --slurpfile snip "$SNIPPET" '
  . as $base
  | reduce ($snip[0].hooks | keys[]) as $evt (
      $base;
      .hooks[$evt] = ((.hooks[$evt] // []) + $snip[0].hooks[$evt])
    )
' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
```

Em uma sessão nova do Claude Code, rode `/hooks` para confirmar que aparecem os 6 eventos: `UserPromptSubmit`, `PreToolUse` (2 entradas — uma global e outra com matcher `mcp__.*`), `PreCompact`, `Notification`, `Stop`, `SessionEnd`.

### 5. Importante — desativar enumeração como "modem"

O macOS registra o USB-CDC como serviço de rede "modem" automaticamente. Isso pode desestabilizar DNS/roteamento. **Desative**:

```bash
sudo networksetup -setnetworkserviceenabled "RP2040-Zero" off
sudo networksetup -setnetworkserviceenabled "RP2040-Zero 2" off
```

A configuração é persistente. Só é preciso refazer se o macOS recriar a interface (raro).

## Instalação — Linux

Use o `systemd/claude-led.service` em vez do LaunchAgent:

```bash
sudo cp systemd/99-claude-led.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo usermod -aG dialout "$USER"   # exige logout/login para valer

mkdir -p ~/.config/systemd/user
cp systemd/claude-led.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-led.service
```

No Linux os paths seriais são `/dev/ttyACM0` (console) e `/dev/ttyACM1` (data) em vez dos `/dev/cu.usbmodem*` do macOS.

## Atualização do firmware (após o primeiro flash)

Com o CIRCUITPY montado:

```bash
cp firmware/code.py /Volumes/CIRCUITPY/code.py
```

O CircuitPython detecta e faz auto-reload. Se você alterar o `boot.py`, é necessário hard reset adicional (puxar e reconectar o cabo).

## Teste end-to-end

Abra duas sessões do Claude Code em terminais diferentes.

1. Na primeira sozinha, mande um prompt longo ("explique X em detalhes"): **verde pulsando** (todas as sessões working, regime estacionário, prio 40).
2. Agora com a segunda sessão ociosa em paralelo, volte à primeira e mande outro prompt: **verde piscando** (mix — uma trabalhando, outra parada; prio 30).
3. Peça permissão para rodar um bash fora da allowlist: **vermelho piscando rápido** (1 waiting, prio 90). Responda — volta ao estado agregado anterior.
4. Aguarde o `Stop` final: **apaga** quando todas estiverem idle.
5. Puxe o cabo USB: nada quebra — o daemon segue tentando. Replugue: volta ao estado correto em ≤ 3 s.

## Troubleshooting

Veja o capítulo 9 do [`docs/tech-spec.md`](docs/tech-spec.md) para a lista completa com causas e soluções detalhadas. Atalhos:

- **Porta não detectada pelo daemon**  
  `node -e "require('serialport').SerialPort.list().then(l=>console.log(JSON.stringify(l,null,2)))"` para listar o que o Node vê. Conferir `vendorId` e paths.

- **LED pisca 2 vezes vermelho em loop**  
  Erro de importação no CircuitPython. Confirme que `code.py` usa `neopixel_write` built-in e **não** a lib `neopixel`.

- **LED trava em branco após mexer no CIRCUITPY**  
  REPL do CircuitPython assumiu o controle. Ctrl-D no `screen /dev/cu.usbmodem4101 115200` ou hard reset do cabo.

- **DNS/rede instável ao conectar a placa (macOS)**  
  Desativar os serviços de rede "RP2040-Zero" e "RP2040-Zero 2" via `networksetup` (ver passo 5 da instalação).

- **Daemon "watching" mas nunca "conectado"**  
  Placa fora, em BOOTSEL ou `findPort()` falhando. `launchctl print gui/$(id -u)/com.carromeu.claude-led` e `tail ~/.claude-led/daemon.log` para diagnóstico.

## Roadmap resumido

- **v0.3.0**: detector de crash/erro em sessão (prio 80, LED laranja). Configuração opcional via `~/.claude-led/config.json`.
- **v0.4.0**: quiet mode (reduz brilho após 30 min no mesmo estado). CLI de inspeção.
- **v0.5.0+**: refactor do firmware para protocolo paramétrico (`SET R G B`, `PULSE ... period_ms`). Sistema de canais pluggable.
- **Pós-v0.4.0**: ocultar `CIRCUITPY` do Finder via `storage.disable_usb_drive()` no `boot.py`.

## Extensões possíveis

- Cor por **tipo de projeto** (usar `cwd` gravado no estado).
- Segundo LED externo via tira WS2812 em GPIO livre, para separar "trabalhando" de "esperando input" visualmente.
- Publicar métricas via MQTT — o daemon já tem todos os dados agregados.

## Licença

Por definir. Para uso pessoal no momento.

## Créditos

Inspirado pelo post de [@noisyb0y1 no X](https://x.com/noisyb0y1/status/2043900212331041172) (abril de 2026), que mostrava um chip USB-C mínimo configurado com Claude Code em 15 minutos para sinalizar atividade do agente. Adaptado para múltiplas sessões simultâneas com agregação e prioridade de estados.
