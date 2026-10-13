// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Momentum4Mac",
    platforms: [.macOS(.v14)],
    products: [.library(name: "MomentumCore", targets: ["MomentumCore"]),
        .library(name: "MomentumBluetooth", targets: ["MomentumBluetooth"]),
        .executable(name: "MomentumMenu", targets: ["MomentumMenu"])],
    targets: [
        .target(name: "MomentumCore"),
        .target(name: "MomentumFixtures", dependencies: ["MomentumCore"]),
        .target(name: "MomentumBluetooth", dependencies: ["MomentumCore"], linkerSettings: [.linkedFramework("IOBluetooth"), .linkedFramework("CoreBluetooth")]),
        .executableTarget(name: "MomentumMenu", dependencies: ["MomentumCore", "MomentumBluetooth", "MomentumFixtures"], linkerSettings: [.linkedFramework("ServiceManagement")]),
        .executableTarget(name: "MomentumCoreChecks", dependencies: ["MomentumCore", "MomentumFixtures"], path: "Tests/MomentumCoreTests"),
    ],
    swiftLanguageModes: [.v5]
)
