import Foundation
import Combine
import MomentumCore
import MomentumBluetooth
import MomentumFixtures

enum ControlPage: String, CaseIterable, Identifiable {
    case devices = "Devices", noise = "Noise", sound = "Sound", more = "More"
    var id: String { rawValue }
}

struct SavedPreset: Codable, Identifiable, Equatable {
    var id: String { name }
    let name: String
    let gains: [Int]
}

@MainActor final class HeadsetStore: ObservableObject {
    enum Job {
        case refresh(Bool), setting(Control, Int), band(Int, Int), profile([Int]), peer(Peer, Bool), rename(String)
        var key: String {
            switch self {
            case .refresh: return "refresh"
            case .setting(let control, _): return control.rawValue
            case .band(let band, _): return "eq\(band)"
            case .profile: return "profile"
            case .peer: return "peer"
            case .rename: return "name"
            }
        }
    }
    let transport: GaiaTransport
    let client: HeadsetClient
    let isDemo: Bool
    let defaults: UserDefaults?
    @Published private(set) var snapshot: HeadsetSnapshot?
    @Published private(set) var stale = false
    @Published private(set) var busy = false
    @Published private(set) var readError: String?
    @Published private(set) var writeError: String?
    @Published private(set) var previews: [String: Int] = [:]
    @Published private(set) var presets: [SavedPreset] = []
    @Published private(set) var removedPreset: SavedPreset?
    @Published var page: ControlPage = .devices
    @Published var selectedPreset = ""
    @Published var presetName = ""
    @Published var headsetName = ""
    @Published var addressDraft = ""
    @Published var showBattery: Bool { didSet { defaults?.set(showBattery, forKey: "showBattery") } }
    var menuVisible = false
    private var jobs: [Job] = []
    private var worker: Task<Void, Never>?
    private var poller: Task<Void, Never>?
    private var debounce: [String: Task<Void, Never>] = [:]
    private var editing: Set<String> = []
    private var epoch = 0
    private var running = false
    var onStatusChanged: (() -> Void)?

    init(transport: GaiaTransport? = nil, demo: Bool = false, defaults: UserDefaults? = .standard) {
        self.isDemo = demo
        self.defaults = demo ? nil : defaults
        let selected: GaiaTransport = transport ?? (demo ? SimulatedTransport() : RFCOMMTransport())
        self.transport = selected; self.client = HeadsetClient(transport: selected)
        self.showBattery = demo ? true : (defaults?.object(forKey: "showBattery") as? Bool ?? true)
        self.addressDraft = demo ? "" : (defaults?.string(forKey: "headsetAddress") ?? "")
        (selected as? RFCOMMTransport)?.selectedAddress = addressDraft
        if !demo, let data = defaults?.data(forKey: "equalizerPresets") {
            do {
                let decoded = try JSONDecoder().decode([SavedPreset].self, from: data)
                guard decoded.count <= 32, Set(decoded.map(\.name)).count == decoded.count,
                    decoded.allSatisfy({ validName($0.name, maximum: 64) && (1...16).contains($0.gains.count) && $0.gains.allSatisfy({ (-128...127).contains($0) }) })
                else { throw HeadsetError.invalid("Saved EQ presets are invalid.") }
                presets = decoded
            } catch { writeError = "Saved presets could not be loaded. \(error.localizedDescription)" }
        }
    }
    var ready: Bool { running && snapshot != nil && !stale && !busy }
    var error: String? { writeError ?? readError }
    var hasPreviews: Bool { !previews.isEmpty }
    var status: String {
        if isDemo { return "Demo, no Bluetooth changes" }
        if busy { return "Updating headset" }
        if ready { return "Connected" }
        return snapshot == nil ? "Connect your headset" : "Values need refreshing"
    }
    func start() {
        guard !running else { return }
        running = true; refresh()
        poller = Task { [weak self] in
            while let self, !Task.isCancelled {
                let seconds: UInt64 = self.menuVisible ? 30 : 120
                do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return }
                if self.menuVisible || self.showBattery { self.refresh() }
            }
        }
    }
    func stop() {
        running = false; epoch += 1
        poller?.cancel(); poller = nil; worker?.cancel(); worker = nil
        jobs.removeAll(); debounce.values.forEach { $0.cancel() }; debounce.removeAll()
        previews.removeAll(); editing.removeAll(); transport.close(); busy = false; stale = snapshot != nil
    }
    func refresh(reconnect: Bool = false) { enqueue(.refresh(reconnect)) }
    func set(_ control: Control, to value: Int) {
        guard ready, control.range.contains(value), snapshot?.values[control] != nil else { return }
        enqueue(.setting(control, value))
    }
    func shown(_ control: Control) -> Int? { previews[control.rawValue] ?? snapshot?.values[control] }
    func shownBand(_ band: Int) -> Int { previews["eq\(band)"] ?? snapshot?.equalizer?.gains[band] ?? 0 }
    func preview(_ control: Control, value: Int) {
        guard ready, control.range.contains(value) else { return }
        previews[control.rawValue] = value
        schedule(control.rawValue)
    }
    func previewBand(_ band: Int, gain: Int) {
        guard ready, let eq = snapshot?.equalizer, eq.gains.indices.contains(band), (eq.minimum...eq.maximum).contains(gain) else { return }
        previews["eq\(band)"] = gain
        schedule("eq\(band)")
    }
    func setEditing(_ key: String, active: Bool) {
        if active { editing.insert(key); debounce[key]?.cancel(); debounce[key] = nil }
        else { editing.remove(key); flush(key) }
    }
    private func schedule(_ key: String) {
        debounce[key]?.cancel()
        guard !editing.contains(key) else { return }
        debounce[key] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 350_000_000) } catch { return }
            self?.flush(key)
        }
    }
    private func flush(_ key: String) {
        debounce[key]?.cancel(); debounce[key] = nil
        guard let value = previews.removeValue(forKey: key) else { return }
        if let control = Control(rawValue: key) { enqueue(.setting(control, value)) }
        else if key.hasPrefix("eq"), let band = Int(key.dropFirst(2)) { enqueue(.band(band, value)) }
    }
    func flushPreviews() { editing.removeAll(); Array(previews.keys).forEach(flush) }
    func switchPeer(_ peer: Peer) { guard ready else { return }; enqueue(.peer(peer, !peer.connected)) }
    func applyPreset() {
        guard ready, let preset = presets.first(where: { $0.name == selectedPreset }) else { return }
        enqueue(.profile(preset.gains))
    }
    func flatEqualizer() { guard ready, let eq = snapshot?.equalizer else { return }; enqueue(.profile(Array(repeating: 0, count: eq.gains.count))) }
    func rename() { guard ready else { return }; enqueue(.rename(headsetName.trimmingCharacters(in: .whitespaces))) }
    func dismissError() { readError = nil; writeError = nil }
    func selectAddress() {
        guard !busy else { return }
        guard RFCOMMTransport.isValidAddress(addressDraft) else { readError = "Enter a valid Bluetooth address or leave it empty."; return }
        stop(); snapshot = nil; stale = false
        addressDraft = RFCOMMTransport.normalize(addressDraft)
        defaults?.set(addressDraft, forKey: "headsetAddress")
        (transport as? RFCOMMTransport)?.selectedAddress = addressDraft
        start()
    }
    func savePreset() {
        guard ready, !hasPreviews, let eq = snapshot?.equalizer else { return }
        let name = presetName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard validName(name, maximum: 64), presets.count < 32, !presets.contains(where: { $0.name == name }) else {
            writeError = "Use a unique preset name of at most 64 UTF-8 bytes. Up to 32 presets can be saved."; return
        }
        presets.append(SavedPreset(name: name, gains: eq.gains)); selectedPreset = name; presetName = ""
        persistPresets()
    }
    func removePreset() {
        guard let index = presets.firstIndex(where: { $0.name == selectedPreset }) else { return }
        removedPreset = presets.remove(at: index); selectedPreset = ""; persistPresets()
    }
    func undoPresetRemoval() {
        guard let removedPreset, presets.count < 32, !presets.contains(where: { $0.name == removedPreset.name }) else { return }
        presets.append(removedPreset); selectedPreset = removedPreset.name; self.removedPreset = nil; persistPresets()
    }
    private func persistPresets() {
        do { defaults?.set(try JSONEncoder().encode(presets), forKey: "equalizerPresets") }
        catch { writeError = "Could not save presets: \(error.localizedDescription)" }
    }
    private func enqueue(_ job: Job) {
        if case .refresh = job, busy || jobs.contains(where: { $0.key == "refresh" }) { return }
        jobs.removeAll(where: { $0.key == job.key }); jobs.append(job)
        guard worker == nil else { return }
        let generation = epoch
        worker = Task { [weak self] in
            guard let self else { return }
            while !self.jobs.isEmpty && !Task.isCancelled && self.epoch == generation {
                let job = self.jobs.removeFirst()
                self.busy = true; self.onStatusChanged?()
                do {
                    let snapshot = try await self.perform(job)
                    guard self.epoch == generation else { return }
                    if self.headsetName.isEmpty || self.headsetName == self.snapshot?.name { self.headsetName = snapshot.name }
                    self.snapshot = snapshot; self.stale = false; self.readError = nil
                    if job.key != "refresh" { self.writeError = nil }
                } catch {
                    guard self.epoch == generation else { return }
                    if job.key == "refresh" { self.readError = error.localizedDescription; self.stale = self.snapshot != nil }
                    else {
                        self.writeError = error.localizedDescription
                        do { self.snapshot = try await self.client.snapshot(); self.stale = false }
                        catch { self.stale = self.snapshot != nil; self.readError = error.localizedDescription; self.jobs.removeAll() }
                    }
                }
                self.transport.close(); self.busy = false; self.onStatusChanged?()
            }
            guard self.epoch == generation else { return }
            self.worker = nil
        }
    }
    private func perform(_ job: Job) async throws -> HeadsetSnapshot {
        if case .refresh(let reconnect) = job { return try await client.snapshot(reconnect: reconnect) }
        try await transport.open(reconnect: false)
        switch job {
        case .setting(let control, let value): try await client.set(control, to: value)
        case .band(let band, let gain): try await client.setBand(band, gain: gain)
        case .profile(let gains): try await client.applyEqualizer(gains)
        case .peer(let peer, let connected): try await client.switchPeer(index: peer.index, name: peer.name, connected: connected)
        case .rename(let name): try await client.rename(name)
        case .refresh: break
        }
        return try await client.snapshot()
    }
}
