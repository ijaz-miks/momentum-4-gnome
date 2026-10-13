// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Momentum4Mac",
    platforms: [.macOS(.v14)],
    products: [.library(name: "MomentumCore", targets: ["MomentumCore"])],
    targets: [
        .target(name: "MomentumCore"),
        .executableTarget(name: "MomentumCoreChecks", dependencies: ["MomentumCore"], path: "Tests/MomentumCoreTests"),
    ],
    swiftLanguageModes: [.v5]
)
