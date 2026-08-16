@preconcurrency import FirebaseFirestore
import Foundation

enum FirestoreValueReader {
    static func string(_ value: Any?) -> String? {
        guard let string = value as? String else { return nil }
        return string.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func string(_ data: [String: Any], key: String) -> String? {
        string(data[key])
    }

    static func int(_ value: Any?) -> Int? {
        switch value {
        case let int as Int:
            return int
        case let number as NSNumber:
            return number.intValue
        case let string as String:
            return Int(string)
        default:
            return nil
        }
    }

    static func int(_ data: [String: Any], key: String) -> Int? {
        int(data[key])
    }

    static func double(_ value: Any?) -> Double? {
        switch value {
        case let double as Double:
            return double
        case let number as NSNumber:
            return number.doubleValue
        case let string as String:
            return Double(string)
        default:
            return nil
        }
    }

    static func double(_ data: [String: Any], key: String) -> Double? {
        double(data[key])
    }

    static func bool(_ value: Any?) -> Bool? {
        switch value {
        case let bool as Bool:
            return bool
        case let number as NSNumber:
            return number.boolValue
        default:
            return nil
        }
    }

    static func bool(_ data: [String: Any], key: String) -> Bool? {
        bool(data[key])
    }

    static func map(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    static func stringArray(_ value: Any?) -> [String] {
        (value as? [Any] ?? []).compactMap { string($0) }
    }

    static func date(_ value: Any?) -> Date? {
        switch value {
        case let timestamp as Timestamp:
            return timestamp.dateValue()
        case let date as Date:
            return date
        default:
            return nil
        }
    }

    static func dateFromMilliseconds(_ value: Any?) -> Date? {
        let milliseconds: Double?

        switch value {
        case let int as Int:
            milliseconds = Double(int)
        case let double as Double:
            milliseconds = double
        case let number as NSNumber:
            milliseconds = number.doubleValue
        case let string as String:
            milliseconds = Double(string)
        default:
            milliseconds = nil
        }

        guard let milliseconds, milliseconds > 0 else { return nil }
        return Date(timeIntervalSince1970: milliseconds / 1_000)
    }
}
