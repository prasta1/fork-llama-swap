import XCTest
@testable import Herd

final class MergeModelsTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) -> T {
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    func testRunningWinsAliasesHiddenAndRunningOnlyAppended() {
        let models: ModelsResponse = decode(#"{"data":[{"id":"b","name":"Bee","status":{"value":"loaded"}},{"id":"a","meta":{"llamaswap":{"type":"alias"}}},{"id":"c","status":{"value":"loaded"}}]}"#)
        let running: RunningResponse = decode(#"{"running":[{"model":"b","state":"ready"},{"model":"ghost","state":"starting"}]}"#)
        let out = mergeModels(models, running)
        XCTAssertEqual(out.map(\.id), ["b", "c", "ghost"])
        // c says "loaded" in /v1/models but /running is authoritative and omits it.
        XCTAssertEqual(out.map(\.state), ["ready", "stopped", "starting"])
    }

    func testFallsBackToModelsStatusWhenRunningFailed() {
        let models: ModelsResponse = decode(#"{"data":[{"id":"c","status":{"value":"loaded"}},{"id":"d","status":{"value":"unloaded"}}]}"#)
        XCTAssertEqual(mergeModels(models, nil).map(\.state), ["ready", "stopped"])
    }
}
