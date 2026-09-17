import Foundation

/// Superficie di `UserRepository` consumata dal layer di presentazione.
/// Stesse motivazioni e stesso perimetro incrementale di
/// `TitleRepositoryProtocol`.
@MainActor
protocol UserRepositoryProtocol: AnyObject, Sendable {
    func listFollowing(userID: String, limit: Int) async throws -> [AppUser]

    // Aggiunti per `ProfileViewModel`.
    func fetchUser(uid: String) async throws -> AppUser?
    func listFollowers(userID: String, limit: Int) async throws -> [AppUser]
}

extension UserRepositoryProtocol {
    func listFollowing(userID: String) async throws -> [AppUser] {
        try await listFollowing(userID: userID, limit: 120)
    }

    func listFollowers(userID: String) async throws -> [AppUser] {
        try await listFollowers(userID: userID, limit: 120)
    }
}

extension UserRepository: UserRepositoryProtocol {}
