import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";

dotenv.config();

const app = express();

// Always allow both local dev and Render/ngrok production origins
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3001',
  '${client_url}',
  'https://video-meet-client.onrender.com',
  'https://video-meet-aj54.onrender.com',
  'https://lgt-2.onrender.com',
  'https://lgt-3.onrender.com'
];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    // Allow any ngrok tunnel (for frontend dev/demo via ngrok)
    if (origin.includes('ngrok-free.dev') || origin.includes('ngrok-free.app') || origin.includes('ngrok.io')) {
      return callback(null, true);
    }
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '50mb' }));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin.includes('ngrok-free.dev') || origin.includes('ngrok-free.app') || origin.includes('ngrok.io')) {
        return callback(null, true);
      }
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      callback(new Error(`CORS blocked: ${origin}`));
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  // Increase limits for audio data
  maxHttpBufferSize: 10 * 1024 * 1024 // 10MB
});

// Use OS temp directory for room persistence (works on Render and locally)
const TEMP_DIR = os.tmpdir();

// ── Persistent room storage ──────────────────────────────────────────────────
// Rooms are saved to a JSON file so they survive server restarts (Render free
// tier spins down after inactivity and wipes in-memory state).
const ROOMS_FILE = path.join(TEMP_DIR, 'vm_rooms.json');

const loadRooms = () => {
  try {
    if (fs.existsSync(ROOMS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      const map = new Map();
      data.forEach(r => map.set(r.id, r));
      console.log(`📂 Loaded ${map.size} rooms from disk`);
      return map;
    }
  } catch (e) {
    console.error('⚠️ Could not load rooms from disk:', e.message);
  }
  return new Map();
};

const saveRooms = () => {
  try {
    const data = Array.from(rooms.values()).map(r => ({
      id: r.id,
      roomName: r.roomName || `${r.creatorName}'s Meeting`,
      passcode: r.passcode,
      creatorName: r.creatorName,
      creatorEmail: r.creatorEmail,
      meetingDate: r.meetingDate,
      meetingTime: r.meetingTime,
      meetingEndTime: r.meetingEndTime || null,
      isActive: r.isActive || false,
      adminId: r.adminId,
      participants: [],        // don't persist live socket state
      chatMessages: [],
      reactions: [],
      raisedHands: [],
      whiteboardStrokes: [],
      createdAt: r.createdAt
    }));
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('⚠️ Could not save rooms to disk:', e.message);
  }
};

// Store rooms and their participants
const rooms = loadRooms();
const userSockets = new Map();

// Health check endpoint (keeps Render service alive)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    translation: 'browser-native (Web Speech API + Chrome built-in Translator)',
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

// Room management endpoints
// Store auto-end timers per room
const roomEndTimers = new Map();

const scheduleRoomEnd = (roomId, meetingDate, meetingEndTime) => {
  if (!meetingDate || !meetingEndTime) return;
  try {
    const endDateTime = new Date(`${meetingDate}T${meetingEndTime}:00`);
    const now = new Date();
    const msUntilEnd = endDateTime - now;
    if (msUntilEnd <= 0) return; // already past
    console.log(`⏰ Room ${roomId} will auto-end in ${Math.round(msUntilEnd/60000)} minutes`);
    const timer = setTimeout(() => {
      const room = rooms.get(roomId);
      if (!room) return;
      console.log(`⏰ Auto-ending room ${roomId} at scheduled time`);
      io.to(roomId).emit('meeting-ended', {
        reason: 'Scheduled end time reached',
        message: 'The meeting has ended as scheduled by the host.'
      });
      room.participants.forEach(p => { userSockets.delete(p.id); });
      rooms.delete(roomId);
      roomEndTimers.delete(roomId);
      io.emit('room-deleted', { id: roomId });
    }, msUntilEnd);
    roomEndTimers.set(roomId, timer);
  } catch (e) {
    console.error('Error scheduling room end:', e);
  }
};

app.post('/api/rooms', (req, res) => {
  const { creatorName, creatorEmail, roomId, passcode, meetingDate, meetingTime, meetingEndTime, roomName } = req.body;
  
  console.log('📥 Room creation request:', { roomId, creatorName, creatorEmail });
  
  if (rooms.has(roomId)) {
    console.log(`❌ Room ${roomId} already exists`);
    return res.status(400).json({ error: 'Room ID already exists' });
  }
  
  const room = {
    id: roomId,
    roomName: roomName || `${creatorName}'s Meeting`,
    passcode,
    creatorName,
    creatorEmail,
    meetingDate,
    meetingTime,
    meetingEndTime: meetingEndTime || null,
    adminId: null,
    isActive: false,
    participants: [],
    chatMessages: [],
    reactions: [],
    raisedHands: [],
    createdAt: new Date().toISOString()
  };
  
  rooms.set(roomId, room);

  // Persist to disk so rooms survive server restarts
  saveRooms();

  // Broadcast to all connected home-page clients so Upcoming Meetings updates instantly
  io.emit('room-created', {
    id: room.id,
    roomName: room.roomName,
    creatorName: room.creatorName,
    meetingDate: room.meetingDate,
    meetingTime: room.meetingTime,
    meetingEndTime: room.meetingEndTime || null,
    isActive: false,
    participantCount: 0,
    createdAt: room.createdAt
  });

  // Schedule auto-end if end time provided
  if (meetingEndTime) {
    scheduleRoomEnd(roomId, meetingDate, meetingEndTime);
  }

  console.log(`✅ Room created: ${roomId} by ${creatorName}`);
  console.log(`📊 Total rooms in memory: ${rooms.size}`);
  res.json({ success: true, room });
});

app.get('/api/rooms', (req, res) => {
  console.log('📋 Listing all rooms');
  const roomList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    roomName: room.roomName || `${room.creatorName}'s Meeting`,
    creatorName: room.creatorName,
    meetingDate: room.meetingDate,
    meetingTime: room.meetingTime,
    meetingEndTime: room.meetingEndTime || null,
    isActive: room.isActive || false,
    participantCount: room.participants.length,
    createdAt: room.createdAt
  }));
  console.log(`📊 Total rooms: ${roomList.length}`);
  res.json(roomList);
});

app.post('/api/rooms/:roomId/verify', (req, res) => {
  const { roomId } = req.params;
  const { passcode } = req.body;
  
  console.log(`🔍 Room verification request for: ${roomId}`);
  console.log(`📊 Available rooms: ${Array.from(rooms.keys()).join(', ') || 'none'}`);
  
  const room = rooms.get(roomId);
  if (!room) {
    console.log(`❌ Room ${roomId} not found`);
    return res.status(404).json({ error: 'Room not found' });
  }
  
  if (room.passcode !== passcode) {
    console.log(`❌ Invalid passcode for room ${roomId}`);
    return res.status(401).json({ error: 'Invalid passcode' });
  }

  // Check if meeting has started (optional - allow early join by default)
  // Uncomment to enforce strict start time:
  // if (room.meetingDate && room.meetingTime) {
  //   try {
  //     const startDt = new Date(`${room.meetingDate}T${room.meetingTime}:00`);
  //     const now = new Date();
  //     if (now < startDt) {
  //       const minutesUntil = Math.ceil((startDt - now) / 60000);
  //       return res.status(403).json({ 
  //         error: `Meeting hasn't started yet. Starts in ${minutesUntil} minute(s).`,
  //         startsAt: startDt.toISOString()
  //       });
  //     }
  //   } catch (e) {
  //     console.error('Error parsing meeting time:', e);
  //   }
  // }
  
  console.log(`✅ Room ${roomId} verified successfully`);
  res.json({ 
    success: true,
    room: {
      id: room.id,
      creatorName: room.creatorName,
      meetingDate: room.meetingDate,
      meetingTime: room.meetingTime,
      meetingEndTime: room.meetingEndTime
    }
  });
});

io.on("connection", socket => {
  console.log(`🔗 User connected: ${socket.id}`);

  // ── Live transcripts (browser-native) ──────────────────────────────────────
  // The speaker's browser does speech recognition (Web Speech API) and
  // translation (Chrome built-in on-device Translator API), then sends the
  // translated text for every room language here. The server only relays
  // results to the right participants — no AI runs on the server.
  const LANGUAGE_NAMES = {
    'en': 'English', 'es': 'Spanish', 'fr': 'French', 'de': 'German',
    'it': 'Italian', 'pt': 'Portuguese', 'ru': 'Russian', 'ja': 'Japanese',
    'ko': 'Korean', 'zh': 'Chinese', 'ar': 'Arabic', 'hi': 'Hindi',
    'tr': 'Turkish', 'nl': 'Dutch', 'pl': 'Polish',
    'ta': 'Tamil', 'te': 'Telugu', 'ml': 'Malayalam', 'kn': 'Kannada'
  };

  socket.on('transcript-broadcast', ({ original, translations, speakerName, speakerLanguage }) => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) return;
    const room = rooms.get(userInfo.roomId);
    if (!room) return;

    const text = typeof original === 'string' ? original.trim() : '';
    if (!text) return;

    const sender = room.participants.find(p => p.id === socket.id);
    const name = speakerName || (sender && sender.name) || 'Unknown';

    console.log(`🌐 Transcript from ${name} (${userInfo.roomId}): "${text}"`);

    room.participants.forEach(participant => {
      // Skip the sender — they already show their own transcript locally
      if (participant.id === socket.id) return;

      const targetLang = participant.translationLanguage || 'en';
      // Fallback: if the pair is missing (e.g. model unavailable on the
      // speaker's device), deliver the original transcript instead
      const translated =
        (translations && typeof translations[targetLang] === 'string' && translations[targetLang]) || text;

            const participantSocket = io.sockets.sockets.get(participant.id);
      if (participantSocket) {
        participantSocket.emit('participant-translation', {
          original: text,
          translated,
          targetLanguage: targetLang,
          targetLanguageName: LANGUAGE_NAMES[targetLang] || targetLang,
          speakerName: name,
          speakerLanguage: speakerLanguage || null,
          speakerId: socket.id,                               // so listeners can match to the right video tile
          speakerLanguageName: LANGUAGE_NAMES[speakerLanguage] || speakerLanguage   // human-readable source language
        });
      }
    });
  });

  socket.on('join-room', ({ roomId, passcode, participantName, participantEmail, isHost, translationLanguage, speakerLanguage }) => {
    console.log(`👤 ${participantName} (${socket.id}) attempting to join room ${roomId} as ${isHost ? 'ADMIN' : 'PARTICIPANT'} with translation: ${translationLanguage || 'none'}`);
    
    const room = rooms.get(roomId);
    
    if (!room) {
      console.log(`❌ Room ${roomId} not found`);
      socket.emit('error', 'Room not found');
      return;
    }
    
    if (room.passcode !== passcode) {
      console.log(`❌ Invalid passcode for room ${roomId}`);
      socket.emit('error', 'Invalid passcode');
      return;
    }
    
    // Check if user is already in room (prevent duplicates by socket ID)
    const existingParticipant = room.participants.find(p => p.id === socket.id);
    if (existingParticipant) {
      console.log(`⚠️ User ${socket.id} already in room ${roomId}, sending existing room state`);
      const existingParticipants = room.participants.filter(p => p.id !== socket.id);
      socket.emit('room-joined', {
        room: {
          id: room.id,
          creatorName: room.creatorName,
          adminId: room.adminId,
          participants: existingParticipants,
          chatMessages: room.chatMessages || [],
          raisedHands: room.raisedHands || [],
          whiteboardStrokes: room.whiteboardStrokes || []
        },
        isAdmin: existingParticipant.isAdmin
      });
      return;
    }

    // Check for reconnect by name — update socket ID instead of rejecting
    const reconnecting = room.participants.find(p => p.name === participantName && p.email === participantEmail && p.id !== socket.id);
    if (reconnecting) {
      console.log(`🔄 Participant ${participantName} reconnecting — updating socket ID from ${reconnecting.id} to ${socket.id}`);
      const oldId = reconnecting.id;
      reconnecting.id = socket.id;
      if (room.adminId === oldId) room.adminId = socket.id;
      userSockets.delete(oldId);
      userSockets.set(socket.id, { roomId, participant: reconnecting });
      socket.join(roomId);
      const existingParticipants = room.participants.filter(p => p.id !== socket.id);
      socket.emit('room-joined', {
        room: {
          id: room.id,
          creatorName: room.creatorName,
          adminId: room.adminId,
          participants: existingParticipants,
          chatMessages: room.chatMessages || [],
          raisedHands: room.raisedHands || [],
          whiteboardStrokes: room.whiteboardStrokes || []
        },
        isAdmin: reconnecting.isAdmin
      });
      socket.to(roomId).emit('user-joined', reconnecting);
      return;
    }
    
    // Set admin if this is the host joining
    if (isHost && !room.adminId) {
      room.adminId = socket.id;
      room.isActive = true;
      console.log(`👑 ${participantName} is now the admin of room ${roomId}`);
      // Broadcast to all home-page clients that this room is now active
      io.emit('room-active', { id: roomId, isActive: true, participantCount: room.participants.length + 1 });
    }
    
    // Add participant to room with translation language
    const participant = {
      id: socket.id,
      name: participantName,
      email: participantEmail,
      isAdmin: isHost || socket.id === room.adminId,
      isVideoEnabled: true,
      isAudioEnabled: true,
      isScreenSharing: false,
      hasRaisedHand: false,
      translationLanguage: translationLanguage || 'en', // Store user's preferred language
      speakerLanguage: speakerLanguage || 'en',          // Language user speaks in (for speech recognition)
      joinedAt: new Date().toISOString()
    };
    
    room.participants.push(participant);
    userSockets.set(socket.id, { roomId, participant });
    
    socket.join(roomId);
    
    // Get ONLY existing participants (excluding the new one)
    const existingParticipants = room.participants.filter(p => p.id !== socket.id);
    
    console.log(`✅ ${participantName} joined room ${roomId}`);
    console.log(`📊 Room ${roomId} participants: ${room.participants.map(p => `${p.name}${p.isAdmin ? '(ADMIN)' : ''}`).join(', ')}`);
    console.log(`📊 Existing participants for new user: ${existingParticipants.map(p => p.name).join(', ')}`);
    console.log(`📊 Total room participants: ${room.participants.length}`);
    
    // Send room info with ONLY existing participants to the new user
    socket.emit('room-joined', {
      room: {
        id: room.id,
        creatorName: room.creatorName,
        adminId: room.adminId,
        participants: existingParticipants, // CRITICAL: Only existing participants
        chatMessages: room.chatMessages || [],
        raisedHands: room.raisedHands || [],
        whiteboardStrokes: room.whiteboardStrokes || []
      },
      isAdmin: participant.isAdmin
    });
    
    // Notify ONLY existing participants about new user
    socket.to(roomId).emit('user-joined', participant);
    
    // Broadcast updated participant count to all users in room
    const totalCount = room.participants.length;
    io.to(roomId).emit('participant-count-updated', { count: totalCount });
    
    console.log(`📊 Broadcasting participant count: ${totalCount} to room ${roomId}`);
  });

  // WebRTC signaling events
  socket.on('offer', ({ offer, targetId }) => {
    console.log(`📤 Relaying OFFER from ${socket.id} to ${targetId}`);
    socket.to(targetId).emit('offer', { offer, senderId: socket.id });
  });
  
  socket.on('answer', ({ answer, targetId }) => {
    console.log(`📥 Relaying ANSWER from ${socket.id} to ${targetId}`);
    socket.to(targetId).emit('answer', { answer, senderId: socket.id });
  });
  
  socket.on('ice-candidate', ({ candidate, targetId }) => {
    console.log(`🧊 Relaying ICE candidate from ${socket.id} to ${targetId}`);
    socket.to(targetId).emit('ice-candidate', { candidate, senderId: socket.id });
  });

  // Admin-only actions
  socket.on('admin-remove-participant', ({ participantId }) => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) {
      console.log(`❌ No user info found for admin ${socket.id}`);
      return;
    }
    
    const { roomId } = userInfo;
    const room = rooms.get(roomId);
    
    if (!room || room.adminId !== socket.id) {
      console.log(`❌ Unauthorized remove attempt by ${socket.id}`);
      socket.emit('error', 'Only admin can remove participants');
      return;
    }
    
    const participantToRemove = room.participants.find(p => p.id === participantId);
    if (!participantToRemove) {
      console.log(`❌ Participant ${participantId} not found in room ${roomId}`);
      return;
    }
    
    console.log(`👑 Admin ${socket.id} removing participant ${participantId} (${participantToRemove.name})`);
    
    // First, remove from room data structures
    room.participants = room.participants.filter(p => p.id !== participantId);
    room.raisedHands = room.raisedHands.filter(h => h.participantId !== participantId);
    userSockets.delete(participantId);
    
    // Force disconnect the participant with immediate cleanup
    const participantSocket = io.sockets.sockets.get(participantId);
    if (participantSocket) {
      // Send force disconnect message
      participantSocket.emit('force-disconnect', { 
        reason: 'Removed by admin',
        message: 'You have been removed from the meeting by the host.'
      });
      
      // Force leave the room
      participantSocket.leave(roomId);
      
      // Disconnect the socket after a brief delay
      setTimeout(() => {
        if (participantSocket.connected) {
          participantSocket.disconnect(true);
        }
      }, 1000);
    }
    
    // Immediately notify all remaining participants about removal
    io.to(roomId).emit('participant-removed', { 
      participantId, 
      participantName: participantToRemove.name,
      removedBy: userInfo.participant.name
    });
    
    // Update participant count for all remaining users
    io.to(roomId).emit('participant-count-updated', { count: room.participants.length });
    
    console.log(`✅ Participant ${participantToRemove.name} successfully removed from room ${roomId}`);
    console.log(`📊 Remaining participants: ${room.participants.length}`);
  });

  socket.on('admin-end-meeting', () => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) {
      console.log(`❌ No user info found for admin ${socket.id}`);
      return;
    }
    
    const { roomId } = userInfo;
    const room = rooms.get(roomId);
    
    if (!room || room.adminId !== socket.id) {
      console.log(`❌ Unauthorized end meeting attempt by ${socket.id}`);
      socket.emit('error', 'Only admin can end the meeting');
      return;
    }
    
    console.log(`👑 Admin ${socket.id} ending meeting for room ${roomId}`);
    
    // Notify all participants that meeting is ending
    io.to(roomId).emit('meeting-ended', {
      reason: 'Meeting ended by host',
      message: 'The meeting has been ended by the host.',
      endedBy: userInfo.participant.name
    });
    
    // Force disconnect all participants
    room.participants.forEach(participant => {
      if (participant.id !== socket.id) {
        const participantSocket = io.sockets.sockets.get(participant.id);
        if (participantSocket) {
          participantSocket.leave(roomId);
          setTimeout(() => {
            if (participantSocket.connected) {
              participantSocket.disconnect(true);
            }
          }, 2000);
        }
      }
      userSockets.delete(participant.id);
    });
    
    // Clean up room
    rooms.delete(roomId);
    if (roomEndTimers.has(roomId)) { clearTimeout(roomEndTimers.get(roomId)); roomEndTimers.delete(roomId); }
    saveRooms();
    io.emit('room-deleted', { id: roomId });
    console.log(`🗑️ Room ${roomId} deleted by admin`);
  });

  // Media control events
  socket.on('toggle-video', ({ isEnabled }) => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId } = userInfo;
      const room = rooms.get(roomId);
      if (room) {
        const participant = room.participants.find(p => p.id === socket.id);
        if (participant) {
          participant.isVideoEnabled = isEnabled;
          socket.to(roomId).emit('participant-video-toggle', { 
            participantId: socket.id, 
            isEnabled 
          });
        }
      }
    }
  });

  socket.on('toggle-audio', ({ isEnabled }) => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId } = userInfo;
      const room = rooms.get(roomId);
      if (room) {
        const participant = room.participants.find(p => p.id === socket.id);
        if (participant) {
          participant.isAudioEnabled = isEnabled;
          socket.to(roomId).emit('participant-audio-toggle', { 
            participantId: socket.id, 
            isEnabled 
          });
        }
      }
    }
  });

  // Chat functionality
  socket.on('send-chat-message', ({ message }) => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId, participant } = userInfo;
      const room = rooms.get(roomId);
      if (room) {
        const chatMessage = {
          id: Date.now(),
          senderId: socket.id,
          senderName: participant.name,
          message,
          timestamp: new Date().toISOString()
        };
        
        room.chatMessages.push(chatMessage);
        io.to(roomId).emit('new-chat-message', chatMessage);
      }
    }
  });

  // Reactions
  socket.on('send-reaction', ({ reaction }) => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId, participant } = userInfo;
      const reactionData = {
        id: Date.now(),
        senderId: socket.id,
        senderName: participant.name,
        reaction,
        timestamp: new Date().toISOString()
      };
      
      io.to(roomId).emit('new-reaction', reactionData);
    }
  });

  // Raise hand
  socket.on('toggle-raise-hand', ({ isRaised }) => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId, participant } = userInfo;
      const room = rooms.get(roomId);
      if (room) {
        const roomParticipant = room.participants.find(p => p.id === socket.id);
        if (roomParticipant) {
          roomParticipant.hasRaisedHand = isRaised;
          
          if (isRaised) {
            room.raisedHands.push({
              participantId: socket.id,
              participantName: participant.name,
              timestamp: new Date().toISOString()
            });
          } else {
            room.raisedHands = room.raisedHands.filter(h => h.participantId !== socket.id);
          }
          
          io.to(roomId).emit('participant-hand-toggle', { 
            participantId: socket.id, 
            isRaised,
            participantName: participant.name
          });
        }
      }
    }
  });

  // Update participant language during meeting
  socket.on('update-language', ({ translationLanguage, speakerLanguage }) => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) return;
    const { roomId, participant } = userInfo;
    const room = rooms.get(roomId);
    if (!room) return;
    
    const roomParticipant = room.participants.find(p => p.id === socket.id);
    if (roomParticipant) {
      if (translationLanguage) {
        roomParticipant.translationLanguage = translationLanguage;
        console.log(`🌐 ${participant.name} changed translation language to: ${translationLanguage}`);
      }
      if (speakerLanguage) {
        roomParticipant.speakerLanguage = speakerLanguage;
        console.log(`🎤 ${participant.name} changed speaker language to: ${speakerLanguage}`);
      }
    }
  });

  // Collaborative whiteboard
  socket.on('whiteboard-draw', (data) => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) return;
    const { roomId } = userInfo;
    const room = rooms.get(roomId);
    if (!room) return;
    // Persist strokes so late joiners get the full board
    if (!room.whiteboardStrokes) room.whiteboardStrokes = [];
    room.whiteboardStrokes.push(data);
    // Broadcast to everyone else in the room
    socket.to(roomId).emit('whiteboard-draw', data);
  });

  socket.on('whiteboard-clear', () => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) return;
    const { roomId } = userInfo;
    const room = rooms.get(roomId);
    if (!room) return;
    room.whiteboardStrokes = [];
    io.to(roomId).emit('whiteboard-clear');
  });

  // Cursor position broadcast (whiteboard)
  socket.on('whiteboard-cursor', (data) => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) return;
    const { roomId } = userInfo;
    socket.to(roomId).emit('whiteboard-cursor', { socketId: socket.id, ...data });
  });

  socket.on('whiteboard-cursor-leave', () => {
    const userInfo = userSockets.get(socket.id);
    if (!userInfo) return;
    const { roomId } = userInfo;
    socket.to(roomId).emit('whiteboard-cursor-leave', { socketId: socket.id });
  });

  // Get room stats
  socket.on('get-room-stats', () => {
    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId } = userInfo;
      const room = rooms.get(roomId);
      if (room) {
        const stats = {
          totalParticipants: room.participants.length,
          chatMessages: room.chatMessages.length,
          raisedHands: room.raisedHands.length,
          videoEnabled: room.participants.filter(p => p.isVideoEnabled).length,
          audioEnabled: room.participants.filter(p => p.isAudioEnabled).length,
          roomDuration: Date.now() - new Date(room.createdAt).getTime()
        };
        
        socket.emit('room-stats', stats);
      }
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);

    const userInfo = userSockets.get(socket.id);
    if (userInfo) {
      const { roomId, participant } = userInfo;
      const room = rooms.get(roomId);
      
      if (room) {
        const initialCount = room.participants.length;
        
        // Check if admin is leaving
        if (room.adminId === socket.id) {
          console.log(`👑 Admin ${participant.name} left room ${roomId} - ENDING MEETING FOR ALL`);
          
          // Notify all participants that admin left and meeting is ending
          socket.to(roomId).emit('meeting-ended', {
            reason: 'Admin left the meeting',
            message: 'The meeting has ended because the host left.'
          });
          
          // Clean up all participants
          room.participants.forEach(p => {
            if (p.id !== socket.id) {
              userSockets.delete(p.id);
            }
          });
          
          // Delete the room
          rooms.delete(roomId);
          if (roomEndTimers.has(roomId)) { clearTimeout(roomEndTimers.get(roomId)); roomEndTimers.delete(roomId); }
          saveRooms();
          io.emit('room-deleted', { id: roomId });
          console.log(`🗑️ Room ${roomId} deleted - Admin left`);
        } else {
          // Regular participant leaving
          room.participants = room.participants.filter(p => p.id !== socket.id);
          room.raisedHands = room.raisedHands.filter(h => h.participantId !== socket.id);
          
          // Notify other participants
          socket.to(roomId).emit('user-left', socket.id);
          io.to(roomId).emit('participant-count-updated', { count: room.participants.length });
          
          console.log(`👋 ${participant.name} left room ${roomId}`);
          console.log(`📊 Participants before: ${initialCount}, after: ${room.participants.length}`);
          
          // Clean up empty rooms
          if (room.participants.length === 0) {
            if (roomEndTimers.has(roomId)) { clearTimeout(roomEndTimers.get(roomId)); roomEndTimers.delete(roomId); }
            rooms.delete(roomId);
            saveRooms();
            io.emit('room-deleted', { id: roomId });
            console.log(`🗑️ Room ${roomId} deleted (empty)`);
          }
        }
      }
      
      userSockets.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 5001;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log("📹 WebRTC signaling server ready - ADMIN PRIVILEGES ENABLED");
  console.log("🎤 Live translation: browser speech recognition + on-device translation (no API keys)");
  console.log("👑 Admin can remove participants and end meetings");
  console.log("💬 Chat and reactions enabled");
  console.log("🖐️ Raise hand functionality enabled");
  console.log("📊 Room statistics enabled");
});