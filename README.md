# Herd

One dashboard for [llama-swap](https://github.com/mostlygeek/llama-swap) across multiple hosts. Shows every host's models in one table with load/unload controls, recent request activity, live logs, and a chat playground for any model on any host.

No build step — a static page using React (UMD) + [htm](https://github.com/developit/htm) from CDN.

## Where this code lives

This is a standalone project, backed up as the [`herd` branch of `prasta1/fork-llama-swap`](https://github.com/prasta1/fork-llama-swap/tree/herd) — an orphan branch that shares no history with llama-swap itself, so the fork's `main` stays pure upstream. Day to day, `git push` from this checkout just works. To get it back on a new machine:

```sh
git clone -b herd https://github.com/prasta1/fork-llama-swap.git the-herd
```

## Run

```sh
python3 -m http.server 8080
```

## Native Mac app

`mac/` holds a SwiftUI port (xcodegen, macOS 14+). It talks to llama-swap with `URLSession`, so it needs no CORS headers and no local web server.

```sh
cd mac && xcodegen generate && open Herd.xcodeproj
```

Hosts persist in `UserDefaults` under the same `herd.hosts.v1` key and JSON shape the web page uses in localStorage. Right-click a host to remove it. Not ported yet: chat, logs, activity table, theming.

Then open http://localhost:8080. (Opening `index.html` directly also works.)

## URL options

| Param | Effect |
|---|---|
| `?demo=1` | Canned data — exercise the UI with no live hosts |
| `?poll=N` | Poll interval in seconds (2–30, default 5) |
| `?activity=0` | Hide the Recent requests section |

## Hosts

A single `localhost:8999` host is seeded on first run; use **Add host** / **Edit** to manage them. The list persists in `localStorage` (`herd.hosts.v1`), so it's per-browser.

If a host shows *Unreachable*, it's offline, Tailscale is down, or the browser blocked the request (CORS). llama-swap must be reachable from the browser and allow cross-origin requests from wherever this page is served.

## llama-swap endpoints used

- `GET /v1/models`, `GET /running` — model list + load states
- `GET /api/metrics/activity?limit=25`, `GET /api/metrics/stats`, `GET /api/version`
- `GET /logs` — logs drawer
- `GET /upstream/<model>/` — touching it loads the model
- `POST /api/models/unload[/<model>]` — unload one or all
- `POST /v1/chat/completions` (streaming) — chat playground
