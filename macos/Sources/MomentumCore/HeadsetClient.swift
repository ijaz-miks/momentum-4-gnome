import Foundation

@MainActor public final class HeadsetClient {
    public let transport: GaiaTransport
    public init(transport: GaiaTransport) { self.transport = transport }

    public func read(_ command: UInt16, payload: [UInt8] = [], vendor: UInt16 = GaiaFrame.sennheiser) async throws -> [UInt8] {
        try Task.checkCancellation()
        let response = try await transport.exchange(GaiaFrame(vendor: vendor, command: command, payload: payload))
        guard response.vendor == vendor else { throw HeadsetError.invalid("Unexpected response vendor.") }
        if response.command == command | 0x180 {
            throw HeadsetError.rejected(vendor: vendor, command: command, payload: response.payload)
        }
        guard response.command == command | 0x100 else { throw HeadsetError.invalid("Unexpected response command.") }
        return response.payload
    }
    private func write(_ command: UInt16, payload: [UInt8], vendor: UInt16 = GaiaFrame.sennheiser) async throws {
        guard try await read(command, payload: payload, vendor: vendor).isEmpty else {
            throw HeadsetError.invalid("Unexpected acknowledgement payload.")
        }
    }
    private func byte(_ command: UInt16, maximum: Int = 255) async throws -> Int {
        let bytes = try await read(command)
        guard bytes.count == 1, Int(bytes[0]) <= maximum else { throw HeadsetError.invalid("Invalid numeric response.") }
        return Int(bytes[0])
    }
    private func optionalByte(_ command: UInt16, maximum: Int) async throws -> Int? {
        do { return try await byte(command, maximum: maximum) }
        catch HeadsetError.rejected { return nil }
    }
    public func value(_ control: Control) async throws -> Int {
        try control.decode(await read(control.readCommand, payload: control.readPayload, vendor: control.vendor))
    }
    public func peer(_ index: Int) async throws -> Peer {
        guard (0...15).contains(index) else { throw HeadsetError.invalid("Invalid peer index.") }
        return try Peer.decode(await read(0x1401, payload: [UInt8(index)]), index: index)
    }
    public func connections() async throws -> Connections {
        let countBytes = try await read(0x1400)
        guard countBytes.count == 2 else { throw HeadsetError.invalid("Invalid paired-device count.") }
        let count = Int(countBytes[0]) << 8 | Int(countBytes[1])
        guard (1...16).contains(count) else { throw HeadsetError.invalid("Unsupported paired-device count.") }
        let own = try await byte(0x1407, maximum: 15)
        let capacity = try await byte(0x1409, maximum: 2)
        var peers: [Peer] = []
        for index in 0..<count { peers.append(try await peer(index)) }
        return try Connections(capacity: capacity, ownIndex: own, peers: peers)
    }
    private func peerConnected(_ index: Int) async throws -> Bool {
        let bytes = try await read(0x1404, payload: [UInt8(index)])
        guard bytes.count == 2, bytes[0] == index, bytes[1] <= 1 else {
            throw HeadsetError.invalid("Invalid peer connection status.")
        }
        return bytes[1] == 1
    }
    private func changePeer(_ peer: Peer, connected: Bool) async throws {
        guard try await self.peer(peer.index).name == peer.name else {
            throw HeadsetError.verification("The paired-device identity changed during switching.")
        }
        try await write(connected ? 0x1402 : 0x1403, payload: [UInt8(peer.index)])
        let deadline = Date().addingTimeInterval(15)
        repeat {
            if try await peerConnected(peer.index) == connected { return }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < deadline
        throw HeadsetError.timeout
    }
    public func switchPeer(index: Int, name: String, connected: Bool = true) async throws {
        let before = try await connections()
        let target = try before.checkedPeer(index: index, name: name)
        guard target.connected != connected else { return }
        var displaced: Peer?
        if connected {
            guard before.capacity == 2 else { throw HeadsetError.invalid("Enable multipoint to connect another source.") }
            if before.peers.filter(\.connected).count >= before.capacity {
                guard let previous = before.peers.filter({ $0.connected && $0.index != before.ownIndex && $0.index != index })
                    .max(by: { $0.priority < $1.priority }) else { throw HeadsetError.invalid("No available connection slot.") }
                try await changePeer(previous, connected: false)
                displaced = previous
            }
        }
        do {
            try await changePeer(target, connected: connected)
            guard try await peerConnected(before.ownIndex), try await peer(index).name == name else {
                throw HeadsetError.verification("The source switch was not confirmed.")
            }
        } catch {
            guard let previous = displaced else { throw error }
            do {
                if try await peerConnected(target.index) { try await changePeer(target, connected: false) }
                try await changePeer(previous, connected: true)
            } catch let rollback {
                throw HeadsetError.verification("Switch failed and the previous source could not be restored: \(rollback.localizedDescription)")
            }
            throw HeadsetError.verification("Switch failed. The previous source was restored: \(error.localizedDescription)")
        }
    }
    public func equalizer() async throws -> Equalizer {
        let config = try await read(0x1000)
        guard config.count >= 3, (1...16).contains(config[0]) else { throw HeadsetError.invalid("Invalid equalizer configuration.") }
        let minimum = Int(Int8(bitPattern: config[1])), maximum = Int(Int8(bitPattern: config[2]))
        var gains: [Int] = []
        for band in 0..<Int(config[0]) {
            let bytes = try await read(0x1002, payload: [UInt8(band)])
            let gain: UInt8
            if bytes.count == 1 { gain = bytes[0] }
            else if bytes.count == 2 && bytes[0] == band { gain = bytes[1] }
            else { throw HeadsetError.invalid("Invalid equalizer band response.") }
            gains.append(Int(Int8(bitPattern: gain)))
        }
        return try Equalizer(minimum: minimum, maximum: maximum, gains: gains)
    }
    public func applyEqualizer(_ gains: [Int]) async throws {
        let before = try await equalizer(), mode = try await value(.soundMode)
        guard gains.count == before.gains.count, gains.allSatisfy({ (before.minimum...before.maximum).contains($0) }) else {
            throw HeadsetError.invalid("The preset does not match the headset's equalizer limits.")
        }
        do {
            if mode != 1 { try await write(0x0803, payload: [0, 1]) }
            for band in gains.indices where gains[band] != before.gains[band] {
                try await write(0x1001, payload: [UInt8(band), UInt8(bitPattern: Int8(gains[band]))])
            }
            guard try await equalizer().gains == gains, try await value(.soundMode) == 1 else {
                throw HeadsetError.verification("Equalizer readback did not match the requested profile.")
            }
        } catch {
            do {
                for band in before.gains.indices {
                    try await write(0x1001, payload: [UInt8(band), UInt8(bitPattern: Int8(before.gains[band]))])
                }
                try await write(0x0803, payload: [0, UInt8(mode)])
                guard try await equalizer().gains == before.gains, try await value(.soundMode) == mode else {
                    throw HeadsetError.verification("Previous EQ state was not restored.")
                }
            } catch let rollback {
                throw HeadsetError.verification("EQ update failed and restoration was incomplete: \(rollback.localizedDescription)")
            }
            throw HeadsetError.verification("EQ update failed. The previous profile was restored: \(error.localizedDescription)")
        }
    }
    public func setBand(_ band: Int, gain: Int) async throws {
        var eq = try await equalizer()
        guard eq.gains.indices.contains(band), (eq.minimum...eq.maximum).contains(gain) else {
            throw HeadsetError.invalid("Invalid EQ band or gain.")
        }
        eq.gains[band] = gain
        try await applyEqualizer(eq.gains)
    }
    private func recover() async throws {
        let deadline = Date().addingTimeInterval(24)
        var last: Error = HeadsetError.timeout
        repeat {
            try Task.checkCancellation()
            do {
                try await transport.open(reconnect: true)
                _ = try await byte(0x0603, maximum: 100)
                return
            } catch { last = error; transport.close() }
            try await Task.sleep(nanoseconds: 500_000_000)
        } while Date() < deadline
        throw HeadsetError.unavailable("Could not restore the control connection: \(last.localizedDescription)")
    }
    public func set(_ control: Control, to value: Int) async throws {
        let payload = try control.writePayload(value)
        if try await self.value(control) == value { return }
        if control == .soundMode && value == 3 {
            guard try await byte(0x2001, maximum: 3) == 2 else {
                throw HeadsetError.invalid("Create a personalized sound profile in Smart Control Plus first.")
            }
        }
        if control == .multipoint || control == .audioPriority {
            let previous = control == .audioPriority ? try await connections() : nil
            // Either change can reset Bluetooth. An uncertain setter is never replayed.
            do { try await write(control.writeCommand, payload: payload, vendor: control.vendor) }
            catch { if case HeadsetError.rejected = error { throw error } }
            transport.close()
            try await Task.sleep(nanoseconds: 750_000_000)
            try await recover()
            guard try await self.value(control) == value else { throw HeadsetError.verification("The headset did not confirm the requested change.") }
            let actual = try await connections()
            if control == .multipoint {
                guard actual.capacity == (value == 1 ? 2 : 1) else { throw HeadsetError.verification("Multipoint state and capacity disagree.") }
            } else if let previous {
                for old in previous.peers where old.connected && old.index != previous.ownIndex {
                    let fresh = try await connections()
                    guard let candidate = fresh.peers.first(where: { $0.name == old.name }) else {
                        throw HeadsetError.verification("A previous source is no longer paired.")
                    }
                    if !candidate.connected {
                        guard fresh.peers.filter(\.connected).count < fresh.capacity else {
                            throw HeadsetError.verification("No free slot to restore the previous source.")
                        }
                        _ = try fresh.checkedPeer(index: candidate.index, name: candidate.name)
                        try await changePeer(candidate, connected: true)
                    }
                }
            }
        } else {
            do { try await write(control.writeCommand, payload: payload, vendor: control.vendor) }
            catch HeadsetError.rejected(let vendor, let command, let bytes)
                where control == .soundMode && vendor == control.vendor && command == control.writeCommand && bytes.first == 0x80 {
                // Another controller may have selected it after our initial read.
                // The fresh read below must still confirm the requested mode.
            }
            guard try await self.value(control) == value else { throw HeadsetError.verification("The setting was not confirmed by the headset.") }
        }
    }
    public func rename(_ name: String) async throws {
        guard validName(name) else { throw HeadsetError.invalid("Use 1 to 32 UTF-8 bytes without control characters.") }
        try await write(0x2801, payload: Array(name.utf8))
        guard try await localName() == name else { throw HeadsetError.verification("The headset name was not confirmed.") }
    }
    private func localName() async throws -> String {
        var bytes = try await read(0x2802)
        if bytes.last == 0 { bytes.removeLast() }
        guard let name = String(bytes: bytes, encoding: .utf8), validName(name, maximum: 255) else {
            throw HeadsetError.invalid("Invalid headset name.")
        }
        return name
    }
    public func snapshot(reconnect: Bool = false) async throws -> HeadsetSnapshot {
        try await transport.open(reconnect: reconnect)
        let battery = try await byte(0x0603, maximum: 100)
        let version = try await read(0x1201)
        guard version.count == 6 else { throw HeadsetError.invalid("Invalid firmware response.") }
        let firmware = stride(from: 0, to: 6, by: 2).map { String(Int(version[$0]) << 8 | Int(version[$0 + 1])) }.joined(separator: ".")
        var values: [Control: Int] = [:], unsupported: [Control: String] = [:]
        for control in Control.allCases {
            do { values[control] = try await value(control) }
            catch HeadsetError.rejected { unsupported[control] = "Unavailable on this firmware" }
        }
        let connections = try await connections()
        var eq: Equalizer?
        do { eq = try await equalizer() } catch HeadsetError.rejected { eq = nil }
        let name = try await localName(), codec = try await byte(0x0800)
        let wear = try await optionalByte(0x0402, maximum: 3)
        let language = try await optionalByte(0x0807, maximum: 7)
        let personalization = try await optionalByte(0x2001, maximum: 3)
        var languages: [Int]?
        do {
            let bytes = try await read(0x0808)
            guard bytes.allSatisfy({ $0 <= 7 }) else { throw HeadsetError.invalid("Invalid prompt languages.") }
            languages = bytes.map(Int.init)
        } catch HeadsetError.rejected { languages = nil }
        return HeadsetSnapshot(address: transport.address, name: name, firmware: firmware, battery: battery, codec: codec,
            wearState: wear, promptLanguage: language, availablePromptLanguages: languages,
            personalizationState: personalization, values: values, connections: connections, equalizer: eq, unsupported: unsupported)
    }
}
