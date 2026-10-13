import Foundation

public struct Peer: Identifiable, Equatable, Codable, Sendable {
    public var id: Int { index }
    public let index: Int
    public let priority: Int
    public let connected: Bool
    public let name: String
    public init(index: Int, priority: Int, connected: Bool, name: String) {
        self.index = index; self.priority = priority; self.connected = connected; self.name = name
    }
    public static func decode(_ bytes: [UInt8], index: Int) throws -> Peer {
        guard bytes.count >= 4, bytes[0] == index, bytes[2] <= 1, bytes.last == 0,
            !bytes[3..<(bytes.count - 1)].contains(0),
            let name = String(bytes: bytes[3..<(bytes.count - 1)], encoding: .utf8), validName(name, maximum: 255)
        else { throw HeadsetError.invalid("Invalid paired-device response.") }
        return Peer(index: index, priority: Int(bytes[1]), connected: bytes[2] == 1, name: name)
    }
}

public func validName(_ name: String, maximum: Int = 32) -> Bool {
    !name.isEmpty && name.utf8.count <= maximum && name.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
}

public struct Connections: Equatable, Sendable {
    public let capacity: Int
    public let ownIndex: Int
    public let peers: [Peer]
    public init(capacity: Int, ownIndex: Int, peers: [Peer]) throws {
        guard (1...2).contains(capacity), (1...16).contains(peers.count), peers.indices.contains(ownIndex),
            peers.enumerated().allSatisfy({ $0.offset == $0.element.index }),
            peers[ownIndex].connected, peers.filter(\.connected).count <= capacity
        else { throw HeadsetError.invalid("Inconsistent paired-device state.") }
        self.capacity = capacity; self.ownIndex = ownIndex; self.peers = peers
    }
    public func checkedPeer(index: Int, name: String) throws -> Peer {
        guard index != ownIndex else { throw HeadsetError.invalid("This Mac's control connection is protected.") }
        guard peers.indices.contains(index), peers[index].name == name else {
            throw HeadsetError.invalid("The paired-device list changed. Refresh before switching.")
        }
        return peers[index]
    }
}

public struct Equalizer: Equatable, Codable, Sendable {
    public let minimum: Int
    public let maximum: Int
    public var gains: [Int]
    public init(minimum: Int, maximum: Int, gains: [Int]) throws {
        guard minimum < maximum, (-128...127).contains(minimum), (-128...127).contains(maximum),
            (1...16).contains(gains.count), gains.allSatisfy({ (minimum...maximum).contains($0) })
        else { throw HeadsetError.invalid("Invalid equalizer limits or gains.") }
        self.minimum = minimum; self.maximum = maximum; self.gains = gains
    }
}

public struct HeadsetSnapshot: Sendable {
    public let address: String
    public let name: String
    public let firmware: String
    public let battery: Int
    public let codec: Int
    public let wearState: Int?
    public let promptLanguage: Int?
    public let availablePromptLanguages: [Int]?
    public let personalizationState: Int?
    public var values: [Control: Int]
    public let connections: Connections
    public var equalizer: Equalizer?
    public let unsupported: [Control: String]
    public init(address: String, name: String, firmware: String, battery: Int, codec: Int,
        wearState: Int? = nil, promptLanguage: Int? = nil, availablePromptLanguages: [Int]? = nil,
        personalizationState: Int? = nil, values: [Control: Int], connections: Connections,
        equalizer: Equalizer? = nil, unsupported: [Control: String] = [:]) {
        self.address = address; self.name = name; self.firmware = firmware; self.battery = battery
        self.codec = codec; self.wearState = wearState; self.promptLanguage = promptLanguage
        self.availablePromptLanguages = availablePromptLanguages; self.personalizationState = personalizationState
        self.values = values; self.connections = connections; self.equalizer = equalizer; self.unsupported = unsupported
    }
}
