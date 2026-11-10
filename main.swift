// HeadTracker：耳機頭追 → opentrack (UDP over network)
// 用 CoreMotion 讀取支援頭部追蹤的耳機方向，以 opentrack 的 UDP 格式送出：
// 6 個 little-endian Double：x, y, z (cm), yaw, pitch, roll (度)
// 另有「滑鼠拖曳模式」：按住滑鼠並依頭部角度拖曳，用來控制網頁版 360° 播放器
// 也會在 ws://127.0.0.1:4243 送出角度（JSON：y, p, r 度），給網頁的使用者腳本使用

import SwiftUI
import AppKit
import CoreMotion
import Network

final class Tracker: NSObject, ObservableObject, CMHeadphoneMotionManagerDelegate {
    @Published var status = "尚未開始"
    @Published var headphonesConnected = false
    @Published var running = false
    @Published var yaw = 0.0
    @Published var pitch = 0.0
    @Published var roll = 0.0
    @Published var host = "127.0.0.1"
    @Published var port = "4242"
    @Published var invertYaw = false
    @Published var invertPitch = false
    @Published var invertRoll = false
    @Published var packetsSent = 0
    @Published var pixelsPerDegree = 8.0
    @Published var dragging = false
    @Published var countdown = 0

    private var dragOrigin: CGPoint?
    private var lastDragPoint: CGPoint?
    private var escMonitors: [Any] = []

    private let motion = CMHeadphoneMotionManager()
    private let motionQueue = OperationQueue()
    private var connection: NWConnection?
    private var reference: CMAttitude?
    private var recenterPending = true

    private var hotkeyMonitors: [Any] = []

    @Published var webClients = 0
    private let wsQueue = DispatchQueue(label: "headtracker.ws")
    private var wsListener: NWListener?
    private var wsClients: [NWConnection] = []  // 只在 wsQueue 存取

    override init() {
        super.init()
        motion.delegate = self
        motionQueue.maxConcurrentOperationCount = 1
        installHotkeys()
        startWebSocketServer()
        // 開啟就開始讀耳機，網頁腳本連上就能直接用
        DispatchQueue.main.async { self.start() }
    }

    // MARK: 網頁腳本用的 WebSocket（只聽本機）

    private func startWebSocketServer() {
        let params = NWParameters.tcp
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true

        guard let listener = try? NWListener(using: params, on: 4243) else {
            status = "無法開啟網頁連線（port 4243 被占用？）"
            return
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            conn.stateUpdateHandler = { [weak self, weak conn] state in
                guard let self, let conn else { return }
                switch state {
                case .failed, .cancelled: self.removeWebClient(conn)
                default: break
                }
            }
            self.wsClients.append(conn)
            self.publishWebClientCount()
            conn.start(queue: self.wsQueue)
            self.receiveLoop(conn)
        }
        listener.start(queue: wsQueue)
        wsListener = listener
    }

    // 只是為了偵測斷線，網頁送來的內容不處理
    private func receiveLoop(_ conn: NWConnection) {
        conn.receiveMessage { [weak self, weak conn] _, _, _, error in
            guard let self, let conn else { return }
            if error != nil { conn.cancel(); return }
            self.receiveLoop(conn)
        }
    }

    private func removeWebClient(_ conn: NWConnection) {
        wsClients.removeAll { $0 === conn }
        publishWebClientCount()
    }

    private func publishWebClientCount() {
        let count = wsClients.count
        DispatchQueue.main.async { self.webClients = count }
    }

    private func broadcast(yaw: Double, pitch: Double, roll: Double) {
        let text = String(format: "{\"y\":%.3f,\"p\":%.3f,\"r\":%.3f}", yaw, pitch, roll)
        let data = Data(text.utf8)
        wsQueue.async {
            guard !self.wsClients.isEmpty else { return }
            let meta = NWProtocolWebSocket.Metadata(opcode: .text)
            let context = NWConnection.ContentContext(identifier: "angles", metadata: [meta])
            for conn in self.wsClients where conn.state == .ready {
                conn.send(content: data, contentContext: context, isComplete: true,
                          completion: .contentProcessed { _ in })
            }
        }
    }

    /// 全域快速鍵（需要輔助使用權限）：⌃⌥D 立刻開始／停止拖曳，⌃⌥R 重新置中
    /// 讓 Chrome 全螢幕時不用切回本 App 也能操作
    private func installHotkeys() {
        let onKey: (NSEvent) -> Bool = { [weak self] event in
            guard let self,
                  event.modifierFlags.intersection(.deviceIndependentFlagsMask) == [.control, .option]
            else { return false }
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "d": self.toggleDragNow(); return true
            case "r": self.recenter(); return true
            default: return false
            }
        }
        hotkeyMonitors = [
            NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { _ = onKey($0) } as Any,
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { onKey($0) ? nil : $0 } as Any,
        ]
    }

    func start() {
        guard motion.isDeviceMotionAvailable else {
            status = "這台裝置不支援耳機頭追"
            return
        }
        guard let nwPort = NWEndpoint.Port(port.trimmingCharacters(in: .whitespaces)) else {
            status = "Port 格式錯誤"
            return
        }
        let conn = NWConnection(host: NWEndpoint.Host(host.trimmingCharacters(in: .whitespaces)),
                                port: nwPort, using: .udp)
        conn.start(queue: .global(qos: .userInteractive))
        connection = conn
        recenterPending = true
        packetsSent = 0

        motion.startDeviceMotionUpdates(to: motionQueue) { [weak self] data, error in
            guard let self else { return }
            if let error {
                DispatchQueue.main.async { self.status = "錯誤：\(error.localizedDescription)" }
                return
            }
            guard let data else { return }
            self.handle(data.attitude)
        }
        running = true
        status = "等待耳機資料…（請戴上耳機）"
    }

    func stop() {
        stopDrag()
        motion.stopDeviceMotionUpdates()
        connection?.cancel()
        connection = nil
        running = false
        status = "已停止"
    }

    /// 下一筆資料會被當成「正前方」
    func recenter() {
        recenterPending = true
    }

    // MARK: 滑鼠拖曳模式

    /// 倒數 3 秒後，在當下游標位置按住滑鼠，之後依頭部角度拖曳
    func startDrag() {
        guard checkAccessibility() else { return }
        countdown = 3
        tick()
    }

    /// 快速鍵用：不倒數，直接在游標位置開始；拖曳中再按一次就停止
    func toggleDragNow() {
        if dragging || countdown > 0 { stopDrag(); return }
        guard checkAccessibility() else { return }
        if !running { start() }
        guard running else { return }
        beginDrag()
    }

    private func checkAccessibility() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        guard AXIsProcessTrustedWithOptions(options) else {
            status = "請到 系統設定 → 隱私權與安全性 → 輔助使用 允許本 App，再重開 App"
            return false
        }
        return true
    }

    private func tick() {
        guard countdown > 0 else { beginDrag(); return }
        status = "\(countdown) 秒後開始，請把游標移到影片上"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, self.countdown > 0 else { return }
            self.countdown -= 1
            self.tick()
        }
    }

    private func beginDrag() {
        guard let origin = CGEvent(source: nil)?.location else { return }
        postMouse(.leftMouseDown, at: origin)
        dragOrigin = origin
        lastDragPoint = origin
        dragging = true
        recenter()
        status = "拖曳中（按 Esc 或 ⌃⌥D 停止）"

        let onKey: (NSEvent) -> Void = { [weak self] event in
            if event.keyCode == 53 { self?.stopDrag() } // Esc
        }
        escMonitors = [
            NSEvent.addGlobalMonitorForEvents(matching: .keyDown, handler: onKey) as Any,
            NSEvent.addLocalMonitorForEvents(matching: .keyDown) { onKey($0); return $0 } as Any,
        ]
    }

    func stopDrag() {
        countdown = 0
        escMonitors.forEach { NSEvent.removeMonitor($0) }
        escMonitors = []
        guard dragging else { return }
        if let point = lastDragPoint { postMouse(.leftMouseUp, at: point) }
        dragOrigin = nil
        lastDragPoint = nil
        dragging = false
        status = running ? "傳送中" : "已停止"
    }

    // 在主執行緒執行
    private func updateDrag(yaw: Double, pitch: Double) {
        guard let origin = dragOrigin else { return }
        // 頭往左轉 → 往右拖（多數播放器是「抓住畫面」的拖法），方向不對就用反轉選項
        var point = CGPoint(x: origin.x + yaw * pixelsPerDegree,
                            y: origin.y + pitch * pixelsPerDegree)
        let bounds = CGDisplayBounds(CGMainDisplayID())
        point.x = min(max(point.x, bounds.minX + 1), bounds.maxX - 2)
        point.y = min(max(point.y, bounds.minY + 1), bounds.maxY - 2)
        postMouse(.leftMouseDragged, at: point)
        lastDragPoint = point
    }

    private func postMouse(_ type: CGEventType, at point: CGPoint) {
        CGEvent(mouseEventSource: nil, mouseType: type,
                mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    }

    // 在 motionQueue 上執行
    private func handle(_ attitude: CMAttitude) {
        if recenterPending || reference == nil {
            reference = attitude.copy() as? CMAttitude
            recenterPending = false
        }
        let relative = attitude.copy() as! CMAttitude
        if let reference { relative.multiply(byInverseOf: reference) }

        let toDeg = 180.0 / Double.pi
        var y = relative.yaw * toDeg
        var p = relative.pitch * toDeg
        var r = relative.roll * toDeg

        // 在主執行緒讀設定值會有競態，但只是 Bool，影響可忽略
        if invertYaw { y = -y }
        if invertPitch { p = -p }
        if invertRoll { r = -r }

        var values: [Double] = [0, 0, 0, y, p, r]
        let packet = Data(bytes: &values, count: values.count * MemoryLayout<Double>.size)
        connection?.send(content: packet, completion: .contentProcessed { _ in })
        broadcast(yaw: y, pitch: p, roll: r)

        DispatchQueue.main.async {
            self.yaw = y
            self.pitch = p
            self.roll = r
            self.packetsSent += 1
            if self.status.hasPrefix("等待") { self.status = "傳送中" }
            self.updateDrag(yaw: y, pitch: p)
        }
    }

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        DispatchQueue.main.async { self.headphonesConnected = true }
    }

    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        DispatchQueue.main.async {
            self.headphonesConnected = false
            if self.running { self.status = "耳機已斷線，等待重新連線…" }
        }
    }
}

/// 書籤小工具：在網頁（含同源 iframe）把游標設成透明；再點一次、按 Esc 或退出全螢幕都會恢復
let hideCursorBookmarklet = """
javascript:(()=>{const id='apt-nocursor';const docs=[document];document.querySelectorAll('iframe').forEach(f=>{try{if(f.contentDocument)docs.push(f.contentDocument)}catch(e){}});const off=()=>{docs.forEach(d=>{const o=d.getElementById(id);if(o)o.remove();d.removeEventListener('keydown',window.__aptKey,true)});document.removeEventListener('fullscreenchange',window.__aptFs);document.removeEventListener('webkitfullscreenchange',window.__aptFs)};if(document.getElementById(id)){off();return}window.__aptKey=e=>{if(e.key==='Escape')off()};window.__aptFs=()=>{if(!(document.fullscreenElement||document.webkitFullscreenElement))off()};docs.forEach(d=>{const s=d.createElement('style');s.id=id;s.textContent='*,*:hover,*:active{cursor:none!important}';d.documentElement.appendChild(s);d.addEventListener('keydown',window.__aptKey,true)});document.addEventListener('fullscreenchange',window.__aptFs);document.addEventListener('webkitfullscreenchange',window.__aptFs)})()
"""

struct ContentView: View {
    @ObservedObject var tracker: Tracker

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Circle()
                    .fill(tracker.headphonesConnected ? Color.green : Color.gray)
                    .frame(width: 10, height: 10)
                Text(tracker.headphonesConnected ? "耳機已連線" : "耳機未偵測到")
                Text("・網頁連線 \(tracker.webClients)")
                    .foregroundStyle(tracker.webClients > 0 ? Color.green : Color.secondary)
                Spacer()
                Text(tracker.status).foregroundStyle(.secondary)
            }

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                angleRow("Yaw（左右轉）", tracker.yaw)
                angleRow("Pitch（點頭）", tracker.pitch)
                angleRow("Roll（歪頭）", tracker.roll)
            }
            .font(.system(.body, design: .monospaced))

            HStack {
                Text("目標")
                TextField("IP", text: $tracker.host).frame(width: 140)
                Text(":")
                TextField("Port", text: $tracker.port).frame(width: 60)
            }
            .disabled(tracker.running)

            HStack {
                Toggle("反轉 Yaw", isOn: $tracker.invertYaw)
                Toggle("反轉 Pitch", isOn: $tracker.invertPitch)
                Toggle("反轉 Roll", isOn: $tracker.invertRoll)
            }

            HStack {
                Button(tracker.running ? "停止" : "開始") {
                    tracker.running ? tracker.stop() : tracker.start()
                }
                .keyboardShortcut(.defaultAction)
                Button("重新置中") { tracker.recenter() }
                    .keyboardShortcut("r", modifiers: [])
                    .disabled(!tracker.running)
                Spacer()
                Text("已送出 \(tracker.packetsSent) 筆").foregroundStyle(.secondary)
            }

            Divider()

            Text("滑鼠拖曳模式（網頁 360° 播放器）").font(.headline)
            HStack {
                Text("靈敏度")
                Slider(value: $tracker.pixelsPerDegree, in: 1...30)
                Text(String(format: "%.0f px/°", tracker.pixelsPerDegree))
                    .font(.system(.body, design: .monospaced))
                    .frame(width: 70, alignment: .trailing)
            }
            HStack {
                Spacer()
                Button("複製隱藏游標書籤") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(hideCursorBookmarklet, forType: .string)
                    tracker.status = "已複製，請新增書籤並把網址貼上"
                }
            }
            HStack {
                Button(tracker.dragging ? "停止拖曳（Esc）" : "開始拖曳") {
                    tracker.dragging || tracker.countdown > 0 ? tracker.stopDrag() : tracker.startDrag()
                }
                .disabled(!tracker.running)
                Text("按下後 3 秒內把游標移到影片上")
                    .foregroundStyle(.secondary)
            }
            Text("快速鍵（在 Chrome 全螢幕裡也能用）：⌃⌥D 立刻開始／停止拖曳，⌃⌥R 重新置中")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func angleRow(_ label: String, _ value: Double) -> some View {
        GridRow {
            Text(label)
            Text(String(format: "%+7.1f°", value))
        }
    }
}

@main
struct HeadTrackerApp: App {
    @StateObject private var tracker = Tracker()

    var body: some Scene {
        WindowGroup("HeadTracker") {
            ContentView(tracker: tracker)
        }
        .windowResizability(.contentSize)
    }
}
