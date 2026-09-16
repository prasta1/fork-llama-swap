import Foundation
import Observation

@MainActor @Observable
final class Store {
    /// Same key and JSON shape as the web dashboard's localStorage entry.
    static let key = "herd.hosts.v1"

    var hosts: [Host] { didSet { UserDefaults.standard.set(try? JSONEncoder().encode(hosts), forKey: Self.key) } }
    var data: [String: HostSnapshot] = [:]
    var pending: Set<String> = []   // "hostId|modelId" while a load/unload is in flight
    var updatedAt: Date?

    init() {
        hosts = UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([Host].self, from: $0) }
            ?? [Host(id: "local", name: "localhost", url: "http://localhost:8999")]
    }

    /// Polls every host now, then every 5 seconds until the calling task is cancelled.
    func run() async {
        while !Task.isCancelled {
            await pollAll()
            try? await Task.sleep(for: .seconds(5))
        }
    }

    /// Polls all hosts concurrently. An unreachable host keeps its last model list
    /// so the table doesn't flicker empty on a dropped poll.
    func pollAll() async {
        let hosts = hosts
        let results = await withTaskGroup(of: (String, HostSnapshot).self) { group in
            for h in hosts {
                group.addTask {
                    guard let url = URL(string: h.url) else { return (h.id, HostSnapshot(online: false, error: "Bad URL")) }
                    do { return (h.id, try await LlamaSwapClient(base: url).poll()) }
                    catch { return (h.id, HostSnapshot(online: false, error: error.localizedDescription)) }
                }
            }
            var out: [String: HostSnapshot] = [:]
            for await (id, snap) in group { out[id] = snap }
            return out
        }
        for h in hosts {
            var snap = results[h.id] ?? HostSnapshot(online: false)
            if !snap.online { snap.models = data[h.id]?.models ?? [] }
            data[h.id] = snap
        }
        updatedAt = .now
    }

    /// Loads a stopped model or unloads a ready one, then re-polls so the table
    /// reflects the server's view rather than an optimistic guess.
    func act(_ host: Host, _ model: Model) async {
        let key = "\(host.id)|\(model.id)"
        pending.insert(key)
        defer { pending.remove(key) }
        guard let url = URL(string: host.url) else { return }
        let client = LlamaSwapClient(base: url)
        do {
            if model.state == "ready" { try await client.unload(model.id) } else { try await client.load(model.id) }
        } catch {
            data[host.id]?.error = error.localizedDescription
        }
        await pollAll()
    }
}
