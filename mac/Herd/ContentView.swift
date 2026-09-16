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
            }
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
                        Text("\(d.version) · \(d.models.count) models").foregroundStyle(.secondary)
                    }
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
