import Foundation
import Combine
import ServiceManagement

@MainActor final class LoginItems: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var needsApproval = false
    @Published private(set) var message: String?
    private let demo: Bool
    init(demo: Bool) { self.demo = demo; refresh() }
    func refresh() {
        guard !demo else { return }
        enabled = SMAppService.mainApp.status == .enabled
        needsApproval = SMAppService.mainApp.status == .requiresApproval
    }
    func bootstrap() {
        guard !demo else { return }
        let defaults = UserDefaults.standard
        if defaults.object(forKey: "launchAtLoginRequested") == nil { defaults.set(true, forKey: "launchAtLoginRequested") }
        if defaults.bool(forKey: "launchAtLoginRequested") && SMAppService.mainApp.status == .notRegistered {
            setEnabled(true)
        }
        refresh()
    }
    func setEnabled(_ value: Bool) {
        guard !demo else { enabled = value; return }
        UserDefaults.standard.set(value, forKey: "launchAtLoginRequested")
        if value {
            do { try SMAppService.mainApp.register(); message = nil }
            catch { message = "Could not enable launch at login: \(error.localizedDescription)" }
            refresh()
        } else {
            Task {
                do { try await SMAppService.mainApp.unregister(); message = nil }
                catch { message = "Could not disable launch at login: \(error.localizedDescription)" }
                refresh()
            }
        }
    }
    func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }
}
