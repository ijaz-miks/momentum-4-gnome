import Foundation

public enum HeadsetError: Error, LocalizedError, Equatable {
    case invalid(String)
    case unavailable(String)
    case rejected(vendor: UInt16, command: UInt16)
    case timeout
    case busy
    case verification(String)

    public var errorDescription: String? {
        switch self {
        case .invalid(let reason), .unavailable(let reason), .verification(let reason): return reason
        case .rejected: return "This headset firmware does not support that command."
        case .timeout: return "The headset did not respond in time. Connect it and try again."
        case .busy: return "Another headset operation is still running."
        }
    }
}

public struct GaiaFrame: Equatable, Sendable {
    public static let sennheiser: UInt16 = 0x0495
    public static let qualcomm: UInt16 = 0x001d
    public let vendor: UInt16
    public let command: UInt16
    public let payload: [UInt8]

    public init(vendor: UInt16 = Self.sennheiser, command: UInt16, payload: [UInt8] = []) {
        self.vendor = vendor
        self.command = command
        self.payload = payload
    }

    public func encoded(checksum: Bool = false) throws -> Data {
        guard payload.count <= 255 else { throw HeadsetError.invalid("GAIA payload is too long.") }
        var bytes: [UInt8] = [0xff, 3, checksum ? 1 : 0, UInt8(payload.count),
            UInt8(vendor >> 8), UInt8(vendor & 255), UInt8(command >> 8), UInt8(command & 255)] + payload
        if checksum { bytes.append(bytes.reduce(0, ^)) }
        return Data(bytes)
    }
}

public struct GaiaDecoder {
    private var buffer: [UInt8] = []
    public init() {}

    public mutating func feed(_ data: Data) throws -> [GaiaFrame] {
        buffer.append(contentsOf: data)
        var frames: [GaiaFrame] = []
        while buffer.count >= 8 {
            guard buffer[0] == 0xff, buffer[1] == 3, buffer[2] <= 1 else {
                throw HeadsetError.invalid("Invalid GAIA frame header.")
            }
            let count = Int(buffer[3]), checked = buffer[2] == 1
            let length = 8 + count + (checked ? 1 : 0)
            guard buffer.count >= length else { break }
            if checked && buffer.prefix(length).reduce(0, ^) != 0 {
                throw HeadsetError.invalid("Invalid GAIA frame checksum.")
            }
            frames.append(GaiaFrame(vendor: UInt16(buffer[4]) << 8 | UInt16(buffer[5]),
                command: UInt16(buffer[6]) << 8 | UInt16(buffer[7]), payload: Array(buffer[8..<(8 + count)])))
            buffer.removeFirst(length)
        }
        return frames
    }
}

@MainActor public protocol GaiaTransport: AnyObject {
    var address: String { get }
    var name: String { get }
    func open(reconnect: Bool) async throws
    func close()
    /// One matched response per request. Unrelated notifications are ignored.
    func exchange(_ frame: GaiaFrame) async throws -> GaiaFrame
}
