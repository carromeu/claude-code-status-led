# boot.py — habilita o canal CDC "data" além do console (REPL)
# Com isso o daemon usa /dev/ttyACM1 e o REPL segue acessível em /dev/ttyACM0
import usb_cdc
usb_cdc.enable(console=True, data=True)
