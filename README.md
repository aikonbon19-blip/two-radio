# TWO RADIO

A frequency-dial radio that runs in the browser. Tune your radio to a frequency —
446.03125, 462.56250, 145.50000 — and anyone else tuned to the **same frequency**
hears you. **One person talks at a time**: hold the button, speak, release, listen.
Anyone who keys up while you're transmitting is refused, exactly like a real
walkie-talkie.

### Tuning

| Control | What it does |
| --- | --- |
| **Dial** | Drag left/right to tune. Snaps to preset channels on PMR446/FRS, 5 kHz steps on raw bands. Mouse wheel steps too. |
| **CHANNEL** | Preset channel list (8 PMR446, 14 FRS/GMRS) plus band jumps |
| **KEYPAD** | Type any frequency in MHz and press TUNE |
| **SCAN** | Sweeps 140 frequencies and stops on the first one with an operator on it |
| **LOCK** | Hands-free: tap once to transmit, tap again to stop |
| **SPEAKER** | Mute incoming audio |

Bands: **PMR446** (EU), **FRS/GMRS** (US), **2m calling** (145.400–145.600),
**70cm calling** (433.400–433.600), and a wide **FREE** band (400–470).

Share a frequency by URL: `/#f=446.03125` tunes the radio and joins automatically.

> **About the frequencies.** These numbers are *labels for channels on the
> internet* — this app transmits no radio waves and needs no licence. It does not
> and cannot reach a real walkie-talkie on 446 MHz. Tuning to 446.03125 in this app
> means "everyone else in this app who typed 446.03125" — not the physical PMR
> channel. The preset numbers are real PMR446/FRS channels so the experience matches
> a real radio, and so the same frequency numbers mean something to people who know
> radios.

## Run it

```bash
cd two-radio
npm install
npm start            # http://localhost:3000
```

Open it on two devices (or two tabs) — same channel name, different callsigns.

> **Microphone needs a secure context.** `http://localhost` works, and so does any
> `https://` URL. A bare LAN address like `http://192.168.1.20:3000` will be
> blocked by the browser's mic policy — put it behind HTTPS (Caddy, ngrok,
> Cloudflare Tunnel) or use the platform preview.

## How it works

| Piece | File | Notes |
| --- | --- | --- |
| Static host + WebSocket relay | `server.js` | Node `ws`, one process, no database |
| UI, capture, playback | `public/app.js` | MediaRecorder → 250 ms chunks → `MediaSource` |
| Styling | `public/styles.css` | Mobile-first, safe-area aware, no frameworks |

**Half-duplex is enforced on the server**, not in the UI. A channel has at most
one talker; `audio` frames from anyone who isn't the current talker are dropped,
so a modified client can't talk over the channel. The lock is released by `ptt: off`,
by the browser tab closing, or by a 30 s ping/pong sweep that kills dead sockets.

### Protocol

Client → server: `join {freq}`, `retune {freq}`, `scan {freqs}`, `ptt {on}`,
`audio {seq, data}`, `ping`

Server → client: `welcome`, `tuned`, `members`, `scanResult`, `granted`, `denied`,
`busy`, `free`, `audio`, `pong`

Channels are keyed by canonical frequency string (`446.03125`), so `446.1` and
`446.10000` are the same channel. Legacy `CH-3` still maps to PMR446 channel 3.

Audio is relayed in memory and **never written to disk**. Nothing is recorded.

## Controls

- **Hold** the big button to transmit, release to listen
- **LOCK** puts it in hands-free mode — tap once to start, tap again to stop
- **SPEAKER** mutes incoming audio without leaving the channel
- **CHANNEL** opens the preset list; **KEYPAD** enters a raw frequency
- `Space` works as push-to-talk on desktop
- Link format: `/#f=446.03125` pre-fills and joins that frequency

## Known behaviour

- **iOS Safari** has no `MediaSource` for audio, so playback uses a buffered blob
  fallback: audio arrives in ~0.7 s blocks instead of a continuous stream.
  Chrome/Edge/Firefox/Android stream with much lower latency.
- One server process = one shared set of channels. Running multiple instances
  behind a load balancer would need sticky sessions or a pub/sub bus
  (Redis) — the relay lives in each process's memory.
- No auth. Anyone who tunes to the same frequency joins it, so don't use it for
  anything private without adding a password first.
- Scan sweeps a fixed list, not the whole spectrum. Add ranges in `SCAN_LIST` in
  `public/app.js`; each entry costs ~300 ms per pass.

---

## Opening it in VS Code

```bash
unzip two-radio.zip -d two-radio
cd two-radio
code .
```

Then press **F5** and pick **"TWO RADIO: server + Chrome"** — the server starts in the
integrated terminal and Chrome opens on the app automatically. To hear yourself
talk you need a second client, so either:

- open a normal Chrome window too (drag it to another monitor), or
- run **"TWO RADIO: client in Chrome"** and use that as the second window,
- or just use your phone on the same network (see HTTPS note above).

Debugging the server: put a breakpoint in the `ws.on('message', ...)` switch in
`server.js` — every join, PTT grant and audio frame goes through it. Debugging the
client: F12 in Chrome, or use the "client in Chrome" launch config, which sets the
right `webRoot`.

### Windows / PowerShell

`npm install` and `npm start` behave the same. If port 3000 is taken:

```powershell
$env:PORT=4000; npm start
```

### Handy tasks

`Ctrl+Shift+B` → **Start server** (background, with output in its own panel).
**Start with inspector** binds port 9229, then run the "attach to running server"
launch config if you want the server to keep running between debug sessions.

### Editing tips

- `public/app.js` is one IIFE, no bundler — save and refresh, that's the whole loop.
- The `__TWO_RADIO` object in the console shows live counters: `rx`, `sent`,
  `pushed`, `mime`, `mode` (`mse` or `blob`). Fastest way to tell whether audio is
  arriving but not playing.
- Change `s.seq` / `rec.start(250)` if you want lower latency; below ~150 ms
  browsers start sending tiny fragmented chunks and quality suffers.
- To allow multiple simultaneous talkers (a "conference" mode instead of radio),
  relax the `ch.talker` check in the `audio` case in `server.js`.
