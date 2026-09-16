import SwiftUI

struct ContentView: View {
    @Environment(Store.self) private var store
    @State private var adding = false

    private struct Row: Identifiable {
        let host: Host
        let model: Model
        var id: String { "\(host.id)|\(model.id)" }
    }

    private var rows: [Row] {
        store.hosts.flatMap { h in (store.data[h.id]?.models ?? []).map { Row(host: h, model: $0) } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            hostBar
            Divider()
            Table(rows) {
                TableColumn("Host") { Text($0.host.name) }.width(min: 80, ideal: 120)
                TableColumn("Model") { row in
                    Text(row.model.name.isEmpty ? row.model.id : row.model.name).help(row.model.id)
                }
                TableColumn("State") { stateTag($0) }.width(100)
                TableColumn("") { actionButton($0) }.width(90)
                TableColumn("") { row in
                    Button("Chat") { store.openChat(row.host, row.model.id) }
                        .disabled(!(store.data[row.host.id]?.online ?? false))
                }.width(60)
            }
            if store.logsHost != nil {
                Divider()
                logsPane
            }
        }
        .inspector(isPresented: Binding(get: { store.chat != nil }, set: { if !$0 { store.closeChat() } })) {
            ChatPanel().inspectorColumnWidth(min: 280, ideal: 380, max: 600)
        }
        .toolbar {
            Button("Refresh", systemImage: "arrow.clockwise") { Task { await store.pollAll() } }
            Button("Add Host", systemImage: "plus") { adding = true }
        }
        .sheet(isPresented: $adding) { AddHostSheet() }
        .navigationTitle("Herd")
        .frame(minWidth: 640, minHeight: 400)
    }

    private var hostBar: some View {
        HStack(spacing: 20) {
            ForEach(store.hosts) { h in
                let d = store.data[h.id]
                HStack(spacing: 6) {
                    Circle().fill(d.map { $0.online ? Color.green : .red } ?? .gray).frame(width: 8, height: 8)
                    Text(h.name).fontWeight(.medium)
                    if let d, d.online {
                        Text("\(d.version) · \(d.models.count) models" + (d.stats.map { " · \($0.totalRequests) req · \(compact($0.totalInputTokens)) in / \(compact($0.totalOutputTokens)) out" } ?? ""))
                            .foregroundStyle(.secondary)
                    }
                    Button("logs") { store.openLogs(h) }.buttonStyle(.link).font(.caption)
                }
                .help(d?.error.isEmpty == false ? d!.error : h.url)
                .contextMenu {
                    Button("Remove \(h.name)", role: .destructive) {
                        store.hosts.removeAll { $0.id == h.id }
                        store.data[h.id] = nil
                    }
                }
            }
            Spacer()
            if let t = store.updatedAt {
                Text("updated \(t, style: .relative) ago").foregroundStyle(.secondary)
            }
        }
        .font(.callout)
        .padding(12)
    }

    private func compact(_ n: Int) -> String { n.formatted(.number.notation(.compactName)) }

    private var logsPane: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Logs · \(store.logsHost?.name ?? "")").font(.callout.weight(.medium))
                Spacer()
                Button("Close") { store.closeLogs() }
            }
            .padding(8)
            ScrollViewReader { proxy in
                ScrollView {
                    Text(store.logsText)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .id("end")
                }
                .onChange(of: store.logsText) { proxy.scrollTo("end", anchor: .bottom) }
            }
        }
        .frame(height: 220)
    }

    private func stateTag(_ row: Row) -> some View {
        let busy = store.pending.contains(row.id)
        let label = busy ? (row.model.state == "ready" ? "unloading" : "loading") : row.model.state
        let color: Color = label == "ready" ? .green : label == "stopped" ? .secondary : .orange
        return Text(label)
            .font(.caption)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private func actionButton(_ row: Row) -> some View {
        let busy = store.pending.contains(row.id)
        let online = store.data[row.host.id]?.online ?? false
        let ready = row.model.state == "ready"
        return Button(busy ? "…" : ready ? "Unload" : "Load") {
            Task { await store.act(row.host, row.model) }
        }
        .disabled(busy || !online || !(ready || row.model.state == "stopped"))
    }
}

struct AddHostSheet: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""

    private var valid: Bool { !name.isEmpty && URL(string: url)?.host != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Add Host").font(.headline)
            TextField("Name", text: $name, prompt: Text("studio"))
            TextField("URL", text: $url, prompt: Text("https://studio.example.ts.net:9292"))
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Add") {
                    store.hosts.append(Host(id: UUID().uuidString, name: name, url: url))
                    Task { await store.pollAll() }
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!valid)
            }
        }
        .padding(20)
        .frame(width: 400)
    }
}

struct ChatPanel: View {
    @Environment(Store.self) private var store

    var body: some View {
        if let chat = store.chat {
            VStack(spacing: 0) {
                HStack(spacing: 4) {
                    Text(chat.model).fontWeight(.medium).lineLimit(1)
                    Text("· \(chat.host.name)").foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(10)
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(chat.messages) { m in
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(m.role).font(.caption).foregroundStyle(.secondary)
                                    if !m.reasoning.isEmpty {
                                        Text(m.reasoning).italic().foregroundStyle(.secondary)
                                    }
                                    Text(m.content.isEmpty && chat.streaming && m.role == "assistant" ? "…" : m.content)
                                }
                                .textSelection(.enabled)
                                .id(m.id)
                            }
                        }
                        .padding(10)
                    }
                    .onChange(of: chat.messages.last?.content) { proxy.scrollTo(chat.messages.last?.id, anchor: .bottom) }
                }
                if !chat.error.isEmpty {
                    Text(chat.error).font(.caption).foregroundStyle(.red).padding(.horizontal, 10)
                }
                Divider()
                HStack {
                    TextField("Message", text: Binding(get: { store.chat?.input ?? "" }, set: { store.chat?.input = $0 }))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { store.sendChat() }
                    Button(chat.streaming ? "Stop" : "Send") { chat.streaming ? store.stopChat() : store.sendChat() }
                }
                .padding(10)
            }
        }
    }
}
