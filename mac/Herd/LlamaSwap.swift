import Foundation

struct Host: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    var url: String
}

struct Model: Identifiable, Equatable {
    var id: String
    var name: String
    var description: String
    var aliases: [String]
    var state: String   // ready | starting | stopping | stopped
}

struct HostSnapshot {
    var online: Bool
    var version = ""
    var models: [Model] = []
    var stats: Stats?
    var error = ""
}

struct Stats: Decodable {
    var totalRequests: Int
    var totalInputTokens: Int
    var totalOutputTokens: Int
    enum CodingKeys: String, CodingKey {
        case totalRequests = "total_requests", totalInputTokens = "total_input_tokens", totalOutputTokens = "total_output_tokens"
    }
}

enum ChatDelta { case content(String), reasoning(String) }

struct ChatError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct ChatChunk: Decodable {
    var choices: [Choice]
    struct Choice: Decodable { var delta: Delta }
    struct Delta: Decodable {
        var content: String?
        var reasoning: String?
        var reasoningContent: String?
        enum CodingKeys: String, CodingKey { case content, reasoning, reasoningContent = "reasoning_content" }
    }
}

// Wire formats — only the fields Herd reads.
struct ModelsResponse: Decodable {
    var data: [Entry]
    struct Entry: Decodable {
        var id: String
        var name: String?
        var description: String?
        var meta: Meta?
        var status: Status?
        struct Meta: Decodable {
            var llamaswap: LlamaSwap?
            struct LlamaSwap: Decodable { var type: String?; var aliases: [String]? }
        }
        struct Status: Decodable { var value: String? }
    }
}

struct RunningResponse: Decodable {
    var running: [Entry]
    struct Entry: Decodable { var model: String; var state: String }
}

struct VersionResponse: Decodable { var version: String }

/// Mirrors `pollHost` in app.js. `/running` is the source of truth for state; if
/// it failed, fall back to `/v1/models`' coarser loaded/unloaded flag so a dropped
/// poll doesn't read every model as stopped.
func mergeModels(_ models: ModelsResponse?, _ running: RunningResponse?) -> [Model] {
    let stateById = Dictionary((running?.running ?? []).map { ($0.model, $0.state) }, uniquingKeysWith: { $1 })
    // Aliases/selectors/profiles are routing entries, not loadable models.
    var list = (models?.data ?? [])
        .filter { !["alias", "selector", "profile"].contains($0.meta?.llamaswap?.type ?? "") }
        .map { m in
            Model(id: m.id, name: m.name ?? "", description: m.description ?? "",
                  aliases: m.meta?.llamaswap?.aliases ?? [],
                  state: stateById[m.id] ?? (running != nil ? "stopped" : m.status?.value == "loaded" ? "ready" : "stopped"))
        }
    for r in running?.running ?? [] where !list.contains(where: { $0.id == r.model }) {
        list.append(Model(id: r.model, name: "", description: "", aliases: [], state: r.state))
    }
    return list.sorted { ($0.name + $0.id).localizedStandardCompare($1.name + $1.id) == .orderedAscending }
}

/// One llama-swap host. URLSession has no same-origin policy, so unlike the web
/// dashboard none of this depends on the server sending CORS headers.
struct LlamaSwapClient {
    let base: URL

    /// Fetches models, running states and version concurrently. Throws only when
    /// the host is unreachable (both `/v1/models` and `/running` failed).
    func poll() async throws -> HostSnapshot {
        async let models: ModelsResponse? = try? get("/v1/models")
        async let running: RunningResponse? = try? get("/running")
        async let version: VersionResponse? = try? get("/api/version")
        async let stats: Stats? = try? get("/api/metrics/stats")
        let (m, r, v, st) = await (models, running, version, stats)
        guard m != nil || r != nil else { throw URLError(.cannotConnectToHost) }
        return HostSnapshot(online: true, version: v?.version ?? "", models: mergeModels(m, r), stats: st,
                            error: r == nil ? "Could not read /running — load status is approximate" : "")
    }

    /// llama-swap starts a model on its first request; its upstream root is the cheapest one.
    func load(_ id: String) async throws {
        var req = URLRequest(url: url("/upstream/\(encode(id))/"))
        req.timeoutInterval = 300   // big models take minutes to load
        _ = try await URLSession.shared.data(for: req)
    }

    func unload(_ id: String) async throws {
        var req = URLRequest(url: url("/api/models/unload/\(encode(id))"))
        req.httpMethod = "POST"
        _ = try await URLSession.shared.data(for: req)
    }

    /// Buffered log history, ANSI colour codes stripped, capped at the last 60k chars.
    func logs() async throws -> String {
        var req = URLRequest(url: url("/logs"))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, _) = try await URLSession.shared.data(for: req)
        let text = String(decoding: data, as: UTF8.self).replacing(/\u{1B}\[[0-9;]*[A-Za-z]/, with: "")
        return String(text.suffix(60_000))
    }

    /// Streams a chat completion as content/reasoning deltas. Ends on `data: [DONE]`
    /// or when the consuming task is cancelled, which also cancels the request.
    func chat(model: String, messages: [(role: String, content: String)]) -> AsyncThrowingStream<ChatDelta, Error> {
        AsyncThrowingStream { cont in
            let task = Task {
                do {
                    var req = URLRequest(url: url("/v1/chat/completions"))
                    req.httpMethod = "POST"
                    req.timeoutInterval = 600   // idle timeout — a cold model can take minutes before its first token
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    let body: [String: Any] = ["model": model, "stream": true,
                                               "messages": messages.map { ["role": $0.role, "content": $0.content] }]
                    req.httpBody = try JSONSerialization.data(withJSONObject: body)
                    let (bytes, resp) = try await URLSession.shared.bytes(for: req)
                    if let code = (resp as? HTTPURLResponse)?.statusCode, code >= 400 {
                        var text = ""
                        for try await line in bytes.lines { text += line }
                        throw ChatError(message: "HTTP \(code): \(text.prefix(300))")
                    }
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        if payload == "[DONE]" { break }
                        guard let d = try? JSONDecoder().decode(ChatChunk.self, from: Data(payload.utf8)).choices.first?.delta else { continue }
                        if let r = d.reasoningContent ?? d.reasoning, !r.isEmpty { cont.yield(.reasoning(r)) }
                        if let c = d.content, !c.isEmpty { cont.yield(.content(c)) }
                    }
                    cont.finish()
                } catch { cont.finish(throwing: error) }
            }
            cont.onTermination = { _ in task.cancel() }
        }
    }

    private func url(_ path: String) -> URL { URL(string: path, relativeTo: base)!.absoluteURL }

    /// Like JS `encodeURIComponent`: percent-encodes `/` too, so a model id never becomes a path.
    private func encode(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(["/"])) ?? id
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var req = URLRequest(url: url(path))
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await URLSession.shared.data(for: req)
        if let code = (resp as? HTTPURLResponse)?.statusCode, code >= 400 { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
