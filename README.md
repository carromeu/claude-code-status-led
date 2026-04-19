# Claude Code Status LED — RP2040-Zero

Reflete o estado agregado de **várias sessões do Claude Code** num LED WS2812
integrado a uma placa RP2040-Zero plugada via USB-C.

## Estados visuais

| LED                 | Significado                                                      |
|---------------------|------------------------------------------------------------------|
| 🔴 vermelho piscando | ≥1 sessão esperando input (permission/elicitation/idle prompt) |
| 🟢 verde piscando    | Todas as sessões ativas estão trabalhando (nenhuma parada)      |
| 🟢 verde contínuo    | Mix: algumas trabalhando, outras paradas                         |
| ⚫ apagado           | Nenhuma sessão ativa / todas paradas                             |

Plug-and-play: conectou o USB, acendeu. Desconectou, o daemon fica tentando
reabrir; quando religar, volta a funcionar.

## Arquitetura

```
Claude Code (N sessões)
    │
    │ hooks (UserPromptSubmit, Notification, Stop, SessionEnd)
    ▼
~/.claude-led/sessions/<session_id>.json   ← estado por sessão
    │
    ▼
claude-led-daemon.js  (agrega + decide comando)
    │  USB CDC @115200
    ▼
RP2040-Zero / code.py  ← aciona WS2812 (GP16)
```

## 1. Firmware do RP2040-Zero

1. Baixe a UF2 do CircuitPython para Waveshare RP2040-Zero
   (https://circuitpython.org/board/waveshare_rp2040_zero/).
2. Segure BOOT, plugue USB, solte BOOT. Aparece como drive `RPI-RP2`.
3. Copie a `.uf2` pro drive. A placa reinicia e monta como `CIRCUITPY`.
4. No drive `CIRCUITPY`, copie:
   - `firmware/boot.py` → raiz
   - `firmware/code.py` → raiz
5. Eject e replug. O LED dá 2 flashes brancos no boot e depois fica apagado,
   esperando comandos.

Teste rápido (sem o daemon):
```bash
# encontre a porta CDC "data" (geralmente a segunda ttyACM)
ls /dev/serial/by-id/
# envie um comando
echo "RED_BLINK" > /dev/ttyACM1
echo "OFF"       > /dev/ttyACM1
```

Se ficou aceso e não volta, espere 30s: há um watchdog no firmware que apaga
se o host parar de mandar comandos.

## 2. Daemon no host

```bash
# instale em ~/.claude-led/host
mkdir -p ~/.claude-led
cp -r host ~/.claude-led/host
cp -r hooks ~/.claude-led/hooks
cd ~/.claude-led/host
npm install            # instala serialport
```

Adicione seu usuário ao grupo `dialout` (Debian/Ubuntu) e instale o udev rule:
```bash
sudo usermod -aG dialout "$USER"
sudo cp systemd/99-claude-led.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# faça logout/login para o grupo ter efeito
```

Rode em foreground para testar:
```bash
node ~/.claude-led/host/claude-led-daemon.js
```

Como serviço de usuário (recomendado):
```bash
mkdir -p ~/.config/systemd/user
cp systemd/claude-led.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-led.service
journalctl --user -u claude-led -f   # acompanha
```

## 3. Hooks do Claude Code

Merge do conteúdo de `hooks/settings.snippet.json` no seu
`~/.claude/settings.json` (global, vale para todas as sessões).

Se já tem hooks, combine manualmente — cada evento é um array e suporta
múltiplos handlers em paralelo.

Depois, em qualquer sessão do Claude Code, rode `/hooks` para confirmar que
eles apareceram.

## Teste end-to-end

1. Abra **duas** sessões do Claude Code em terminais diferentes.
2. Na primeira, mande um prompt longo ("explique X em detalhes"):
   → LED fica **verde piscando** (1 working, 0 idle).
3. Peça permissão para rodar um bash que exige aprovação:
   → LED fica **vermelho piscando** (1 waiting).
4. Aprove. Ele volta a trabalhar; quando terminar, fica idle:
   → LED apaga quando as duas estiverem idle.
5. Puxe o cabo USB. Nada quebra — o daemon espera; o hook continua gravando
   estados. Replugue: LED volta a refletir o estado real em ≤ 3s.

## Troubleshooting

- **Porta não detectada**: `node -e "require('serialport').SerialPort.list().then(console.log)"`
  e confira `vendorId`. Se for diferente, adicione em `ACCEPTED_VIDS` no daemon.
- **Dois ttyACM/usbmodem**: o primeiro é o console (REPL), o segundo é o CDC
  data. O daemon escolhe o de ordem alfabética maior, que é normalmente o
  correto. No macOS, o daemon usa `/dev/cu.*` em vez de `/dev/tty.*` (non-blocking
  no open).
- **Hook não dispara**: rode `/hooks` dentro do Claude Code para listar; veja
  também `~/.claude-led/sessions/hook.log`.
- **LED trava aceso**: o watchdog de 30s apaga sozinho. Se persistir, o daemon
  não está rodando — cheque `systemctl --user status claude-led` (Linux) ou
  `launchctl print gui/$(id -u)/com.carromeu.claude-led` (macOS).
- **ImportError: no module named 'neopixel' (CircuitPython)**: o firmware
  deste projeto usa `neopixel_write` built-in justamente para evitar a lib
  externa. Se adaptar o firmware e quiser a lib, copie `neopixel.mpy` para
  `/Volumes/CIRCUITPY/lib/` a partir do Adafruit CircuitPython Bundle.
- **Permissão negada em /dev/ttyACM* (Linux)**: faltou `dialout` ou o udev
  rule. `ls -l /dev/ttyACM*` deve mostrar group `dialout` e você nele.
- **Internet/DNS fica instável ao plugar a placa (macOS)**: o macOS enumera
  o USB-CDC como "modem" e pode tentar rotear tráfego por ele. Desative os
  serviços de rede correspondentes (mantém o serial utilizável):

  ```bash
  sudo networksetup -setnetworkserviceenabled "RP2040-Zero" off
  sudo networksetup -setnetworkserviceenabled "RP2040-Zero 2" off
  ```

## Extensões possíveis

- Adicionar brilho/cor por **tipo de projeto** (usar `cwd` gravado no estado).
- Segundo LED via uma tira WS2812 externa num GPIO livre (GP0, GP1…) para
  separar "trabalhando" de "esperando input" visualmente.
- Hook `PreToolUse` matcher=`Bash` para pulsar azul quando executa comandos
  perigosos.
- Publicar métricas via MQTT para seu Grafana — o daemon já tem todos os
  dados agregados.
