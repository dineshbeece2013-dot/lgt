# VideoMeet Pro — Architecture

Full-stack video conferencing with **100% browser-native live translation**.

- **Speech-to-text:** Web Speech API (`SpeechRecognition`) — built into Chrome, Edge, Safari
- **Translation:** Chrome built-in **on-device Translator API** — runs locally, no network calls
- **Text-to-speech:** browser `SpeechSynthesis`
- **Server:** signaling + room management + transcript relay only — **no AI on the server, no API keys**

## System Overview

```
┌────────────────────────────┐        ┌────────────────────────────┐
│      SPEAKER'S BROWSER      │       │     LISTENER'S BROWSER     │
│  ┌───────────────────────┐ │        │  ┌───────────────────────┐ │
│  │ Web Speech API        │ │        │  │ participant-translation│ │
│  │ (SpeechRecognition)   │ │        │  │ → show caption card    │ │
│  │  → final transcript   │ │        │  │ → TTS via SpeechSynthesis│
│  └──────────┬────────────┘ │        │  └───────────▲───────────┘ │
│             ▼              │        │              │             │
│  ┌───────────────────────┐ │        │              │             │
│  │ Chrome on-device      │ │        │              │             │
│  │ Translator API        │ │        │              │             │
│  │ (one translate call   │ │        │              │             │
│  │  per target language) │ │        │              │             │
│  └──────────┬────────────┘ │        │              │             │
└─────────────┼──────────────┘        └──────────────┼─────────────┘
              │ transcript-broadcast                  │ participant-translation
              │ {original, translations{lang:text}}   │ (per-listener language)
              ▼                                       ▲
   ┌────────────────────────────────────────────────────────────┐
   │                SERVER (Node.js + Socket.IO)                 │
   │  • Rooms, passcodes, admin roles (REST + sockets)           │
   │  • WebRTC signaling (offer/answer/ICE relay)                │
   │  • transcript-broadcast → fans out per-participant language │
   │  • Whiteboard / chat / reactions relay                      │
   │  • No AI, no audio processing, no API keys                  │
   └────────────────────────────────────────────────────────────┘
```

## Data Flow: Live Translation

1. **User speaks** — the browser's `SpeechRecognition` (continuous mode, `lang` = speaker's language) produces interim + final results. It auto-restarts after silence.
2. **Final transcript** — the speaker's client collects every target language in the room (its own + each other participant's `translationLanguage`, via the `participants` list).
3. **On-device translation** — for each unique target language, the client calls the Chrome built-in `Translator` API (instances cached per language pair). If a pair is unavailable, the original transcript is delivered as a fallback.
4. **Broadcast** — one `transcript-broadcast` event is emitted with `{ original, translations: { lang: text }, speakerName, speakerLanguage }`.
5. **Server relay** — the server looks up the room and emits `participant-translation` to every *other* participant with the translation in *their* language. The speaker already shows their own transcript locally.
6. **Display + speak** — listeners show the caption card in the Translations panel and speak it via `SpeechSynthesis` (queued; TTS can be toggled).

> WebRTC media (video/audio) flows peer-to-peer and is never relayed through the translation pipeline.

## Component Hierarchy

```
App.js
├─── Home.js            (room list, live status via sockets)
├─── CreateRoom.js      └── LanguageSelector.js
├─── JoinRoom.js        └── LanguageSelector.js
├─── MeetingHistory.js  (localStorage: past meetings + recordings)
└─── VideoCall.js
     ├─── RemoteVideo, Chat Panel, People Panel, Recordings Panel
     ├─── Whiteboard.js (collaborative, socket-synced)
     └─── Translations Panel
          ├─── transcript cards (original + translated)
          ├─── language selectors (speak / hear)
          └─── TTS + auto-translate toggles
```

## State (VideoCall.js)

```
// Translation (browser-native)
- translationEnabled          auto-translate on/off
- translationLanguage         language the user wants to hear
- speakerLanguage             language the user speaks (drives recognition.lang)
- transcriptionResults[]      transcript cards (max 50)
- showTranscriptions          panel visibility
- translationStatus           live status / interim text

// Refs (avoid stale closures in recognizer events)
- recognitionRef              active SpeechRecognition instance
- speechActiveRef             auto-restart flag
- translatorCacheRef          Map "src>dst" → Translator instance
- participantsRef / translationLanguageRef / handleFinalTranscriptRef
```

## API Endpoints (Express)

```
GET    /health                  - health check (status, rooms, uptime)
POST   /api/rooms               - create room
GET    /api/rooms               - list rooms
POST   /api/rooms/:id/verify    - verify passcode + schedule
```

## Socket.io Events (translation-related)

```
Client → Server
transcript-broadcast     speaker's transcript + translations map (relay only)
update-language          change speaker/translation language mid-meeting

Server → Client
participant-translation  { original, translated, targetLanguage, targetLanguageName, speakerName }
room-joined / user-joined / user-left / room-active / room-deleted
offer / answer / ice-candidate / media-state (WebRTC signaling)
new-chat-message / new-reaction / whiteboard-* / admin events
```

## Technology Stack

- **Frontend:** React 19, React Router 6, Socket.IO Client 4, WebRTC, Web Speech API, Chrome built-in Translator API, @jitsi/rnnoise-wasm (AudioWorklet noise suppression)
- **Backend:** Node.js (ESM), Express 5, Socket.IO 4, dotenv — no AI/SDK dependencies

## Security & Privacy

1. **No API keys** — nothing to leak or rotate; the server has no credentials.
2. **Audio never leaves the device** — speech recognition and translation run locally in each browser; only text transcripts are relayed.
3. **Room access** — passcode + optional schedule gating; admin-only removal/meeting-end.
4. **Room persistence** — rooms cached to a temp JSON file to survive restarts on free hosting.

## Browser Support Matrix

| Capability | Chrome/Edge | Safari | Firefox |
|---|---|---|---|
| Video/audio calls | ✅ | ✅ | ✅ |
| Speech recognition (captions) | ✅ | ✅* | ❌ |
| On-device translation | ✅ 138+ | ❌ (falls back to original text) | ❌ |
| Text-to-speech | ✅ | ✅ | ✅ |

\* Safari's speech recognition support is limited; Chrome/Edge recommended.

## Future Enhancements

- [ ] Fallback translation provider for browsers without the built-in Translator
- [ ] Automatic language detection (`LanguageDetector` API) instead of explicit speaker language
- [ ] Translation history export (PDF/CSV)
- [ ] On-device translation model pre-download prompt before meetings

