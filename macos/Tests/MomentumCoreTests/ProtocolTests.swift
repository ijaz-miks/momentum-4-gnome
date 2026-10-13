import Foundation
import MomentumCore

final class ProtocolTests {
    func testCapturedMultipointFramesAndFragmentation() throws {
        let request = GaiaFrame(vendor: 0x001d, command: 0x0e00, payload: [1])
        try expectEqual(try request.encoded(), Data([0xff, 3, 0, 1, 0, 0x1d, 0x0e, 0, 1]))
        var decoder = GaiaDecoder()
        try expectEqual(try decoder.feed(Data([0xff, 3, 0, 1])), [])
        try expectEqual(try decoder.feed(Data([0, 0x1d, 0x0f, 0x10, 1])),
            [GaiaFrame(vendor: 0x001d, command: 0x0f10, payload: [1])])
    }
    func testChecksumsAndCoalescedFrames() throws {
        let frame = GaiaFrame(command: 0x1504, payload: [2, 1])
        var decoder = GaiaDecoder()
        let encoded = try frame.encoded(checksum: true)
        try expectEqual(try decoder.feed(encoded + encoded), [frame, frame])
        var broken = encoded; broken[8] ^= 1
        try expectThrows(try decoder.feed(broken))
        try expectThrows(try GaiaFrame(command: 0, payload: Array(repeating: 0, count: 256)).encoded())
        var invalid = GaiaDecoder()
        try expectThrows(try invalid.feed(Data([0xff, 2, 0, 0, 0, 0, 0, 0])))
    }
    func testNoiseTagsTimerAndInputLimits() throws {
        try expectEqual(try Control.adaptive.decode([1, 2, 2, 0, 3, 1]), 1)
        try expectEqual(try Control.antiWind.decode([1, 2, 2, 0, 3, 1]), 2)
        try expectThrows(try Control.antiWind.decode([1, 2, 1, 0, 3, 1]))
        try expectThrows(try Control.adaptive.decode([1, 0, 2, 0, 3, 2]))
        try expectEqual(try Control.autoPowerOff.decode([0, 3, 0x84]), 900)
        try expectEqual(try Control.autoPowerOff.writePayload(900), [0, 3, 0x84])
        try expectThrows(try Control.transparency.writePayload(101))
        try expectThrows(try Control.multipoint.writePayload(2))
        try expectThrows(try Control.soundMode.decode([1, 2]))
        try expectEqual(Control.multipoint.vendor, 0x001d)
    }
    func testIdentityAndProtectedHost() throws {
        let payload: [UInt8] = [1, 0, 1] + Array("Test phone".utf8) + [0]
        let peer = try Peer.decode(payload, index: 1)
        try expectEqual(peer.name, "Test phone")
        try expectThrows(try Peer.decode(payload, index: 2))
        try expectThrows(try Peer.decode(Array(payload.dropLast()), index: 1))
        let connections = try Connections(capacity: 2, ownIndex: 0, peers: [
            Peer(index: 0, priority: 0, connected: true, name: "This Mac"), peer])
        try expectThrows(try connections.checkedPeer(index: 0, name: "This Mac"))
        try expectThrows(try connections.checkedPeer(index: 1, name: "Another phone"))
        try expectEqual(try connections.checkedPeer(index: 1, name: "Test phone"), peer)
        try expectThrows(try Connections(capacity: 1, ownIndex: 0, peers: connections.peers))
    }
    func testEqualizerAndUTF8Names() throws {
        try expectThrows(try Equalizer(minimum: -60, maximum: 60, gains: [61]))
        try expectThrows(try Equalizer(minimum: 0, maximum: 0, gains: [0]))
        try expectTrue(validName("My headphones"))
        try expectFalse(validName("Bad\nname"))
        try expectFalse(validName(String(repeating: "é", count: 17)))
    }
}

struct CheckFailure: Error, CustomStringConvertible {
    let description: String
}
func expectEqual<T: Equatable>(_ actual: T, _ expected: T, line: UInt = #line) throws {
    guard actual == expected else { throw CheckFailure(description: "Values differ at line \(line)") }
}
func expectTrue(_ value: Bool, line: UInt = #line) throws {
    guard value else { throw CheckFailure(description: "Expected true at line \(line)") }
}
func expectFalse(_ value: Bool, line: UInt = #line) throws { try expectTrue(!value, line: line) }
func expectThrows<T>(_ expression: @autoclosure () throws -> T, line: UInt = #line) throws {
    do { _ = try expression() } catch { return }
    throw CheckFailure(description: "Expected an error at line \(line)")
}

@main struct CoreChecks {
    @MainActor static func main() async throws {
        let checks = ProtocolTests()
        try checks.testCapturedMultipointFramesAndFragmentation()
        try checks.testChecksumsAndCoalescedFrames()
        try checks.testNoiseTagsTimerAndInputLimits()
        try checks.testIdentityAndProtectedHost()
        try checks.testEqualizerAndUTF8Names()
        try await runClientChecks()
        print("PASS 5 protocol checks: framing, checksum, command limits, peer identity and EQ/name validation")
    }
}
