# VideoMeet Pro

A full-stack video conferencing web app with **real-time speech translation**, built with React and Node.js.

Participants join a room over **WebRTC** peer-to-peer video/audio. Live translation pipeline: speech recognition uses the built-in **Web Speech API** → on-screen subtitles appear at the **bottom of every video tile** like movie captions → text is translated in-browser via Chrome's **on-device Translator API** with a **free no-key fallback** (MyMemory) when the browser doesn't support it → spoken playback uses the browser's **speech synthesis**. **No Groq API keys, no server-side AI, no per-minute cloud costs**.

## Features

- 🎥 HD video calls (WebRTC peer-to-peer, admin/participant roles)
- 🌐 Real-time speech translation with live subtitles at the bottom of every video tile (browser-native Web Speech API → on-device/native translation → speech synthesis)
- 🎙️ AI noise suppression (RNNoise via WebAssembly)
- 👑 Admin controls — remove participants, end meeting for everyone
- 💬 In-meeting chat, emoji reactions, raised hands
- 📝 Collaborative whiteboard (synced across participants)
- 🖥️ Screen sharing & in-browser meeting recordings
- 📋 Scheduled meetings with room IDs + passcodes, meeting history

## Tech Stack

| Layer | Technology |
|---|---|
| Client | React 19 (Create React App), React Router 6, Socket.IO client, WebRTC, Web Speech API, Chrome built-in Translator API, @jitsi/rnnoise-wasm |
| Server | Node.js (ESM), Express 5, Socket.IO 4 — signaling/relay only, no AI dependencies |
| Speech → text | Browser Web Speech API (`SpeechRecognition`) — built into Chrome/Edge/Safari |
| Translation | Chrome on-device Translator API (primary) + free MyMemory API fallback (no key) |
| Deployment (optional) | Docker Compose, Render (`render.yaml`) |

## Project Structure

```
lgt/
├── client/                  # React frontend (CRA)
│   ├── public/              # Static assets (incl. noise-suppression AudioWorklet)
│   └── src/
│       ├── components/      # Home, CreateRoom, JoinRoom, VideoCall, Whiteboard, ...
│       ├── hooks/           # useNoiseSuppression, useRipple, useScrollReveal
│       ├── App.js           # Routes
│       └── config.js        # API/socket URL configuration per environment
├── server/
│   ├── index.js             # Express + Socket.IO server (signaling, rooms, transcript relay)
│   ├── test-server.js       # Quick API smoke test (node test-server.js)
│   ├── .env.example         # Sample environment file
│   └── package.json
├── docker-compose.yml       # Optional: run server + client (nginx) in Docker
├── render.yaml              # Optional: one-click Render deployment
└── ARCHITECTURE.md          # Detailed architecture notes
```

## Prerequisites

- **Node.js 18+** (20 LTS recommended) — https://nodejs.org
- **npm 9+** (ships with Node)
- **No API keys required** — speech recognition and translation run in the browser.
- **Browser support:** speech recognition (STT) works in Chrome, Edge and Safari; **translation additionally requires Chrome or Edge 138+** (built-in on-device Translator API). **In browsers that lack the Translator API, a free no-key fallback (MyMemory) is used automatically** so subtitles always translate. In all browsers, live captions (original + translated) appear at the bottom of every video tile.**
- A webcam + microphone.

---

## Run Locally (Development)

### 1. Install dependencies

From the project root:

```bash
npm run install-all
```

This runs `npm install` in both `server/` and `client/`.

### 2. (Optional) Configure the server environment

The server needs no credentials. To override the port, copy the sample env file:

```bash
# from the project root (PowerShell)
Copy-Item server\.env.example server\.env
# (macOS/Linux: cp server/.env.example server/.env)
```

### 3. Start the backend (port 5001)

```bash
npm run server
# or: cd server && npm start
```

You should see:

```
🚀 Server running on port 5001
🎤 Live translation: browser speech recognition + on-device translation (no API keys)
```

### 4. Start the frontend (port 3000)

In a second terminal, from the project root:

```bash
npm run client
# or: cd client && npm start
```

The React dev server starts at **http://localhost:3000** and connects to the backend at `http://localhost:5001` (configured automatically in `client/src/config.js` for localhost).

### 5. Use the app

1. Open **http://localhost:3000**
2. Click **Create Meeting**, fill the form (name, room ID — or click *Generate* — passcode, schedule), pick your spoken language and the language you want to hear, and create the room. You join as **Admin**.
3. In another browser/window/profile, open the same URL, click **Join Meeting** (or use a room card on the home page), enter the room ID + passcode, and join as a **Participant**.
4. In-meeting: toggle mic/camera, share your screen, chat, use the whiteboard, and enable **translation** — speak, and others receive the live transcription + translated speech in their chosen language.

> Allow microphone/camera permissions when the browser prompts. For testing translation, two devices on the same network work best (a single machine mutes/echoes).

---

## Run Locally with Docker (optional)

Builds the client into an nginx container and runs the server container — no environment variables needed:

```bash
docker compose up --build
```

- Server: http://localhost:5001
- Client: http://localhost:3000 (nginx serves the production build)

To point the client build at a backend other than `http://localhost:5001`, set `REACT_APP_SIGNALING_SERVER` before building (see `docker-compose.yml`).

---

## Configuration Reference

### Server (`server/.env` — all optional)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5001` | HTTP + Socket.IO port |
| `NODE_ENV` | `development` | Node environment |

No API keys are needed — speech recognition and translation happen entirely in participants' browsers.

### Client (`client/src/config.js`)

- On `localhost` / `127.0.0.1` → uses `http://localhost:5001`.
- Anywhere else → uses the production URL baked into the build.
- Override the backend URL at build time with `REACT_APP_SIGNALING_SERVER`, e.g.:

```bash
REACT_APP_SIGNALING_SERVER=http://192.168.1.10:5001 npm run build
```

### CORS

`server/index.js` allows `http://localhost:3000`, `http://localhost:3001`, the deployed Render origins, and any `*.ngrok.io` / `ngrok-free.app` / `ngrok-free.dev` tunnel. Add your own origin to `ALLOWED_ORIGINS` if you host the client elsewhere.

---

## Production Build (local test)

```bash
npm run build           # creates client/build/
cd server && npm start  # backend on :5001
```

Serve `client/build` with any static server, e.g.:

```bash
npx serve -s ../client/build -l 3000
```

> Use HTTPS (or ngrok) in production-like testing — browsers only grant camera/mic access on secure origins (localhost is exempt).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Port 5001 already in use` | Stop the other process or set `PORT` in `server/.env`, then update `client/src/config.js` |
| "Speech recognition not supported" | Use Chrome, Edge or Safari — Firefox doesn't implement the Web Speech API |
| Captions appear but aren't translated | Translation tries the Chrome on-device Translator API first, then falls back to a free MyMemory endpoint. Check the browser console for `Translation … failed` warnings — some rare language pairs may not be available on either service. Use a Chromium browser for best results  
| Camera/mic not working | Grant browser permissions; use `localhost` or HTTPS |
| `Room not found` when joining | Rooms live in server memory (plus a temp-file cache); make sure the same server instance is running |
| Client can't reach server | Check the URLs logged in the browser console by `client/src/config.js` |

Quick backend smoke test (server must be running):

```bash
cd server && node test-server.js
```

---

## Deploying (optional)

- **Render**: `render.yaml` in the repo root defines a static site (client) + web service (server). No secrets to configure.
- **Docker anywhere**: `docker-compose.yml` builds both services; expose 5001 (server) and 3000 (client).

## License

ISC



