import Foundation
import MomentumCore

/// Explicit development fixture. Production discovery never falls back to it.
@MainActor public final class SimulatedTransport: GaiaTransport {
    public let address = "00:11:22:33:44:55"
    public let name = "MOMENTUM 4"
    public var values: [Control: Int] = Dictionary(uniqueKeysWithValues: Control.allCases.map { ($0, 0) })
    public var gains = [0, 0, 0, 0, 0]
    public var headsetName = "MOMENTUM 4"
    public var peers = [Peer(index: 0, priority: 0, connected: true, name: "This Mac"),
        Peer(index: 1, priority: 1, connected: true, name: "Test phone"),
        Peer(index: 2, priority: 2, connected: false, name: "Windows PC"),
        Peer(index: 3, priority: 3, connected: false, name: "Ubuntu PC")]
    public var unsupportedControls: Set<Control> = []
    public var malformedControl: Control?
    public var failConnectIndex: Int?
    public var failEQBand: Int?
    public var uncertainMultipointAck = false
    public var delayedPeerPolls = 0
    public var exchangeDelay: UInt64 = 0
    public private(set) var maximumConcurrentRequests = 0
    public private(set) var frames: [GaiaFrame] = []
    public private(set) var openCount = 0
    public private(set) var closeCount = 0
    private var isOpen = false
    private var pending: [Int: (Bool, Int)] = [:]
    private var active = 0

    public init() {
        values[.anc] = 1; values[.onHeadDetection] = 1; values[.smartPause] = 1
        values[.multipoint] = 1; values[.soundMode] = 1; values[.transparency] = 35
        values[.sidetone] = 2; values[.promptMode] = 2; values[.autoPowerOff] = 900
    }
    public func open(reconnect: Bool) async throws { isOpen = true; openCount += 1 }
    public func close() { isOpen = false; closeCount += 1 }
    private func updatePeer(_ index: Int, connected: Bool) {
        let peer = peers[index]
        peers[index] = Peer(index: index, priority: peer.priority, connected: connected, name: peer.name)
    }
    public func exchange(_ frame: GaiaFrame) async throws -> GaiaFrame {
        guard isOpen else { throw HeadsetError.unavailable("Fixture connection is closed.") }
        active += 1; maximumConcurrentRequests = max(maximumConcurrentRequests, active)
        defer { active -= 1 }
        guard active == 1 else { throw HeadsetError.busy }
        if exchangeDelay > 0 { try await Task.sleep(nanoseconds: exchangeDelay) }
        frames.append(frame)
        func reply(_ bytes: [UInt8] = []) -> GaiaFrame { GaiaFrame(vendor: frame.vendor, command: frame.command | 0x100, payload: bytes) }
        func rejection() -> GaiaFrame { GaiaFrame(vendor: frame.vendor, command: frame.command | 0x180) }
        if let control = Control.allCases.first(where: { $0.readCommand == frame.command && $0.vendor == frame.vendor }) {
            if unsupportedControls.contains(control) { return rejection() }
            if malformedControl == control { return reply([255]) }
            if control == .adaptive || control == .antiWind {
                return reply([1, UInt8(values[.antiWind]!), 2, 0, 3, UInt8(values[.adaptive]!)])
            }
            if control == .soundMode { return reply([0, UInt8(values[control]!)]) }
            if control == .autoPowerOff { return reply(try control.writePayload(values[control]!)) }
            return reply([UInt8(values[control]!)])
        }
        if let control = Control.allCases.first(where: { $0.writeCommand == frame.command && $0.vendor == frame.vendor }) {
            let actual = control == .adaptive && frame.payload.first == 1 ? Control.antiWind : control
            if actual == .autoPowerOff { values[actual] = Int(frame.payload[1]) << 8 | Int(frame.payload[2]) }
            else { values[actual] = Int(frame.payload.last!) }
            if actual == .multipoint {
                if values[actual] == 0 { for peer in peers where peer.index != 0 { updatePeer(peer.index, connected: false) } }
                if uncertainMultipointAck { uncertainMultipointAck = false; isOpen = false; throw HeadsetError.unavailable("Simulated reset.") }
            }
            if actual == .audioPriority { for peer in peers where peer.index != 0 { updatePeer(peer.index, connected: false) } }
            return reply()
        }
        switch frame.command {
        case 0x0603: return reply([82])
        case 0x1201: return reply([0, 3, 0, 38, 0, 3])
        case 0x0800: return reply([255])
        case 0x0402: return reply([2])
        case 0x0807, 0x2001: return reply([0])
        case 0x0808: return reply([0])
        case 0x2802: return reply(Array(headsetName.utf8))
        case 0x2801: headsetName = String(bytes: frame.payload, encoding: .utf8)!; return reply()
        case 0x1400: return reply([0, UInt8(peers.count)])
        case 0x1407: return reply([0])
        case 0x1409: return reply([values[.multipoint] == 1 ? 2 : 1])
        case 0x1401:
            let peer = peers[Int(frame.payload[0])]
            return reply([UInt8(peer.index), UInt8(peer.priority), peer.connected ? 1 : 0] + Array(peer.name.utf8) + [0])
        case 0x1402, 0x1403:
            let index = Int(frame.payload[0])
            if frame.command == 0x1402 && failConnectIndex == index { return rejection() }
            let connected = frame.command == 0x1402
            if delayedPeerPolls > 0 { pending[index] = (connected, delayedPeerPolls) }
            else { updatePeer(index, connected: connected) }
            return reply()
        case 0x1404:
            let index = Int(frame.payload[0])
            if let (target, remaining) = pending[index] {
                if remaining <= 0 { updatePeer(index, connected: target); pending[index] = nil }
                else { pending[index] = (target, remaining - 1) }
            }
            return reply([UInt8(index), peers[index].connected ? 1 : 0])
        case 0x1000: return reply([UInt8(gains.count), UInt8(bitPattern: -60), 60, 0, 0])
        case 0x1002: return reply([UInt8(bitPattern: Int8(gains[Int(frame.payload[0])]))])
        case 0x1001:
            let band = Int(frame.payload[0])
            if failEQBand == band { failEQBand = nil; return rejection() }
            gains[band] = Int(Int8(bitPattern: frame.payload[1])); return reply()
        default: throw HeadsetError.invalid("Unexpected fixture command.")
        }
    }
}
