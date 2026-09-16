import SwiftUI

@main
struct HerdApp: App {
    @State private var store = Store()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(store)
                .task { await store.run() }   // polls until the window closes
        }
    }
}
