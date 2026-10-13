import Foundation

public enum Control: String, CaseIterable, Codable, Sendable {
    case anc, adaptive, antiWind, transparency, onHeadDetection, smartPause
    case autoAnswer, comfortCall, multipoint, bassBoost, soundMode, sidetone
    case promptMode, autoPowerOff, touchLock, lowLatency, audioPriority

    public var title: String {
        switch self {
        case .anc: return "Noise cancellation"
        case .adaptive: return "Adaptive noise control"
        case .antiWind: return "Anti-wind"
        case .transparency: return "Transparency"
        case .onHeadDetection: return "On-head detection"
        case .smartPause: return "Smart Pause"
        case .autoAnswer: return "Auto-answer calls"
        case .comfortCall: return "Comfort Call"
        case .multipoint: return "Multipoint"
        case .bassBoost: return "Bass boost"
        case .soundMode: return "Sound mode"
        case .sidetone: return "Sidetone"
        case .promptMode: return "Voice and tone prompts"
        case .autoPowerOff: return "Auto power-off"
        case .touchLock: return "Lock touch controls"
        case .lowLatency: return "Low latency"
        case .audioPriority: return "Audio priority"
        }
    }
    public var isBoolean: Bool {
        [.anc, .adaptive, .onHeadDetection, .smartPause, .autoAnswer, .comfortCall,
         .multipoint, .bassBoost, .touchLock, .lowLatency].contains(self)
    }
    public var range: ClosedRange<Int> {
        if isBoolean { return 0...1 }
        switch self {
        case .antiWind, .promptMode: return 0...2
        case .transparency: return 0...100
        case .soundMode: return 0...3
        case .sidetone: return 0...5
        case .autoPowerOff: return 0...65535
        case .audioPriority: return 0...1
        default: return 0...1
        }
    }
    public var readCommand: UInt16 {
        switch self {
        case .anc: return 0x1a05
        case .adaptive, .antiWind: return 0x1a01
        case .transparency: return 0x1a03
        case .onHeadDetection: return 0x0401
        case .smartPause: return 0x080d
        case .autoAnswer: return 0x080b
        case .comfortCall: return 0x0815
        case .multipoint: return 0x0e10
        case .bassBoost: return 0x1009
        case .soundMode: return 0x0804
        case .sidetone: return 0x0806
        case .promptMode: return 0x0802
        case .autoPowerOff: return 0x0601
        case .touchLock: return 0x1607
        case .lowLatency: return 0x0818
        case .audioPriority: return 0x0406
        }
    }
    public var writeCommand: UInt16 {
        switch self {
        case .anc: return 0x1a04
        case .adaptive, .antiWind: return 0x1a00
        case .transparency: return 0x1a02
        case .onHeadDetection: return 0x0400
        case .smartPause: return 0x080c
        case .autoAnswer: return 0x080a
        case .comfortCall: return 0x0814
        case .multipoint: return 0x0e00
        case .bassBoost: return 0x1008
        case .soundMode: return 0x0803
        case .sidetone: return 0x0805
        case .promptMode: return 0x0801
        case .autoPowerOff: return 0x0600
        case .touchLock: return 0x1606
        case .lowLatency: return 0x0817
        case .audioPriority: return 0x0405
        }
    }
    public var vendor: UInt16 { self == .multipoint ? GaiaFrame.qualcomm : GaiaFrame.sennheiser }
    public var readPayload: [UInt8] { self == .autoPowerOff ? [0] : [] }
    public func writePayload(_ value: Int) throws -> [UInt8] {
        guard range.contains(value) else { throw HeadsetError.invalid("Invalid \(title.lowercased()) value.") }
        switch self {
        case .adaptive: return [3, UInt8(value)]
        case .antiWind: return [1, UInt8(value)]
        case .soundMode: return [0, UInt8(value)]
        case .autoPowerOff: return [0, UInt8(value >> 8), UInt8(value & 255)]
        default: return [UInt8(value)]
        }
    }
    public func decode(_ payload: [UInt8]) throws -> Int {
        let value: Int
        switch self {
        case .adaptive, .antiWind:
            guard payload.count == 6 else { throw HeadsetError.invalid("Invalid noise-mode response.") }
            var modes: [UInt8: UInt8] = [:]
            for index in stride(from: 0, to: 6, by: 2) {
                let tag = payload[index]
                guard (1...3).contains(tag), modes[tag] == nil else {
                    throw HeadsetError.invalid("Invalid noise-mode tags.")
                }
                modes[tag] = payload[index + 1]
            }
            let tag: UInt8 = self == .adaptive ? 3 : 1
            guard let mode = modes[tag] else { throw HeadsetError.invalid("Missing noise mode.") }
            value = Int(mode)
        case .soundMode:
            guard payload.count == 2, payload[0] == 0 else { throw HeadsetError.invalid("Invalid sound mode.") }
            value = Int(payload[1])
        case .autoPowerOff:
            guard payload.count == 3, payload[0] == 0 else { throw HeadsetError.invalid("Invalid power-off timer.") }
            value = Int(payload[1]) << 8 | Int(payload[2])
        default:
            guard payload.count == 1 else { throw HeadsetError.invalid("Invalid setting response length.") }
            value = Int(payload[0])
        }
        guard range.contains(value) else { throw HeadsetError.invalid("Setting outside its supported range.") }
        return value
    }
}
