import SwiftUI
import AppKit
import MomentumCore

struct ControlPanel: View {
    @ObservedObject var store: HeadsetStore
    let openSettings: () -> Void
    let quit: () -> Void
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        VStack(spacing: 0) {
            header.padding(18)
            Picker("Controls", selection: $store.page) {
                ForEach(ControlPage.allCases) { Text($0.rawValue).tag($0) }
            }.pickerStyle(.segmented).labelsHidden().padding(.horizontal, 16).padding(.bottom, 12)
                .accessibilityIdentifier("control-pages")
            Divider()
            ScrollView {
                VStack(spacing: 14) {
                    if let error = store.error {
                        VStack(alignment: .leading, spacing: 8) {
                            Label("Could not complete the update", systemImage: "exclamationmark.circle")
                                .font(.headline)
                            Text(error).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            Button("Dismiss", action: store.dismissError).buttonStyle(.bordered)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if store.snapshot == nil {
                        VStack(spacing: 12) {
                            Image(systemName: "headphones").font(.system(size: 34)).foregroundStyle(.secondary)
                            Text("Your headset, at hand").font(.headline)
                            Text("Pair your Momentum 4 in Bluetooth Settings, then connect it to this Mac.")
                                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            Button("Connect to this Mac") { store.refresh(reconnect: true) }
                                .buttonStyle(.borderedProminent).disabled(store.busy)
                        }.padding(.vertical, 32).frame(maxWidth: .infinity)
                    } else {
                        switch store.page {
                        case .devices: devices
                        case .noise: noise
                        case .sound: sound
                        case .more: more
                        }
                    }
                }.padding(16)
            }.frame(maxHeight: .infinity)
            Divider()
            HStack(spacing: 10) {
                Button { store.refresh() } label: { Label("Refresh", systemImage: "arrow.clockwise") }
                    .disabled(store.busy).accessibilityIdentifier("refresh")
                Spacer()
                Button(action: openBluetoothSettings) { Image(systemName: "antenna.radiowaves.left.and.right") }
                    .help("Bluetooth Settings").accessibilityLabel("Bluetooth Settings")
                Button(action: openSettings) { Image(systemName: "gearshape") }
                    .help("Settings").accessibilityLabel("Settings")
                Menu {
                    Button("Quit Momentum 4 Controls", action: quit).keyboardShortcut("q")
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 22)
                    .accessibilityLabel("More actions")
            }.buttonStyle(.bordered).controlSize(.small).padding(14)
        }.frame(width: 410, height: 640)
            .onDisappear { store.flushPreviews() }
    }
    private var header: some View {
        HStack(spacing: 12) {
            hero
            VStack(alignment: .leading, spacing: 4) {
                Text(store.snapshot?.name ?? "Momentum 4").font(.headline).lineLimit(1)
                HStack(spacing: 5) {
                    if store.busy { ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 13, height: 13) }
                    else { Circle().fill(store.ready ? Color.green : Color.secondary).frame(width: 6, height: 6) }
                    Text(store.status).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            if let snapshot = store.snapshot {
                VStack(alignment: .trailing, spacing: 4) {
                    Image(systemName: snapshot.battery <= 15 ? "battery.25percent" : "battery.75percent")
                        .foregroundStyle(snapshot.battery <= 15 ? Color.orange : Color.secondary)
                    Text("\(snapshot.battery)%\(store.stale ? " · stale" : "")")
                        .font(.caption).monospacedDigit().foregroundStyle(.secondary)
                }.accessibilityElement(children: .combine)
                    .accessibilityLabel("Battery \(snapshot.battery) percent\(store.stale ? ", stale" : "")")
            }
        }
    }
    @ViewBuilder private var hero: some View {
        let symbol = Image(systemName: "headphones").font(.system(size: 24, weight: .medium))
            .symbolRenderingMode(.hierarchical).foregroundStyle(Color.accentColor).frame(width: 48, height: 48)
        if #available(macOS 26.0, *), !reduceTransparency {
            symbol.glassEffect(.regular.tint(.accentColor.opacity(0.12)), in: Circle())
        } else { symbol.background(.quaternary, in: Circle()) }
    }
    private func toggle(_ control: Control) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Toggle(control.title, isOn: Binding(get: { store.shown(control) == 1 },
                set: { store.set(control, to: $0 ? 1 : 0) }))
                .toggleStyle(.switch).disabled(!store.ready || store.snapshot?.values[control] == nil)
                .accessibilityIdentifier(control.rawValue)
            if store.snapshot?.values[control] == nil { Text("Unavailable on this firmware").font(.caption).foregroundStyle(.secondary) }
        }
    }
    private struct Choice: Identifiable { let id: Int; let title: String }
    private func choice(_ control: Control, _ values: [(Int, String)]) -> some View {
        Picker(control.title, selection: Binding(get: { store.shown(control) ?? -1 }, set: { store.set(control, to: $0) })) {
            if store.shown(control) == nil { Text("Unavailable").tag(-1) }
            ForEach(values.map { Choice(id: $0.0, title: $0.1) }) { option in
                Text(option.title).tag(option.id)
                    .disabled(control == .soundMode && option.id == 3 && store.snapshot?.personalizationState != 2)
            }
            if let actual = store.shown(control), !values.contains(where: { $0.0 == actual }) { Text("\(actual)").tag(actual) }
        }.pickerStyle(.menu).disabled(!store.ready || store.snapshot?.values[control] == nil)
            .accessibilityIdentifier(control.rawValue)
    }
    private func card<Content: View>(_ title: String, symbol: String, @ViewBuilder content: () -> Content) -> some View {
        GroupBox { VStack(alignment: .leading, spacing: 12, content: content).frame(maxWidth: .infinity) }
            label: { Label(title, systemImage: symbol).font(.subheadline.weight(.semibold)) }
    }
    private var devices: some View {
        VStack(spacing: 14) {
            card("Connections", symbol: "point.3.connected.trianglepath.dotted") {
                toggle(.multipoint)
                Text("Switch the other source while keeping this Mac connected.").font(.caption).foregroundStyle(.secondary)
                if let state = store.snapshot?.connections {
                    Divider()
                    ForEach(state.peers) { peer in
                        HStack(spacing: 10) {
                            Image(systemName: peer.index == state.ownIndex ? "laptopcomputer" : "point.3.connected.trianglepath.dotted")
                                .foregroundStyle(.secondary).frame(width: 20)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(peer.name).lineLimit(1)
                                Text(peer.index == state.ownIndex ? "This Mac · protected" : peer.connected ? "Connected" : "Paired")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            if peer.index != state.ownIndex {
                                Button(peer.connected ? "Disconnect" : "Switch") { store.switchPeer(peer) }
                                    .buttonStyle(.bordered).controlSize(.small)
                                    .disabled(!store.ready || (!peer.connected && state.capacity < 2))
                                    .accessibilityIdentifier("peer-\(peer.index)")
                            } else { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("This Mac is connected") }
                        }
                    }
                }
            }
            card("Connect another computer", symbol: "laptopcomputer.and.arrow.down") {
                Text("Pair it with Momentum 4 in that computer’s Bluetooth settings. It will appear in the paired-device list.")
                    .font(.callout).foregroundStyle(.secondary)
            }
        }
    }
    private var noise: some View {
        VStack(spacing: 14) {
            card("Noise control", symbol: "waveform") {
                toggle(.anc); toggle(.adaptive)
                choice(.antiWind, [(0, "Off"), (2, "Auto"), (1, "Max")])
                Divider()
                HStack {
                    Text("Transparency")
                    Spacer()
                    Text("\(store.shown(.transparency) ?? 0)%").monospacedDigit().foregroundStyle(.secondary)
                }
                Slider(value: Binding(get: { Double(store.shown(.transparency) ?? 0) },
                    set: { store.preview(.transparency, value: Int($0.rounded())) }), in: 0...100, step: 1,
                    onEditingChanged: { store.setEditing(Control.transparency.rawValue, active: $0) })
                    .disabled(!store.ready || store.snapshot?.values[.transparency] == nil)
                    .accessibilityLabel("Transparency").accessibilityIdentifier("transparency-slider")
            }
            card("Wearing and playback", symbol: "person.crop.circle") {
                toggle(.onHeadDetection); toggle(.smartPause)
            }
        }
    }
    private var sound: some View {
        VStack(spacing: 14) {
            card("Listening", symbol: "music.note") {
                choice(.soundMode, [(0, "Off"), (1, "Equalizer"), (2, "Speech / Podcast"), (3, "Personalized")])
                toggle(.bassBoost)
            }
            if let eq = store.snapshot?.equalizer {
                card("Equalizer", symbol: "slider.horizontal.3") {
                    ForEach(eq.gains.indices, id: \.self) { band in
                        HStack(spacing: 10) {
                            Text("Band \(band + 1)").font(.callout).frame(width: 48, alignment: .leading)
                            Slider(value: Binding(get: { Double(store.shownBand(band)) / 10 },
                                set: { store.previewBand(band, gain: Int(($0 * 10).rounded())) }),
                                in: Double(eq.minimum) / 10...Double(eq.maximum) / 10, step: 0.1,
                                onEditingChanged: { store.setEditing("eq\(band)", active: $0) })
                                .disabled(!store.ready).accessibilityLabel("Equalizer band \(band + 1)")
                                .accessibilityIdentifier("eq-\(band)")
                            Text(String(format: "%+.1f dB", Double(store.shownBand(band)) / 10))
                                .font(.caption).monospacedDigit().frame(width: 59, alignment: .trailing).foregroundStyle(.secondary)
                        }
                    }
                    Button("Reset to flat", action: store.flatEqualizer).buttonStyle(.bordered).disabled(!store.ready)
                }
                card("Saved presets", symbol: "bookmark") {
                    HStack {
                        Picker("Preset", selection: $store.selectedPreset) {
                            Text("Choose a preset").tag("")
                            ForEach(store.presets) { Text($0.name).tag($0.name) }
                        }.pickerStyle(.menu)
                        Button("Apply", action: store.applyPreset).disabled(!store.ready || store.selectedPreset.isEmpty)
                    }
                    HStack {
                        TextField("New preset name", text: $store.presetName).textFieldStyle(.roundedBorder)
                        Button("Save current", action: store.savePreset).disabled(!store.ready || store.hasPreviews || store.presetName.isEmpty)
                    }
                    HStack {
                        Button("Remove preset", action: store.removePreset).disabled(store.selectedPreset.isEmpty)
                        if store.removedPreset != nil { Button("Undo removal", action: store.undoPresetRemoval) }
                    }.buttonStyle(.borderless).font(.caption)
                }
            }
            Text("Create new personalized sound profiles in Smart Control Plus. An existing calibrated profile can be selected here.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
    private var more: some View {
        VStack(spacing: 14) {
            card("Calls", symbol: "phone") {
                toggle(.autoAnswer); toggle(.comfortCall)
                choice(.sidetone, [(0, "Off"), (1, "Very low"), (2, "Low"), (3, "Medium"), (4, "High"), (5, "Very high")])
            }
            card("Headset settings", symbol: "gearshape") {
                choice(.autoPowerOff, [(0, "Never"), (900, "15 minutes"), (1800, "30 minutes"), (3600, "1 hour"), (7200, "2 hours")])
                choice(.promptMode, [(0, "Off"), (1, "Tones"), (2, "Tones and voice")])
                choice(.audioPriority, [(0, "Advanced quality"), (1, "Compatibility")])
                toggle(.touchLock); toggle(.lowLatency)
                Divider()
                HStack {
                    TextField("Headset name", text: $store.headsetName).textFieldStyle(.roundedBorder)
                    Button("Rename", action: store.rename).disabled(!store.ready || !validName(store.headsetName))
                }
            }
            if let device = store.snapshot {
                card("About your headset", symbol: "info.circle") {
                    LabeledContent("Firmware", value: device.firmware)
                    LabeledContent("Audio codec", value: codecName(device.codec))
                    LabeledContent("Voice language", value: languageName(device.promptLanguage))
                    LabeledContent("Bluetooth address", value: device.address).font(.caption).textSelection(.enabled)
                }
            }
        }
    }
}

func codecName(_ value: Int) -> String {
    let codecs = ["SBC", "AAC", "aptX", "aptX Low Latency", "MP3", "aptX HD", "FastStream", "LHDC", "aptX Adaptive", "aptX Lossless", "LC3"]
    return value == 255 ? "No audio stream" : codecs.indices.contains(value) ? codecs[value] : "Unknown (\(value))"
}
func languageName(_ value: Int?) -> String {
    let languages = ["English", "German", "French", "Spanish", "Chinese", "Japanese", "Russian", "Korean"]
    guard let value, languages.indices.contains(value) else { return "Unavailable" }
    return languages[value]
}
func openBluetoothSettings() {
    if let url = URL(string: "x-apple.systempreferences:com.apple.BluetoothSettings") { NSWorkspace.shared.open(url) }
}
