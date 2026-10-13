import AppKit
import Foundation
import MomentumCore

/// Explicit hardware testing only. Never selected by normal startup or demo mode.
@MainActor func runHardwareChecks(_ delegate: MenuDelegate, output: URL) async {
    let store = delegate.store
    var checks: [String] = []
    var failures: [String] = []
    var limitations: [String] = []
    var rejections: [[String: Any]] = []
    var original: HeadsetSnapshot?
    var restoreFailures: [String] = []
    func report(_ finished: Bool) {
        let value: [String: Any] = ["finished": finished, "passed": finished && failures.isEmpty && restoreFailures.isEmpty,
            "checks": checks, "failures": failures, "limitations": limitations,
            "rejections": rejections, "restoreFailures": restoreFailures]
        try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: output)
    }
    func restore(_ snapshot: HeadsetSnapshot) async {
        do { try await store.transport.open(reconnect: true) }
        catch { restoreFailures.append("Control connection: \(error.localizedDescription)"); return }
        for control in Control.allCases where control != .autoPowerOff {
            guard let value = snapshot.values[control] else { continue }
            do { try await store.client.set(control, to: value) }
            catch { restoreFailures.append("\(control.title): \(error.localizedDescription)") }
        }
        if let eq = snapshot.equalizer {
            do {
                try await store.client.applyEqualizer(eq.gains)
                if let mode = snapshot.values[.soundMode] { try await store.client.set(.soundMode, to: mode) }
            } catch { restoreFailures.append("Equalizer: \(error.localizedDescription)") }
        }
        do { try await store.client.rename(snapshot.name) }
        catch { restoreFailures.append("Headset name: \(error.localizedDescription)") }
        // Restore source membership using fresh identities, never a cached slot number.
        do {
            let desired = Set(snapshot.connections.peers.filter(\.connected).map(\.name))
            var state = try await store.client.connections()
            for peer in state.peers where peer.connected && peer.index != state.ownIndex && !desired.contains(peer.name) {
                try await store.client.switchPeer(index: peer.index, name: peer.name, connected: false)
            }
            state = try await store.client.connections()
            for name in desired {
                if let peer = state.peers.first(where: { $0.name == name }), !peer.connected {
                    try await store.client.switchPeer(index: peer.index, name: peer.name)
                    state = try await store.client.connections()
                }
            }
            guard Set(state.peers.filter(\.connected).map(\.name)) == desired else {
                throw HeadsetError.verification("Original source connections were not restored.")
            }
        } catch { restoreFailures.append("Sources: \(error.localizedDescription)") }
        if let timer = snapshot.values[.autoPowerOff] {
            do { try await store.client.set(.autoPowerOff, to: timer) }
            catch { restoreFailures.append("Power timer: \(error.localizedDescription)") }
        }
        do {
            let confirmed = try await store.client.snapshot(reconnect: true)
            guard confirmed.values == snapshot.values, confirmed.equalizer?.gains == snapshot.equalizer?.gains,
                  confirmed.name == snapshot.name else {
                throw HeadsetError.verification("The final snapshot differs from the original headset settings.")
            }
        } catch { restoreFailures.append("Final readback: \(error.localizedDescription)") }
    }
    func testSetting(_ control: Control, target: Int, original value: Int, snapshot: HeadsetSnapshot) async throws {
        do {
            try await store.client.set(control, to: target)
            try await store.client.set(control, to: value)
            checks.append("\(control.title)\(control == .soundMode ? " \(target)" : ""): changed, read back and restored")
        } catch HeadsetError.rejected(let vendor, let command, let bytes) {
            let error = HeadsetError.rejected(vendor: vendor, command: command, payload: bytes)
            let title = "\(control.title)\(control == .soundMode ? " \(target)" : "")"
            rejections.append(["control": title, "vendor": Int(vendor), "command": Int(command), "payload": bytes.map(Int.init)])
            if control == .soundMode && vendor == control.vendor && command == control.writeCommand,
               bytes.first == 0x81 || bytes.first == 0x82 {
                limitations.append("\(title): \(error.localizedDescription)")
                store.recordSoundModeRejection(target, error: error, snapshot: snapshot)
            } else { failures.append("\(title): \(error.localizedDescription)") }
            // Continue only after the original value is confirmed again.
            try await store.client.set(control, to: value)
        }
        report(false)
    }
    do {
        let deadline = Date().addingTimeInterval(70)
        while store.busy {
            guard Date() < deadline else { throw HeadsetError.timeout }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        store.stop()
        let snapshot = try await store.client.snapshot(reconnect: true)
        original = snapshot
        checks.append("Physical snapshot: \(snapshot.values.count) settings, \(snapshot.equalizer?.gains.count ?? 0) EQ bands")
        report(false)
        if let timer = snapshot.values[.autoPowerOff] {
            try await testSetting(.autoPowerOff, target: timer == 0 ? 3600 : 0, original: timer, snapshot: snapshot)
            try await store.client.set(.autoPowerOff, to: 0)
        }
        if let multipoint = snapshot.values[.multipoint] {
            try await store.client.set(.multipoint, to: 1 - multipoint)
            try await store.client.set(.multipoint, to: multipoint)
            checks.append("Multipoint: toggle both ways with verified connection capacity")
        }
        report(false)
        if snapshot.connections.capacity == 2,
           let previous = snapshot.connections.peers.first(where: { $0.connected && $0.index != snapshot.connections.ownIndex }) {
            var state = try await store.client.connections()
            guard let target = state.peers.first(where: { $0.name == previous.name }) else {
                throw HeadsetError.verification("The original source is no longer paired.")
            }
            if !target.connected { try await store.client.switchPeer(index: target.index, name: target.name) }
            state = try await store.client.connections()
            guard let connected = state.peers.first(where: { $0.name == previous.name && $0.connected }) else {
                throw HeadsetError.verification("The original source could not be connected for switching.")
            }
            try await store.client.switchPeer(index: connected.index, name: connected.name, connected: false)
            state = try await store.client.connections()
            guard let disconnected = state.peers.first(where: { $0.name == previous.name && !$0.connected }) else {
                throw HeadsetError.verification("The source disconnect was not confirmed.")
            }
            try await store.client.switchPeer(index: disconnected.index, name: disconnected.name)
            checks.append("Source switching: disconnect/reconnect confirmed while protecting this Mac")
        } else { limitations.append("Source switching: no other source was connected at the initial snapshot") }
        report(false)
        for control in Control.allCases where control != .multipoint && control != .audioPriority && control != .autoPowerOff {
            guard let value = snapshot.values[control] else { continue }
            if control == .soundMode {
                for target in [0, 1, 2] where target != value {
                    try await testSetting(control, target: target, original: value, snapshot: snapshot)
                }
                continue
            }
            let next: Int
            if control == .transparency { next = value == 50 ? 49 : 50 }
            else { next = value == control.range.lowerBound ? control.range.lowerBound + 1 : control.range.lowerBound }
            try await testSetting(control, target: next, original: value, snapshot: snapshot)
        }
        if let eq = snapshot.equalizer {
            var gains = eq.gains
            gains[0] += gains[0] > eq.minimum ? -1 : 1
            try await store.client.applyEqualizer(gains)
            try await store.client.applyEqualizer(eq.gains)
            if let mode = snapshot.values[.soundMode] { try await store.client.set(.soundMode, to: mode) }
            checks.append("Equalizer: band changed and original gains/mode restored")
        }
        report(false)
        try await store.client.rename("Momentum 4 test")
        try await store.client.rename(snapshot.name)
        checks.append("Headset rename: confirmed and restored")
        report(false)
        if let priority = snapshot.values[.audioPriority] {
            try await store.client.set(.audioPriority, to: 1 - priority)
            try await store.client.set(.audioPriority, to: priority)
            checks.append("Audio priority: reconnect, readback and source restoration")
        }
        report(false)
    } catch { failures.append(error.localizedDescription) }
    if let original { await restore(original) }
    store.transport.close()
    report(true)
    NSApp.terminate(nil)
}
