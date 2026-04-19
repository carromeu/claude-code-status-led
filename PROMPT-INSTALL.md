# Prompt: Instalar Claude Code Status LED (RP2040-Zero)

> Cole o conteúdo abaixo no Claude Code como mensagem única. Pré-requisitos:
> (1) os arquivos do projeto (zip do post anterior, ou o repositório) extraídos em `~/claude-led-src/`
> e (2) o RP2040-Zero **já plugado via USB-C** no momento de rodar o prompt.
> Se quiser flashar CircuitPython automaticamente, coloque a placa em modo BOOTSEL
> **antes** de submeter o prompt (segure BOOT, plugue USB, solte BOOT).

---

## Objetivo

Você vai instalar o projeto **Claude Code Status LED** neste host Linux. O projeto
reflete o estado agregado de várias sessões do Claude Code num LED WS2812
integrado a uma placa Waveshare RP2040-Zero conectada via USB-C. Os arquivos-fonte
estão em `~/claude-led-src/` com esta estrutura:

```
~/claude-led-src/
├── firmware/         # code.py, boot.py   -> vão para a placa
├── host/             # claude-led-daemon.js, package.json
├── hooks/            # claude-led-hook.js, settings.snippet.json
├── systemd/          # claude-led.service, 99-claude-led.rules
└── README.md
```

Siga o procedimento abaixo **na ordem**. Pare e me pergunte se algum passo
falhar de forma não recuperável — não tente contornar com workarounds arriscados
(ex.: forçar escrita em `/dev` como root, reescrever hooks de outros projetos).

Antes de começar, rode um pré-flight e me mostre o resumo:

```bash
echo "=== uname ===";        uname -a
echo "=== node ===";          node --version || true
echo "=== npm ===";           npm --version  || true
echo "=== lsusb (rp2040) ===";lsusb | grep -iE '2e8a|239a' || echo "nenhum RP2040 detectado ainda"
echo "=== /dev/ttyACM* ===";  ls -l /dev/ttyACM* 2>/dev/null || echo "nenhum"
echo "=== mount (RPI-RP2 / CIRCUITPY) ==="; mount | grep -iE 'RPI-RP2|CIRCUITPY' || echo "nenhum"
echo "=== groups ===";        groups
echo "=== claude settings dir ==="; ls -la ~/.claude/ 2>/dev/null || echo "~/.claude não existe"
```

Com base no resultado, execute as fases aplicáveis.

---

## Fase 1 — Dependências do host

1. Exija `node >= 18`. Se não houver, pare e me avise.
2. Crie `~/.claude-led/`.
3. Copie:
   - `~/claude-led-src/host/`   → `~/.claude-led/host/`
   - `~/claude-led-src/hooks/`  → `~/.claude-led/hooks/`
4. Em `~/.claude-led/host/`, rode `npm install` (instala `serialport`).
5. Torne executáveis:
   ```bash
   chmod +x ~/.claude-led/host/claude-led-daemon.js
   chmod +x ~/.claude-led/hooks/claude-led-hook.js
   ```

## Fase 2 — Permissão de acesso à serial (sem sudo recorrente)

Precisa de sudo **uma vez**. Peça confirmação antes de rodar:

```bash
sudo cp ~/claude-led-src/systemd/99-claude-led.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
sudo usermod -aG dialout "$USER"
```

Após isso, verifique `groups` — o novo grupo **só valerá após logout/login**.
Siga em frente mesmo assim; avise ao final que é necessário deslogar.

## Fase 3 — Detectar o estado da placa e agir

Rode:

```bash
lsusb | grep -i '2e8a:0003' && echo "MODO=BOOTSEL"
lsusb | grep -iE '2e8a:|239a:' | grep -v ':0003' && echo "MODO=APP"
ls /dev/ttyACM* 2>/dev/null
mount | grep -iE 'RPI-RP2|CIRCUITPY'
```

Há três cenários. **Escolha um e só um**:

### Cenário A — placa em BOOTSEL (`RPI-RP2` montado ou `lsusb` mostra `2e8a:0003`)

Significa que a placa está esperando um firmware UF2. Instale CircuitPython:

1. Descubra o ponto de montagem:
   ```bash
   RPI_MOUNT=$(mount | awk '/RPI-RP2/ {print $3; exit}')
   echo "RPI_MOUNT=$RPI_MOUNT"
   ```
   Se estiver vazio, tente montar via `udisksctl mount -b $(lsblk -pno NAME,LABEL | awk '/RPI-RP2/{print $1; exit}')`.
   Se ainda falhar, pare e me avise.

2. Baixe a UF2 mais recente do CircuitPython para Waveshare RP2040-Zero:
   ```bash
   mkdir -p ~/.cache/claude-led
   curl -fsSL -o ~/.cache/claude-led/rp2040-zero.uf2 \
     "https://downloads.circuitpython.org/bin/waveshare_rp2040_zero/en_US/adafruit-circuitpython-waveshare_rp2040_zero-en_US-9.2.1.uf2"
   ```
   > Se a URL 404, liste `https://circuitpython.org/board/waveshare_rp2040_zero/`
   > com `curl`, extraia a última UF2 estável (evite alpha/beta/rc) e baixe essa.

3. Copie para o drive BOOTSEL:
   ```bash
   cp ~/.cache/claude-led/rp2040-zero.uf2 "$RPI_MOUNT/"
   sync
   ```
   A placa reinicia sozinha. Aguarde ~10s e continue no **Cenário B**.

### Cenário B — placa rodando CircuitPython (`CIRCUITPY` montado)

1. Descubra o ponto de montagem:
   ```bash
   CP_MOUNT=$(mount | awk '/CIRCUITPY/ {print $3; exit}')
   echo "CP_MOUNT=$CP_MOUNT"
   ```
   Se vazio, tente `udisksctl mount` com o device de label `CIRCUITPY`.

2. Copie o firmware do projeto:
   ```bash
   cp ~/claude-led-src/firmware/boot.py "$CP_MOUNT/boot.py"
   cp ~/claude-led-src/firmware/code.py "$CP_MOUNT/code.py"
   sync
   ```

3. Desmonte com segurança e aguarde o replug automático:
   ```bash
   udisksctl unmount -b "$(findmnt -n -o SOURCE "$CP_MOUNT")" || true
   sleep 5
   ```

4. Confirme que apareceram **dois** `/dev/ttyACM*` (console + CDC data):
   ```bash
   ls -l /dev/ttyACM*
   ```
   Se só apareceu um, o `boot.py` pode não ter sido salvo corretamente — repita
   o passo 2, forçando `sync`, e depois desconecte/reconecte o USB manualmente.

### Cenário C — placa não encontrada

Não há `lsusb` mostrando `2e8a:` nem `239a:`. Pare aqui, me avise que não
detectei a placa, e peça para eu conectá-la (com BOOTSEL se for a primeira vez)
e rodar o prompt de novo. **Não** prossiga às fases seguintes sem a placa.

## Fase 4 — Teste manual do firmware

Antes de mexer nos hooks do Claude Code, prove que o firmware responde:

```bash
# descobre a CDC "data" (a segunda ttyACM do mesmo device)
PORT=$(ls /dev/ttyACM* 2>/dev/null | sort | tail -n1)
echo "Usando $PORT"
# abre sem travar o modem e manda comandos de teste
stty -F "$PORT" 115200 raw -echo
printf 'RED_BLINK\n'   > "$PORT"; sleep 2
printf 'GREEN_BLINK\n' > "$PORT"; sleep 2
printf 'GREEN\n'       > "$PORT"; sleep 2
printf 'OFF\n'         > "$PORT"
```

Me pergunte: "o LED piscou vermelho, depois verde piscando, depois verde
contínuo, e apagou?" Só continue se a resposta for sim.

## Fase 5 — Daemon como serviço de usuário

```bash
mkdir -p ~/.config/systemd/user
cp ~/claude-led-src/systemd/claude-led.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claude-led.service
sleep 2
systemctl --user status claude-led.service --no-pager | head -n 20
```

Se o status estiver `active (running)` e o log mencionar `conectado em
/dev/ttyACM...`, seguimos. Caso contrário, cole o log de
`journalctl --user -u claude-led -n 50 --no-pager` e pare.

## Fase 6 — Hooks globais do Claude Code

Queremos **mergear** (não sobrescrever) o snippet em `~/.claude/settings.json`.
Há 4 eventos a adicionar: `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`.
Cada um é um array; se já existir, **adicione** nossos handlers aos existentes.

Procedimento seguro:

1. Se `~/.claude/settings.json` não existir, crie com o conteúdo de
   `~/claude-led-src/hooks/settings.snippet.json`.
2. Se já existir, faça backup: `cp ~/.claude/settings.json ~/.claude/settings.json.bak-$(date +%s)`.
3. Use `jq` para mergear. Para cada evento `E` do snippet, adicione nossos
   entries no array `.hooks[E]` existente, preservando o que já estava lá:

   ```bash
   SNIPPET=~/claude-led-src/hooks/settings.snippet.json
   SETTINGS=~/.claude/settings.json

   # cria o arquivo se não existir
   [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

   tmp=$(mktemp)
   jq --slurpfile snip "$SNIPPET" '
     . as $base
     | reduce ($snip[0].hooks | keys[]) as $evt (
         $base;
         .hooks[$evt] = ((.hooks[$evt] // []) + $snip[0].hooks[$evt])
       )
   ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"

   jq '.hooks | keys' "$SETTINGS"
   ```

4. Valide com `jq empty "$SETTINGS"` — deve sair sem erro.

Se `jq` não estiver instalado, pare e me avise — não tente editar o JSON
manualmente com `sed`/`awk`.

## Fase 7 — Teste end-to-end

1. Abra uma nova sessão do Claude Code em outro terminal e rode `/hooks`.
   Peça para eu confirmar que aparecem 4 hooks: UserPromptSubmit, Notification,
   Stop, SessionEnd, todos apontando para `claude-led-hook.js`.
2. Nesse outro Claude Code, submeta um prompt qualquer. O LED deve ficar **verde
   piscando** enquanto responde e apagar quando terminar.
3. Nesse mesmo Claude Code, peça para rodar algo que exija aprovação (ex.:
   `rm` em arquivo qualquer fora da allowlist). Quando aparecer o permission
   prompt, o LED deve ficar **vermelho piscando**.

## Fase 8 — Relatório final

Me entregue um relatório curto com:

- Caminho do mount usado (se fase A/B).
- Versão do CircuitPython flashada (se fase A).
- Porta serial detectada pelo daemon (primeira linha do journal `conectado em ...`).
- Eventos de hook ativos (saída de `jq '.hooks | keys' ~/.claude/settings.json`).
- Se foi necessário `usermod -aG dialout` (e lembrete para deslogar).
- Qualquer avisoo ou passo que falhou e precisou ser pulado.

## Regras de segurança

- **Nunca** rode `rm -rf` em `/` nem em `~`.
- **Não** mexa em hooks, settings ou serviços que não sejam do claude-led.
- **Não** escreva em `/dev/ttyACM*` com a placa em modo BOOTSEL (não há firmware).
- **Não** baixe UF2 de fontes que não sejam `circuitpython.org` ou
  `downloads.circuitpython.org`.
- Se o `npm install` quiser compilar nativo e falhar por falta de build tools,
  pare e me avise — não tente instalar `build-essential` sem confirmar.
- Ao final, **apague** `~/.cache/claude-led/` se baixou a UF2, só se eu pedir.
  Por padrão, deixe lá para reinstalações futuras.
