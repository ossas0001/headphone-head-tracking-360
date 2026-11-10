# 沒有 opentrack 時用來測試：印出收到的頭追資料
# 用法：python3 listen.py [port]
import socket, struct, sys

port = int(sys.argv[1]) if len(sys.argv) > 1 else 4242
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", port))
print(f"監聽 UDP {port} 中，Ctrl+C 結束")
while True:
    data, _ = sock.recvfrom(64)
    if len(data) == 48:
        x, y, z, yaw, pitch, roll = struct.unpack("<6d", data)
        print(f"\ryaw {yaw:+7.1f}  pitch {pitch:+7.1f}  roll {roll:+7.1f}", end="", flush=True)
