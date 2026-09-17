import XCTest
@testable import Somto

final class SignupLifecycleTests: XCTestCase {
    func testPendingUnverifiedRequiresEmailVerification() {
        let state = SignupLifecycleState(
            lifecycleStatus: "pending_verification",
            emailVerified: false,
            legacyEmailUnverified: false,
            profilePresent: false,
            pendingStatus: "pending"
        )

        XCTAssertTrue(state.requiresEmailVerification)
        XCTAssertFalse(state.requiresServerCompletion)
        XCTAssertFalse(state.recommendsEmailVerification)
    }

    func testLegacyUnverifiedRemainsCompatible() {
        let state = SignupLifecycleState(
            lifecycleStatus: "legacy_unverified",
            emailVerified: false,
            legacyEmailUnverified: true,
            profilePresent: true,
            pendingStatus: nil
        )

        XCTAssertFalse(state.requiresEmailVerification)
        XCTAssertTrue(state.recommendsEmailVerification)
    }

    func testVerifiedPendingRequiresServerCompletion() {
        let state = SignupLifecycleState(
            lifecycleStatus: "auth_only",
            emailVerified: true,
            legacyEmailUnverified: false,
            profilePresent: false,
            pendingStatus: "pending"
        )

        XCTAssertTrue(state.requiresServerCompletion)
        XCTAssertFalse(state.recommendsEmailVerification)
    }

    @MainActor
    func testEmailMaskDoesNotExposeFullLocalPart() {
        XCTAssertEqual(AuthViewModel.maskedEmail("paolo@example.com"), "pa•••@example.com")
        XCTAssertEqual(AuthViewModel.maskedEmail("a@example.com"), "a•••@example.com")
    }
}
