import Foundation
import MomentumCore
import MomentumFixtures

@MainActor func runClientChecks() async throws {
    let simulated = SimulatedTransport(), client = HeadsetClient(transport: SimulatedTransport())
    let snapshot = try await client.snapshot()
    try expectEqual(snapshot.battery, 82)
    try expectEqual(snapshot.values.count, Control.allCases.count)
    try expectEqual(snapshot.firmware, "3.38.3")
    try expectEqual(snapshot.equalizer?.gains, [0, 0, 0, 0, 0])
    let service = HeadsetClient(transport: simulated)
    try await simulated.open(reconnect: false)
    for control in Control.allCases where control != .soundMode && control != .multipoint && control != .audioPriority {
        let initial = simulated.values[control]!
        let target = initial == 0 ? 1 : 0
        try await service.set(control, to: target)
        try expectEqual(simulated.values[control], target)
    }
    try await service.rename("Test headset")
    try expectEqual(simulated.headsetName, "Test headset")
    let count = simulated.frames.count
    do { try await service.rename("Invalid\nname"); throw CheckFailure(description: "Invalid name was accepted") }
    catch HeadsetError.invalid {}
    try expectEqual(simulated.frames.count, count)
    print("PASS complete snapshot, supported control writes, verified rename and input rejection")

    let switching = SimulatedTransport()
    let sourceClient = HeadsetClient(transport: switching)
    try await switching.open(reconnect: false)
    switching.delayedPeerPolls = 2
    try await sourceClient.switchPeer(index: 2, name: "Windows PC")
    try expectTrue(switching.peers[0].connected)
    try expectFalse(switching.peers[1].connected)
    try expectTrue(switching.peers[2].connected)
    do { try await sourceClient.switchPeer(index: 0, name: "This Mac", connected: false); throw CheckFailure(description: "Own host was not protected") }
    catch HeadsetError.invalid {}
    try expectFalse(switching.frames.contains(where: { $0.command == 0x1403 && $0.payload == [0] }))
    print("PASS delayed switching confirmed without disconnecting this Mac")

    let failed = SimulatedTransport()
    let restoring = HeadsetClient(transport: failed)
    try await failed.open(reconnect: false)
    failed.failConnectIndex = 2
    do { try await restoring.switchPeer(index: 2, name: "Windows PC"); throw CheckFailure(description: "Rejected target was accepted") }
    catch HeadsetError.verification(let reason) { try expectTrue(reason.contains("restored")) }
    try expectTrue(failed.peers[0].connected && failed.peers[1].connected)
    try expectFalse(failed.peers[2].connected)
    print("PASS rejected source restores the previous connection")

    let equalizing = SimulatedTransport()
    let eq = HeadsetClient(transport: equalizing)
    try await equalizing.open(reconnect: false)
    equalizing.values[.soundMode] = 2; equalizing.failEQBand = 2
    do { try await eq.applyEqualizer([10, 20, 30, 40, 50]); throw CheckFailure(description: "Rejected EQ profile was accepted") }
    catch HeadsetError.verification {}
    try expectEqual(equalizing.gains, [0, 0, 0, 0, 0])
    try expectEqual(equalizing.values[.soundMode], 2)
    try await eq.setBand(0, gain: -15)
    try expectEqual(equalizing.gains[0], -15)
    print("PASS partial EQ failure restores gains and sound mode; negative band gains work")

    let resetting = SimulatedTransport()
    let resetClient = HeadsetClient(transport: resetting)
    try await resetting.open(reconnect: false)
    resetting.uncertainMultipointAck = true
    try await resetClient.set(.multipoint, to: 0)
    try expectEqual(resetting.frames.filter { $0.command == 0x0e00 }.count, 1)
    try expectEqual(resetting.values[.multipoint], 0)
    try expectEqual(try await resetClient.connections().capacity, 1)
    try await resetClient.set(.multipoint, to: 1)
    try await resetClient.switchPeer(index: 1, name: "Test phone")
    try await resetClient.set(.audioPriority, to: 1)
    try expectTrue(resetting.peers[0].connected && resetting.peers[1].connected)
    try expectFalse(resetting.frames.contains(where: { $0.command == 0x1403 && $0.payload == [0] }))
    print("PASS uncertain multipoint acknowledgement is not repeated; audio priority restores the other source")

    let optional = SimulatedTransport()
    optional.unsupportedControls = [.lowLatency]
    let optionalClient = HeadsetClient(transport: optional)
    let limited = try await optionalClient.snapshot()
    try expectEqual(limited.values[.lowLatency], nil)
    try expectTrue(limited.unsupported[.lowLatency] != nil)
    optional.malformedControl = .anc
    do { _ = try await optionalClient.snapshot(); throw CheckFailure(description: "Malformed snapshot was accepted") }
    catch HeadsetError.invalid {}
    print("PASS unsupported controls are unavailable and malformed values fail the snapshot")

    let modes = SimulatedTransport()
    let modeService = HeadsetClient(transport: modes)
    try await modes.open(reconnect: false)
    modes.rejectedSoundModes[2] = [0x81, 0x44]
    do { try await modeService.set(.soundMode, to: 2); throw CheckFailure(description: "Unconfigured sound mode was accepted") }
    catch HeadsetError.rejected(let vendor, let command, let bytes) {
        try expectEqual(vendor, GaiaFrame.sennheiser); try expectEqual(command, 0x0803)
        try expectEqual(bytes, [0x81, 0x44])
        try expectTrue(HeadsetError.rejected(vendor: vendor, command: command, payload: bytes).localizedDescription.contains("not been configured"))
    }
    modes.rejectedSoundModes[2] = [0x82]
    do { try await modeService.set(.soundMode, to: 2); throw CheckFailure(description: "Unsupported sound mode was accepted") }
    catch HeadsetError.rejected(_, _, let bytes) { try expectEqual(bytes, [0x82]) }
    modes.rejectedSoundModes[2] = [0x80]
    do { try await modeService.set(.soundMode, to: 2); throw CheckFailure(description: "Unverified already-selected mode was accepted") }
    catch HeadsetError.verification {}
    modes.selectSoundModeBeforeRejection = true
    try await modeService.set(.soundMode, to: 2)
    try expectEqual(modes.values[.soundMode], 2)
    try expectEqual(modes.frames.last(where: { $0.command == 0x0803 })?.payload, [0, 2])
    print("PASS sound-mode rejection payloads distinguish unavailable/configuration errors and verify already-selected races")
}
