import AppKit
import SwiftUI
import Combine
import MomentumCore
import MomentumBluetooth

@main struct MomentumMenu {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = MenuDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor final class MenuDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    let store: HeadsetStore
    let popover = NSPopover()
    private var status: NSStatusItem?
    var statusButton: NSStatusBarButton? { status?.button }
    private var preferences: NSWindow?
    private var observers: [NSObjectProtocol] = []
    private var changes: AnyCancellable?
    override init() {
        let demo = CommandLine.arguments.contains("--demo") || CommandLine.arguments.contains("--self-test")
        store = HeadsetStore(demo: demo)
        super.init()
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        status = item
        item.button?.image = NSImage(systemSymbolName: "headphones", accessibilityDescription: "Momentum 4 Controls")
        item.button?.image?.isTemplate = true
        item.button?.target = self; item.button?.action = #selector(togglePanel)
        item.button?.toolTip = "Momentum 4 Controls"
        popover.contentViewController = NSHostingController(rootView: ControlPanel(store: store,
            openSettings: { [weak self] in self?.openPreferences() }, quit: { NSApp.terminate(nil) }))
        popover.contentSize = NSSize(width: 410, height: 640)
        popover.behavior = .transient; popover.delegate = self
        popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        store.onStatusChanged = { [weak self] in self?.updateStatus() }
        changes = store.objectWillChange.sink { [weak self] in Task { @MainActor in self?.updateStatus() } }
        let center = NSWorkspace.shared.notificationCenter
        observers.append(center.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.store.stop() }
        })
        observers.append(center.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.store.start() }
        })
        if !store.isDemo { NSApp.activate(ignoringOtherApps: true) }
        store.start()
        if let index = CommandLine.arguments.firstIndex(of: "--hardware-read"), CommandLine.arguments.count > index + 1 {
            let output = URL(fileURLWithPath: CommandLine.arguments[index + 1])
            Task { await runHardwareRead(self, output: output, connect: CommandLine.arguments.contains("--connect")) }
        }
        if let index = CommandLine.arguments.firstIndex(of: "--self-test"), CommandLine.arguments.count > index + 1 {
            let output = URL(fileURLWithPath: CommandLine.arguments[index + 1], isDirectory: true)
            Task { await runNativeChecks(self, output: output) }
        }
    }
    private func installMainMenu() {
        let main = NSMenu()
        let application = NSMenuItem()
        let appMenu = NSMenu(title: "Momentum 4 Controls")
        let settings = NSMenuItem(title: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
        settings.target = self; appMenu.addItem(settings)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Momentum 4 Controls", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        application.submenu = appMenu; main.addItem(application)
        let editing = NSMenuItem(); editing.submenu = NSMenu(title: "Edit")
        for (title, selector, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"),
                                      ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            editing.submenu?.addItem(withTitle: title, action: NSSelectorFromString(selector), keyEquivalent: key)
        }
        main.addItem(editing); NSApp.mainMenu = main
    }
    @objc private func showSettings() { openPreferences() }
    @objc func togglePanel() {
        if popover.isShown { popover.performClose(nil) }
        else if let button = status?.button {
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
    }
    func popoverWillShow(_ notification: Notification) { store.menuVisible = true; store.refresh() }
    func popoverDidClose(_ notification: Notification) { store.menuVisible = false; store.flushPreviews() }
    private func updateStatus() {
        if store.showBattery, let snapshot = store.snapshot, !store.stale { status?.button?.title = " \(snapshot.battery)%" }
        else { status?.button?.title = "" }
        status?.button?.imagePosition = .imageLeading
        status?.button?.toolTip = "Momentum 4 Controls · \(store.status)"
    }
    func openPreferences() {
        popover.performClose(nil)
        if preferences == nil {
            let controller = NSHostingController(rootView: PreferencesView(store: store))
            let window = NSWindow(contentViewController: controller)
            window.title = "Momentum 4 Settings"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.isReleasedWhenClosed = false
            window.center(); preferences = window
        }
        NSApp.activate(ignoringOtherApps: true)
        preferences?.makeKeyAndOrderFront(nil)
    }
    func applicationWillTerminate(_ notification: Notification) {
        store.stop(); changes?.cancel()
        let center = NSWorkspace.shared.notificationCenter
        observers.forEach { center.removeObserver($0) }
        observers.removeAll()
        if let status { NSStatusBar.system.removeStatusItem(status) }
    }
}
