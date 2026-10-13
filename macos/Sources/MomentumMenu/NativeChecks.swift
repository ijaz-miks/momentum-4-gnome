import AppKit
import SwiftUI
import Foundation
import MomentumBluetooth
import MomentumCore
import MomentumFixtures

struct NativeCheckFailure: Error, CustomStringConvertible {
    let description: String
}
@MainActor func nativeAssert(_ condition: Bool, _ message: String) throws {
    guard condition else { throw NativeCheckFailure(description: message) }
}
@MainActor func waitForIdle(_ store: HeadsetStore) async throws {
    let deadline = Date().addingTimeInterval(20)
    repeat {
        try await Task.sleep(nanoseconds: 30_000_000)
        if !store.busy && store.ready { return }
    } while Date() < deadline
    throw NativeCheckFailure(description: "Controller did not become ready")
}
@MainActor func captureView(_ view: NSView, at url: URL) throws {
    view.layoutSubtreeIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        throw NativeCheckFailure(description: "Native view could not be captured")
    }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    // A view cache does not include the composited popover backdrop. Flatten
    // against its native appearance so transparent text/cards remain reviewable.
    let foreground = NSImage(size: view.bounds.size)
    foreground.addRepresentation(bitmap)
    let image = NSImage(size: view.bounds.size)
    let appearance = view.window?.effectiveAppearance ?? view.effectiveAppearance
    var encoded: Data?
    appearance.performAsCurrentDrawingAppearance {
        image.lockFocus()
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(rect: CGRect(origin: .zero, size: view.bounds.size)).fill()
        foreground.draw(in: CGRect(origin: .zero, size: view.bounds.size), from: .zero, operation: .sourceOver, fraction: 1)
        image.unlockFocus()
        if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
            encoded = rep.representation(using: .png, properties: [:])
        }
    }
    guard let encoded else { throw NativeCheckFailure(description: "Could not encode the native view") }
    try encoded.write(to: url)
}
@MainActor func runNativeChecks(_ delegate: MenuDelegate, output: URL) async {
    var checks: [String] = []
    do {
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: false)
        let store = delegate.store
        guard store.isDemo, let simulation = store.transport as? SimulatedTransport else {
            throw NativeCheckFailure(description: "Refusing to test without the explicit simulated headset")
        }
        try await waitForIdle(store)
        try nativeAssert(NSApp.activationPolicy() == .accessory, "App should stay out of the Dock")
        try nativeAssert(delegate.statusButton != nil, "Native status item is missing")
        delegate.popover.animates = false
        try await Task.sleep(nanoseconds: 500_000_000)
        delegate.statusButton?.performClick(nil)
        try await Task.sleep(nanoseconds: 500_000_000)
        try nativeAssert(delegate.popover.isShown, "Status button did not open its popover")
        checks.append("Native menu bar item opens the control popover; no Dock icon")
        try await waitForIdle(store)
        try nativeAssert(delegate.statusButton?.title.contains("82%") == true, "Battery text is missing")

        for control in [Control.anc, .adaptive, .bassBoost, .touchLock, .lowLatency] {
            store.set(control, to: simulation.values[control] == 1 ? 0 : 1)
        }
        try await waitForIdle(store)
        try nativeAssert(simulation.maximumConcurrentRequests == 1, "Headset requests overlapped")
        checks.append("Queued settings are serialized and confirmed from fresh snapshots")

        let beforeDrag = simulation.frames.filter { $0.command == 0x1a02 }.count
        store.setEditing("transparency", active: true)
        store.preview(.transparency, value: 45); store.preview(.transparency, value: 63)
        try await Task.sleep(nanoseconds: 500_000_000)
        try nativeAssert(simulation.frames.filter { $0.command == 0x1a02 }.count == beforeDrag, "Slider wrote during drag")
        store.setEditing("transparency", active: false)
        try await waitForIdle(store)
        try nativeAssert(simulation.values[.transparency] == 63, "Slider final value was not committed")
        checks.append("Slider drag uses a local preview and commits the final value once")

        store.switchPeer(store.snapshot!.connections.peers[2]); try await waitForIdle(store)
        try nativeAssert(simulation.peers[0].connected && simulation.peers[2].connected && !simulation.peers[1].connected,
            "Source switch did not preserve this Mac")
        simulation.uncertainMultipointAck = true
        store.set(.multipoint, to: 0); try await waitForIdle(store)
        try nativeAssert(store.snapshot?.connections.capacity == 1, "Multipoint recovery did not confirm capacity")
        store.set(.multipoint, to: 1); try await waitForIdle(store)
        checks.append("Source switching protects this Mac; multipoint recovers after a lost acknowledgement")

        store.previewBand(0, gain: -15); store.flushPreviews(); try await waitForIdle(store)
        store.presetName = "Focus"; store.savePreset()
        try nativeAssert(store.presets.first?.gains.first == -15, "Preset did not save confirmed gains")
        store.flatEqualizer(); try await waitForIdle(store)
        store.selectedPreset = "Focus"; store.applyPreset(); try await waitForIdle(store)
        try nativeAssert(simulation.gains[0] == -15, "Saved preset was not applied")
        store.removePreset(); try nativeAssert(store.presets.isEmpty, "Preset removal failed")
        store.undoPresetRemoval(); try nativeAssert(store.presets.count == 1, "Preset removal undo failed")
        checks.append("EQ bands, flat reset and explicit preset save/apply/remove/undo")

        store.headsetName = "Test headphones"; store.rename(); try await waitForIdle(store)
        try nativeAssert(store.snapshot?.name == "Test headphones", "Name readback was not confirmed")
        simulation.unsupportedControls.insert(.lowLatency)
        store.refresh(); try await waitForIdle(store)
        try nativeAssert(store.snapshot?.values[.lowLatency] == nil, "Unsupported feature did not become unavailable")
        checks.append("Verified rename and unsupported feature handling")

        for scheme in [ColorScheme.light, .dark] {
            for page in ControlPage.allCases {
                store.page = page
                delegate.popover.contentViewController = NSHostingController(rootView: ControlPanel(store: store,
                    openSettings: { delegate.openPreferences() }, quit: {}))
                delegate.popover.contentViewController?.view.window?.appearance = NSAppearance(named: scheme == .dark ? .darkAqua : .aqua)
                try await Task.sleep(nanoseconds: 180_000_000)
                let view = delegate.popover.contentViewController!.view
                try nativeAssert(view.bounds.width >= 400 && view.bounds.height >= 630, "Popover layout is clipped")
                try captureView(view, at: output.appendingPathComponent("\(scheme)-\(page.rawValue.lowercased()).png"))
            }
        }
        checks.append("All four native control pages render in light and dark appearances")
        delegate.openPreferences()
        try await Task.sleep(nanoseconds: 200_000_000)
        guard let settings = NSApp.windows.first(where: { $0.title == "Momentum 4 Settings" }) else {
            throw NativeCheckFailure(description: "Native settings window did not open")
        }
        try captureView(settings.contentView!, at: output.appendingPathComponent("settings.png"))
        checks.append("Native settings window opens separately from the menu popover")

        func writeCount() -> Int {
            simulation.frames.filter { frame in
                Control.allCases.contains(where: { $0.writeCommand == frame.command && $0.vendor == frame.vendor }) ||
                    [UInt16(0x1001), 0x1402, 0x1403, 0x2801].contains(frame.command)
            }.count
        }
        simulation.malformedControl = .anc; store.refresh()
        try await Task.sleep(nanoseconds: 500_000_000)
        try nativeAssert(store.stale && !store.ready, "Malformed reads did not invalidate retained values")
        let writesAfterFailure = writeCount()
        store.set(.anc, to: 0)
        try await Task.sleep(nanoseconds: 100_000_000)
        try nativeAssert(writeCount() == writesAfterFailure, "A stale snapshot accepted a setter")
        simulation.malformedControl = nil; store.refresh(); try await waitForIdle(store)
        store.stop(); try nativeAssert(!store.ready, "Sleep/stop should disable headset writes")
        store.start(); try await waitForIdle(store)
        checks.append("Malformed snapshots disable controls; stop/wake reads state without replaying settings")
        let report: [String: Any] = ["passed": true, "checks": checks, "maximumConcurrentRequests": simulation.maximumConcurrentRequests]
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("result.json"))
    } catch {
        let report: [String: Any] = ["passed": false, "checks": checks, "error": String(describing: error), "applicationActive": NSApp.isActive,
            "buttonEnabled": delegate.statusButton?.isEnabled ?? false,
            "buttonWindowExists": delegate.statusButton?.window != nil,
            "popoverVisible": delegate.popover.isShown]
        try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: output.appendingPathComponent("result.json"))
    }
    NSApp.terminate(nil)
}


/// Opt-in physical diagnostic. It reports counts and battery, never device identities.
@MainActor func runHardwareRead(_ delegate: MenuDelegate, output: URL, connect: Bool) async {
    let store = delegate.store
    do {
        let deadline = Date().addingTimeInterval(70)
        while store.busy {
            guard Date() < deadline else { throw HeadsetError.timeout }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        if connect || store.snapshot == nil {
            store.refresh(reconnect: connect)
            try await Task.sleep(nanoseconds: 100_000_000)
            while store.busy {
                guard Date() < deadline else { throw HeadsetError.timeout }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        var result: [String: Any] = ["passed": store.ready, "error": store.error ?? ""]
        result["bluetoothAccess"] = (store.transport as? RFCOMMTransport)?.accessStatus
        result["connectionEvents"] = (store.transport as? RFCOMMTransport)?.diagnosticEvents
        if let snapshot = store.snapshot, store.ready {
            result["battery"] = snapshot.battery; result["firmware"] = snapshot.firmware
            result["supportedControls"] = snapshot.values.count
            result["pairedSources"] = snapshot.connections.peers.count
            result["activeSources"] = snapshot.connections.peers.filter(\.connected).count
            result["equalizerBands"] = snapshot.equalizer?.gains.count ?? 0
        }
        try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: output)
    } catch {
        try? JSONSerialization.data(withJSONObject: ["passed": false, "error": error.localizedDescription], options: [.prettyPrinted])
            .write(to: output)
    }
    NSApp.terminate(nil)
}
