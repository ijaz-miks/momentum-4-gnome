import Foundation
import IOBluetooth
import CoreBluetooth
import MomentumCore

@MainActor public final class RFCOMMTransport: NSObject, GaiaTransport, IOBluetoothRFCOMMChannelDelegate, IOBluetoothDeviceAsyncCallbacks, CBCentralManagerDelegate {
    public var selectedAddress = ""
    public var diagnosticsEnabled = false
    public private(set) var diagnosticEvents: [String] = []
    private func record(_ event: String) {
        guard diagnosticsEnabled else { return }
        diagnosticEvents.append(event)
        if diagnosticEvents.count > 64 { diagnosticEvents.removeFirst() }
    }
    public var accessStatus: [String: Int] {
        ["authorization": CBManager.authorization.rawValue, "radioState": bluetooth?.state.rawValue ?? -1]
    }
    public var address: String { Self.normalize(device?.addressString ?? "") }
    public var name: String { device?.name ?? "Momentum 4" }
    private var bluetooth: CBCentralManager?
    private var authorizing: CheckedContinuation<Void, Error>?
    private var device: IOBluetoothDevice?
    private var channel: IOBluetoothRFCOMMChannel?
    private var decoder = GaiaDecoder()
    private var connecting: CheckedContinuation<Void, Error>?
    private var opening: CheckedContinuation<Void, Error>?
    private var querying: CheckedContinuation<Void, Error>?
    private var response: CheckedContinuation<GaiaFrame, Error>?
    private var request: GaiaFrame?
    private var received: GaiaFrame?
    private var writeFinished = false
    private var buffer: NSMutableData?
    private var timer: Task<Void, Never>?

    public static func normalize(_ address: String) -> String {
        address.replacingOccurrences(of: "-", with: ":").uppercased()
    }
    public static func isValidAddress(_ address: String) -> Bool {
        address.isEmpty || normalize(address).range(of: "^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$", options: .regularExpression) != nil
    }
    private static var gaiaUUID: IOBluetoothSDPUUID {
        IOBluetoothSDPUUID(data: Data([0xa2, 0x12, 0x9f, 0xf3, 0x08, 0x1b, 0x4c, 0x45,
            0x8a, 0xfe, 0x46, 0x9d, 0x9c, 0x48, 0x42, 0xec]))
    }
    private func select() throws -> IOBluetoothDevice {
        guard Self.isValidAddress(selectedAddress) else { throw HeadsetError.invalid("Enter a valid headset Bluetooth address.") }
        let paired = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] ?? []
        let wanted = Self.normalize(selectedAddress)
        let candidates = paired.filter { device in
            if !wanted.isEmpty { return Self.normalize(device.addressString ?? "") == wanted }
            return device.getServiceRecord(for: Self.gaiaUUID) != nil ||
                (device.name ?? "").localizedCaseInsensitiveContains("MOMENTUM 4")
        }
        guard !candidates.isEmpty else {
            throw HeadsetError.unavailable("Pair your Momentum 4 in Bluetooth Settings, then connect it to this Mac.")
        }
        guard candidates.count == 1 else {
            throw HeadsetError.unavailable("Several compatible headsets are paired. Select one in Settings.")
        }
        return candidates[0]
    }
    private func ensureBluetoothAccess() async throws {
        if CBManager.authorization == .denied || CBManager.authorization == .restricted {
            throw HeadsetError.unavailable("Allow Bluetooth access for Momentum 4 Controls in System Settings, Privacy & Security.")
        }
        if bluetooth?.state == .poweredOn { return }
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                authorizing = continuation
                armTimeout(seconds: 30, operation: "Bluetooth permission")
                if let bluetooth { updateBluetoothState(bluetooth) }
                else { bluetooth = CBCentralManager(delegate: self, queue: .main, options: [CBCentralManagerOptionShowPowerAlertKey: false]) }
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.close() } })
    }
    private func updateBluetoothState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            if let continuation = authorizing {
                authorizing = nil; timer?.cancel(); timer = nil
                continuation.resume()
            }
        case .poweredOff:
            fail(HeadsetError.unavailable("Bluetooth is off. Turn it on in Bluetooth Settings."))
        case .unauthorized:
            if CBManager.authorization != .notDetermined {
                fail(HeadsetError.unavailable("Allow Bluetooth access for Momentum 4 Controls in System Settings, Privacy & Security."))
            }
        case .unsupported:
            fail(HeadsetError.unavailable("Bluetooth is unavailable on this Mac."))
        default: break
        }
    }
    nonisolated public func centralManagerDidUpdateState(_ central: CBCentralManager) {
        Task { @MainActor [weak self] in self?.updateBluetoothState(central) }
    }
    public func open(reconnect: Bool) async throws {
        try Task.checkCancellation()
        if channel?.isOpen() == true { return }
        guard authorizing == nil, connecting == nil, opening == nil, querying == nil, response == nil else { throw HeadsetError.busy }
        try await ensureBluetoothAccess()
        let selected = try select()
        if !selected.isConnected() && !reconnect {
            throw HeadsetError.unavailable("The headset is disconnected. Choose Connect to this Mac.")
        }
        device = selected
        record("Paired headset selected; connected=\(selected.isConnected()); cachedGAIA=\(selected.getServiceRecord(for: Self.gaiaUUID) != nil)")
        try await withTaskCancellationHandler(operation: {
            if !selected.isConnected() {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    connecting = continuation
                    armTimeout(seconds: 25, operation: "Connecting the paired headset")
                    let status = selected.openConnection(self, withPageTimeout: 0x8000, authenticationRequired: true)
                    record("Baseband connect started: \(status)")
                    if status != 0 {
                        if selected.isConnected() {
                            connecting = nil; timer?.cancel(); timer = nil; continuation.resume()
                        } else { fail(Self.ioError(status)) }
                    }
                }
            }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                querying = continuation
                armTimeout(seconds: 10, operation: "Bluetooth service discovery")
                // Query all services, then select GAIA from the returned records.
                let status = selected.performSDPQuery(self)
                record("Service discovery started: \(status)")
                if status != 0 { fail(Self.ioError(status)) }
            }
            guard let service = selected.getServiceRecord(for: Self.gaiaUUID) else {
                throw HeadsetError.unavailable("The paired device does not provide the Momentum 4 control service.")
            }
            var id: BluetoothRFCOMMChannelID = 0
            guard service.getRFCOMMChannelID(&id) == 0, (1...30).contains(id) else {
                throw HeadsetError.unavailable("The headset did not advertise a valid control channel.")
            }
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                opening = continuation
                armTimeout(seconds: 10, operation: "Opening the headset control channel")
                var opened: IOBluetoothRFCOMMChannel?
                let status = selected.openRFCOMMChannelAsync(&opened, withChannelID: id, delegate: self)
                channel = opened
                record("RFCOMM open started: \(status)")
                if status != 0 { fail(Self.ioError(status)) }
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.close() } })
    }
    public func close() {
        let previous = channel
        channel = nil
        _ = previous?.close()
        fail(HeadsetError.unavailable("The headset control connection closed."))
        buffer = nil
        decoder = GaiaDecoder()
    }
    public func exchange(_ frame: GaiaFrame) async throws -> GaiaFrame {
        try Task.checkCancellation()
        guard response == nil else { throw HeadsetError.busy }
        guard let channel, channel.isOpen() else { throw HeadsetError.unavailable("The headset control connection is unavailable.") }
        let encoded = try frame.encoded()
        guard encoded.count <= Int(channel.getMTU()) else { throw HeadsetError.invalid("Control frame exceeds the channel MTU.") }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                response = continuation; request = frame; received = nil; writeFinished = false
                let data = NSMutableData(data: encoded)
                buffer = data
                armTimeout(seconds: 3, operation: String(format: "Headset command %04x", frame.command))
                let status = channel.writeAsync(data.mutableBytes, length: UInt16(data.length), refcon: nil)
                if status != 0 { fail(Self.ioError(status)) }
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.close() } })
    }
    private static func ioError(_ status: IOReturn) -> HeadsetError {
        .unavailable("Bluetooth operation failed (\(String(format: "0x%08x", UInt32(bitPattern: status)))).")
    }
    private func armTimeout(seconds: TimeInterval, operation: String) {
        timer?.cancel()
        timer = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000)) }
            catch { return }
            self?.fail(HeadsetError.unavailable("\(operation) timed out. Connect your headset and try again."))
            self?.close()
        }
    }
    private func fail(_ error: Error) {
        record(error.localizedDescription)
        timer?.cancel(); timer = nil
        let authorization = authorizing
        authorizing = nil
        authorization?.resume(throwing: error)
        let connect = connecting, query = querying, open = opening, reply = response
        connecting = nil; querying = nil; opening = nil; response = nil; request = nil; received = nil
        connect?.resume(throwing: error); query?.resume(throwing: error); open?.resume(throwing: error); reply?.resume(throwing: error)
    }
    private func completeResponse() {
        guard writeFinished, let received, let response else { return }
        timer?.cancel(); timer = nil
        self.response = nil; request = nil; self.received = nil; buffer = nil
        response.resume(returning: received)
    }
    // Callbacks distinguish baseband connection from service discovery.
    nonisolated public func remoteNameRequestComplete(_ device: IOBluetoothDevice!, status: IOReturn) {}
    nonisolated public func connectionComplete(_ device: IOBluetoothDevice!, status: IOReturn) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.record("Baseband callback: \(status); selectedDevice=\(self.device === device)")
            guard self.device === device, let continuation = self.connecting else { return }
            self.connecting = nil; self.timer?.cancel(); self.timer = nil
            if status == 0 && device.isConnected() { continuation.resume() }
            else { continuation.resume(throwing: Self.ioError(status)) }
        }
    }
    nonisolated public func sdpQueryComplete(_ device: IOBluetoothDevice!, status: IOReturn) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.record("Service callback: \(status); selectedDevice=\(self.device === device)")
            guard self.device === device, let continuation = self.querying else { return }
            self.querying = nil; self.timer?.cancel(); self.timer = nil
            if status == 0 { continuation.resume() } else { continuation.resume(throwing: Self.ioError(status)) }
        }
    }
    nonisolated public func rfcommChannelOpenComplete(_ channel: IOBluetoothRFCOMMChannel!, status: IOReturn) {
        Task { @MainActor [weak self] in
            guard let self, self.channel === channel, let continuation = self.opening else { return }
            self.record("RFCOMM open callback: \(status)")
            self.opening = nil; self.timer?.cancel(); self.timer = nil
            if status == 0 && channel.isOpen() { continuation.resume() }
            else { continuation.resume(throwing: Self.ioError(status)) }
        }
    }
    nonisolated public func rfcommChannelData(_ channel: IOBluetoothRFCOMMChannel!, data pointer: UnsafeMutableRawPointer!, length: Int) {
        // The callback's buffer is owned by IOBluetooth and expires on return.
        let data = Data(bytes: pointer, count: length)
        Task { @MainActor [weak self] in
            guard let self, self.channel === channel else { return }
            do {
                for frame in try self.decoder.feed(data) {
                    guard let request = self.request, frame.vendor == request.vendor,
                        frame.command == request.command | 0x100 || frame.command == request.command | 0x180 else { continue }
                    self.received = frame
                    self.completeResponse()
                }
            } catch { self.fail(error); self.close() }
        }
    }
    nonisolated public func rfcommChannelWriteComplete(_ channel: IOBluetoothRFCOMMChannel!, refcon: UnsafeMutableRawPointer!, status: IOReturn) {
        Task { @MainActor [weak self] in
            guard let self, self.channel === channel else { return }
            if status != 0 { self.fail(Self.ioError(status)); self.close(); return }
            self.writeFinished = true
            self.completeResponse()
        }
    }
    nonisolated public func rfcommChannelClosed(_ channel: IOBluetoothRFCOMMChannel!) {
        Task { @MainActor [weak self] in
            guard let self, self.channel === channel else { return }
            self.channel = nil
            self.fail(HeadsetError.unavailable("The headset disconnected."))
            self.buffer = nil
        }
    }
}
