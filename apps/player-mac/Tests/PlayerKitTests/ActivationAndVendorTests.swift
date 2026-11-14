import Foundation
import XCTest
@testable import PlayerKit

final class ActivationAndVendorTests: XCTestCase {
    func testActivationPolicyCounterOnlyRestoresAfterTheLastWindow() {
        var policies: [ActivationPolicy] = []
        let coordinator = ActivationPolicyCoordinator { policies.append($0) }

        coordinator.acquire()
        XCTAssertEqual(coordinator.openCount, 1)
        coordinator.acquire()
        XCTAssertEqual(coordinator.openCount, 2)

        coordinator.release()
        XCTAssertEqual(coordinator.openCount, 1)
        XCTAssertEqual(policies, [.regular], "closing one window must not demote the app")

        coordinator.release()
        XCTAssertEqual(coordinator.openCount, 0)
        XCTAssertEqual(policies, [.regular, .accessory])
    }

    func testReleaseWithoutAcquireIsIgnored() {
        var policies: [ActivationPolicy] = []
        let coordinator = ActivationPolicyCoordinator { policies.append($0) }

        coordinator.release()

        XCTAssertEqual(coordinator.openCount, 0)
        XCTAssertTrue(policies.isEmpty)
    }

    func testVendorConflictSessionDeduplicatesAcrossEvents() {
        var session = VendorConflictSession()
        session.note("Razer Synapse, Logitech G HUB")
        XCTAssertEqual(session.names, ["Razer Synapse", "Logitech G HUB"])

        session.note("Razer Synapse")
        session.note("Razer Synapse, Logitech G HUB")
        XCTAssertEqual(session.names, ["Razer Synapse", "Logitech G HUB"])
        XCTAssertEqual(session.displayNames, "Razer Synapse, Logitech G HUB")
    }

    func testEmptyConflictNamesAreIgnored() {
        var session = VendorConflictSession()
        session.note(nil)
        session.note("   ")
        session.note(" , ")
        XCTAssertTrue(session.isEmpty)
    }
}
