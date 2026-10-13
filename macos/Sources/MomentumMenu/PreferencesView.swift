import SwiftUI

struct PreferencesView: View {
    @ObservedObject var store: HeadsetStore
    var body: some View {
        Form {
            Section("Menu bar") {
                Toggle("Show battery percentage", isOn: $store.showBattery)
                Text("The app reads the battery every two minutes while the panel is closed.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Headset selection") {
                TextField("Bluetooth address", text: $store.addressDraft, prompt: Text("Automatic if only one headset is paired"))
                    .disabled(store.busy).textFieldStyle(.roundedBorder)
                Button("Use this headset", action: store.selectAddress).disabled(store.busy)
                Text("Leave the address empty for automatic selection. Pair source computers in their own Bluetooth settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Momentum 4 Controls") {
                Text("Native headset controls for macOS. Settings come from the headset and saved EQ presets are applied only when you choose them.")
                    .font(.callout).foregroundStyle(.secondary)
                Button("Bluetooth Settings", action: openBluetoothSettings)
            }
        }.formStyle(.grouped).frame(width: 480, height: 540)
    }
}
