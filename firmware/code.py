# code.py — Claude Code Status LED
# Target: Waveshare RP2040-Zero (WS2812 em GP16) rodando CircuitPython 9.x
#
# Protocolo serial (USB-CDC data, 115200 8N1, line-based):
#   OFF            -> apaga
#   RED_BLINK      -> vermelho piscando (atenção: sessão esperando input)
#   GREEN_BLINK    -> verde piscando (todas sessões trabalhando)
#   GREEN          -> verde contínuo (mix trabalhando/parado)
#   PING           -> responde "PONG\n" (para o daemon detectar a placa)
#
# Sem comando por N segundos => apaga automaticamente (fail-safe se o host sumir).

import time
import board
import neopixel
import usb_cdc
import supervisor

# ---------- Hardware ----------
# RP2040-Zero: WS2812 onboard em GP16 (board.NEOPIXEL no CircuitPython recente)
pixel = neopixel.NeoPixel(board.NEOPIXEL, 1, brightness=0.25, auto_write=True)

# ---------- Serial ----------
# Usamos o canal CDC "data" (segundo canal USB serial), deixando o REPL livre.
# Se preferir usar só um canal, troque por usb_cdc.console (ajuste boot.py).
serial = usb_cdc.data if usb_cdc.data is not None else usb_cdc.console

# ---------- Estado ----------
STATE_OFF = 0
STATE_RED_BLINK = 1
STATE_GREEN_BLINK = 2
STATE_GREEN = 3

state = STATE_OFF
last_command_ts = time.monotonic()
WATCHDOG_SECONDS = 30  # sem comandos por 30s => apaga (host caiu/desconectou)

BLINK_INTERVAL = 0.5  # segundos
blink_on = False
last_blink_ts = time.monotonic()

rx_buffer = bytearray()


def apply_state():
    """Aplica a cor atual no LED com base em `state` e `blink_on`."""
    if state == STATE_OFF:
        pixel[0] = (0, 0, 0)
    elif state == STATE_GREEN:
        pixel[0] = (0, 255, 0)
    elif state == STATE_GREEN_BLINK:
        pixel[0] = (0, 255, 0) if blink_on else (0, 0, 0)
    elif state == STATE_RED_BLINK:
        pixel[0] = (255, 0, 0) if blink_on else (0, 0, 0)


def handle_command(cmd: str):
    """Processa uma linha recebida via serial."""
    global state, last_command_ts, blink_on
    cmd = cmd.strip().upper()
    if not cmd:
        return

    last_command_ts = time.monotonic()

    if cmd == "OFF":
        state = STATE_OFF
        blink_on = False
    elif cmd == "RED_BLINK":
        state = STATE_RED_BLINK
    elif cmd == "GREEN_BLINK":
        state = STATE_GREEN_BLINK
    elif cmd == "GREEN":
        state = STATE_GREEN
        blink_on = True  # força cor ligada no modo contínuo
    elif cmd == "PING":
        try:
            serial.write(b"PONG\n")
        except Exception:
            pass
        return  # não altera estado visual
    else:
        # comando desconhecido — ignora silenciosamente
        return

    apply_state()


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
    while b"\n" in rx_buffer:
        line, _, rest = rx_buffer.partition(b"\n")
        rx_buffer = bytearray(rest)
        try:
            handle_command(line.decode("utf-8", "replace"))
        except Exception:
            pass


# Boot: pisca branco rapidamente para indicar que subiu
for _ in range(2):
    pixel[0] = (40, 40, 40)
    time.sleep(0.08)
    pixel[0] = (0, 0, 0)
    time.sleep(0.08)

apply_state()

while True:
    read_serial_nonblocking()

    now = time.monotonic()

    # Watchdog: se o host parou de falar, apaga por segurança
    if state != STATE_OFF and (now - last_command_ts) > WATCHDOG_SECONDS:
        state = STATE_OFF
        blink_on = False
        apply_state()

    # Pisca
    if state in (STATE_RED_BLINK, STATE_GREEN_BLINK):
        if (now - last_blink_ts) >= BLINK_INTERVAL:
            blink_on = not blink_on
            last_blink_ts = now
            apply_state()

    time.sleep(0.01)
