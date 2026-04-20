# code.py — Claude Code Status LED (v0.2.0)
# Target: Waveshare RP2040-Zero (WS2812 em GP16) rodando CircuitPython 9.x
#
# Usa o módulo built-in `neopixel_write` (não a lib `neopixel` externa),
# evitando dependência em /lib/neopixel.mpy. Basta o core do CircuitPython.
#
# Protocolo serial (USB-CDC data, 115200 8N1, line-based):
#
#   Estados do MVP v0.1.0 (mantidos como aliases):
#     OFF           -> apaga
#     RED_BLINK     -> vermelho piscando (0.5s) — alias de RED_FAST no mesmo período
#     GREEN_BLINK   -> verde piscando (0.5s)
#     GREEN         -> verde contínuo
#
#   Estados novos v0.2.0 / v0.2.1:
#     RED_SOLID     -> vermelho contínuo (rate limit atingido)
#     RED_FAST      -> vermelho piscando rápido 0.3s (sessão aguardando)
#     MAGENTA_FAST  -> magenta piscando rápido 0.3s (Anthropic API em outage)
#     BLUE_BLINK    -> azul piscando 0.5s (Chrome DevTools ativo)
#     BLUE_PULSE    -> azul com pulse senoidal 2s (tool MCP rodando)
#     GREEN_PULSE   -> verde com pulse senoidal 2s (todas sessões working) [v0.2.1]
#     YELLOW_SLOW   -> amarelo piscando 1s (compactação de contexto)
#     ORANGE_BLINK  -> laranja piscando 0.5s (reservado p/ crash — v0.3.0)
#
#   Utilitários:
#     PING          -> responde "PONG\n" (para o daemon detectar a placa)
#
# Sem comando por N segundos => apaga automaticamente (fail-safe se o host sumir).

import time
import math
import board
import digitalio
import neopixel_write
import usb_cdc

# ---------- Hardware ----------
_pin = digitalio.DigitalInOut(board.NEOPIXEL)
_pin.direction = digitalio.Direction.OUTPUT

BRIGHTNESS = 0.25  # 0.0..1.0 — teto de intensidade para não ofuscar


def pixel_rgb(r: int, g: int, b: int):
    """Escreve uma cor RGB 0..255 no WS2812 (aplica brightness). Ordem GRB."""
    r = int(r * BRIGHTNESS) & 0xFF
    g = int(g * BRIGHTNESS) & 0xFF
    b = int(b * BRIGHTNESS) & 0xFF
    neopixel_write.neopixel_write(_pin, bytearray([g, r, b]))


def pixel_rgb_scaled(r: int, g: int, b: int, factor: float):
    """Escreve RGB com brightness dinâmico (usado no pulse)."""
    scale = max(0.0, min(1.0, factor)) * BRIGHTNESS
    r = int(r * scale) & 0xFF
    g = int(g * scale) & 0xFF
    b = int(b * scale) & 0xFF
    neopixel_write.neopixel_write(_pin, bytearray([g, r, b]))


# ---------- Serial ----------
serial = usb_cdc.data if usb_cdc.data is not None else usb_cdc.console

# ---------- Estado ----------
# Cada estado: (color_rgb, effect, param)
#   effect: 'solid' | 'blink' | 'pulse'
#   param: blink_interval_s (blink) | period_s (pulse) | None (solid)
STATE_TABLE = {
    'OFF':          ((0, 0, 0),       'solid', None),
    'RED_SOLID':    ((255, 0, 0),     'solid', None),
    'RED_BLINK':    ((255, 0, 0),     'blink', 0.5),   # alias MVP
    'RED_FAST':     ((255, 0, 0),     'blink', 0.3),
    'GREEN':        ((0, 255, 0),     'solid', None),
    'GREEN_BLINK':  ((0, 255, 0),     'blink', 0.5),
    'GREEN_PULSE':  ((0, 255, 0),     'pulse', 2.0),
    'MAGENTA_FAST': ((255, 0, 255),   'blink', 0.3),
    'BLUE_BLINK':   ((0, 0, 255),     'blink', 0.5),
    'BLUE_PULSE':   ((0, 0, 255),     'pulse', 2.0),
    'YELLOW_SLOW':  ((255, 255, 0),   'blink', 1.0),
    'ORANGE_BLINK': ((255, 128, 0),   'blink', 0.5),
}

current_state = 'OFF'
last_command_ts = time.monotonic()
WATCHDOG_SECONDS = 30  # sem comandos por 30s => apaga

# Suporte a blink
blink_on = False
last_blink_ts = time.monotonic()

rx_buffer = bytearray()


def render_once():
    """Aplica a cor atual conforme state (sem mexer no timer)."""
    cfg = STATE_TABLE.get(current_state, STATE_TABLE['OFF'])
    color, effect, _param = cfg
    r, g, b = color
    if effect == 'solid':
        pixel_rgb(r, g, b)
    elif effect == 'blink':
        if blink_on:
            pixel_rgb(r, g, b)
        else:
            pixel_rgb(0, 0, 0)
    elif effect == 'pulse':
        # pulse é aplicado em tempo contínuo no loop principal via update_effects
        pass


def update_effects(now: float):
    """Atualiza blink e pulse a cada iteração do loop."""
    global blink_on, last_blink_ts
    cfg = STATE_TABLE.get(current_state, STATE_TABLE['OFF'])
    color, effect, param = cfg
    r, g, b = color

    if effect == 'blink':
        interval = param or 0.5
        if (now - last_blink_ts) >= interval:
            blink_on = not blink_on
            last_blink_ts = now
            if blink_on:
                pixel_rgb(r, g, b)
            else:
                pixel_rgb(0, 0, 0)
    elif effect == 'pulse':
        period = param or 2.0
        # brightness de 0.1 a 1.0 em curva senoidal
        t = (now % period) / period  # 0..1
        # sin de 0..2pi dá -1..1; reescala pra 0.1..1.0
        f = 0.55 + 0.45 * math.sin(2 * math.pi * t)
        pixel_rgb_scaled(r, g, b, f)


def handle_command(cmd: str):
    """Processa uma linha recebida via serial."""
    global current_state, last_command_ts, blink_on, last_blink_ts
    cmd = cmd.strip().upper()
    if not cmd:
        return

    last_command_ts = time.monotonic()

    if cmd == 'PING':
        try:
            serial.write(b'PONG\n')
        except Exception:
            pass
        return

    if cmd in STATE_TABLE:
        if cmd != current_state:
            current_state = cmd
            blink_on = True  # força "ligado" no primeiro frame
            last_blink_ts = time.monotonic()
            render_once()
    # comandos desconhecidos — ignora


def read_serial_nonblocking():
    """Lê bytes disponíveis e processa linhas completas."""
    global rx_buffer
    if serial is None:
        return
    try:
        n = serial.in_waiting
    except Exception:
        n = 0
    if n <= 0:
        return
    try:
        data = serial.read(n)
    except Exception:
        return
    if not data:
        return
    rx_buffer.extend(data)
    while b'\n' in rx_buffer:
        line, _, rest = rx_buffer.partition(b'\n')
        rx_buffer = bytearray(rest)
        try:
            handle_command(line.decode('utf-8', 'replace'))
        except Exception:
            pass


# Boot: pisca branco rapidamente para indicar que subiu
for _ in range(2):
    pixel_rgb(40, 40, 40)
    time.sleep(0.08)
    pixel_rgb(0, 0, 0)
    time.sleep(0.08)

render_once()

while True:
    read_serial_nonblocking()

    now = time.monotonic()

    # Watchdog: se o host parou de falar, apaga por segurança
    if current_state != 'OFF' and (now - last_command_ts) > WATCHDOG_SECONDS:
        current_state = 'OFF'
        blink_on = False
        render_once()

    update_effects(now)

    time.sleep(0.01)
