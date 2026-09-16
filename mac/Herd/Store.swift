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
    var logsHost: Host?
    var logsText = ""
    var chat: Chat?
    @ObservationIgnored private var chatTask: Task<Void, Never>?

    struct ChatMessage: Identifiable {
        let id = UUID()
        var role: String
        var content = ""
        var reasoning = ""
    }

    struct Chat {
        var host: Host
        var model: String
        var messages: [ChatMessage] = []
        var input = ""
        var streaming = false
        var error = ""
    }

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
        await refreshLogs()   // keep the open logs pane live, like the web drawer
    }

    // MARK: Logs

    func openLogs(_ host: Host) {
        logsHost = host
        logsText = "Loading logs…"
        Task { await refreshLogs() }
    }

    func closeLogs() { logsHost = nil; logsText = "" }

    private func refreshLogs() async {
        guard let h = logsHost, let url = URL(string: h.url) else { return }
        do { logsText = try await LlamaSwapClient(base: url).logs() }
        catch { logsText = "Could not fetch logs: \(error.localizedDescription)" }
    }

    // MARK: Chat

    func openChat(_ host: Host, _ model: String) {
        if let c = chat, c.host.id == host.id, c.model == model { return }   // keep the transcript
        stopChat()
        chat = Chat(host: host, model: model)
    }

    func closeChat() { stopChat(); chat = nil }

    func stopChat() { chatTask?.cancel() }

    /// Sends the input plus prior turns and streams the reply into a trailing
    /// assistant message, patching it in place as deltas arrive.
    func sendChat() {
        guard var c = chat, !c.streaming, let url = URL(string: c.host.url) else { return }
        let text = c.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        c.messages.append(ChatMessage(role: "user", content: text))
        let history = c.messages.map { (role: $0.role, content: $0.content) }
        c.messages.append(ChatMessage(role: "assistant"))
        c.input = ""; c.streaming = true; c.error = ""
        chat = c
        chatTask = Task {
            do {
                for try await delta in LlamaSwapClient(base: url).chat(model: c.model, messages: history) {
                    switch delta {
                    case .content(let s): appendToLast(\.content, s)
                    case .reasoning(let s): appendToLast(\.reasoning, s)
                    }
                }
            } catch {
                if !Task.isCancelled { chat?.error = error.localizedDescription }
            }
            chat?.streaming = false
            await pollAll()   // the model just loaded or its state changed
        }
    }

    private func appendToLast(_ field: WritableKeyPath<ChatMessage, String>, _ s: String) {
        guard let i = chat?.messages.indices.last else { return }
        chat?.messages[i][keyPath: field] += s
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
