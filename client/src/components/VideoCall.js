import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import io from 'socket.io-client';
import { SOCKET_URL } from '../config';
import LanguageSelector, { SUPPORTED_LANGUAGES } from './LanguageSelector';
import { useNoiseSuppression } from '../hooks/useNoiseSuppression';
import Whiteboard from './Whiteboard';
import './VideoCall.css';

// Browser speech locales for the Web Speech API (STT) and TTS
const SPEECH_LOCALES = {
  'en': 'en-US', 'ta': 'ta-IN', 'hi': 'hi-IN', 'te': 'te-IN', 'ml': 'ml-IN', 'kn': 'kn-IN',
  'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE', 'it': 'it-IT', 'pt': 'pt-PT', 'ru': 'ru-RU',
  'ja': 'ja-JP', 'ko': 'ko-KR', 'zh': 'zh-CN', 'ar': 'ar-SA', 'tr': 'tr-TR', 'nl': 'nl-NL', 'pl': 'pl-PL'
};

const getLanguageName = (code) =>
  (SUPPORTED_LANGUAGES.find(l => l.code === code) || {}).name || code;

// Browser-native speech recognition (Chrome/Edge/Safari)
const SpeechRecognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

function VideoCall() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  
  // Log configuration on component mount
  useEffect(() => {
    console.log('🎥 VideoCall component loaded');
    console.log('🔌 Socket URL:', SOCKET_URL);
  }, []);
  
  // State management
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState(new Map());
  const [localStream, setLocalStream] = useState(null);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [roomInfo, setRoomInfo] = useState(null);
  const [error, setError] = useState('');
  const [connectionStatus, setConnectionStatus] = useState('Connecting...');
  const [isAdmin, setIsAdmin] = useState(false);
  const [participantCount, setParticipantCount] = useState(0);
  const [showAudioWarning, setShowAudioWarning] = useState(false);
  const [audioDevices, setAudioDevices] = useState([]);
  
  // Translation state (browser-native: Web Speech API + Chrome built-in Translator)
  const [translationEnabled, setTranslationEnabled] = useState(false);
  const [translationLanguage, setTranslationLanguage] = useState('es');
  const [speakerLanguage, setSpeakerLanguage] = useState('en'); // language the user speaks in
  const [transcriptionResults, setTranscriptionResults] = useState([]);
  const [showTranscriptions, setShowTranscriptions] = useState(false);
  const speakerLanguageRef = useRef('en'); // always holds latest speaker language for recognition closure
    const [translationStatus, setTranslationStatus] = useState(''); // Status message for the translation panel

  // Live caption subtitles — shown at the bottom of each video tile like movie subtitles
  // Map: speakerSocketId → { text, speakerName, sourceLanguageName, timestamp }
  const [liveCaptions, setLiveCaptions] = useState(new Map());
  const captionTimeoutsRef = useRef(new Map());

  
  // Noise suppression (Krisp-equivalent via RNNoise WASM)
  const {
    isSupported: noiseSuppressionSupported,
    isEnabled: noiseSuppressionEnabled,
    isLoading: noiseSuppressionLoading,
    processStream: applyNoiseSuppression,
    toggleNoiseSuppression,
    cleanup: cleanupNoiseSuppression
  } = useNoiseSuppression();

  // TTS state
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const ttsEnabledRef = useRef(true);
  // Whether the browser's autoplay policy has been unlocked by a user gesture
  const ttsUnlockedRef = useRef(false);
  // Global mute for original (WebRTC) audio when translation is active
  const [muteOriginalAudio, setMuteOriginalAudio] = useState(false);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);

  // Keep ref in sync with state
  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
  }, [ttsEnabled]);

  useEffect(() => {
    speakerLanguageRef.current = speakerLanguage;
  }, [speakerLanguage]);

  useEffect(() => {
    translationLanguageRef.current = translationLanguage;
  }, [translationLanguage]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Unlock TTS on first user interaction (browser autoplay policy)
  const unlockTts = useCallback(() => {
    if (ttsUnlockedRef.current || !window.speechSynthesis) return;
    // Speak a silent utterance to unlock the audio context
    const silent = new SpeechSynthesisUtterance('');
    silent.volume = 0;
    window.speechSynthesis.speak(silent);
    ttsUnlockedRef.current = true;
    console.log('🔓 TTS unlocked via user gesture');
  }, []);

  // TTS queue — prevents skipping/overlapping, handles autoplay restrictions
  const ttsQueueRef = useRef([]);
  const ttsSpeakingRef = useRef(false);

  const processTtsQueue = useCallback(() => {
    if (ttsSpeakingRef.current || ttsQueueRef.current.length === 0) return;
    if (!window.speechSynthesis) return;

    const { text, lang } = ttsQueueRef.current.shift();
    ttsSpeakingRef.current = true;
    setTtsSpeaking(true);

    // Chrome bug: speechSynthesis pauses after ~14s — keep it alive
    const keepAlive = setInterval(() => {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 10000);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    utterance.onend = () => {
      clearInterval(keepAlive);
      ttsSpeakingRef.current = false;
      setTtsSpeaking(false);
      // Process next item after a tiny gap
      setTimeout(processTtsQueue, 80);
    };
    utterance.onerror = (e) => {
      clearInterval(keepAlive);
      console.warn('TTS error:', e.error);
      ttsSpeakingRef.current = false;
      setTtsSpeaking(false);
      setTimeout(processTtsQueue, 80);
    };

    window.speechSynthesis.speak(utterance);
    console.log(`🔊 TTS [${lang}]: "${text}"`);
  }, []);

  // Speak translated text using browser SpeechSynthesis with queue
  const speakText = useCallback((text, langCode) => {
    if (!window.speechSynthesis) return;
    const langMap = {
      'en': 'en-US', 'es': 'es-ES', 'fr': 'fr-FR', 'de': 'de-DE',
      'it': 'it-IT', 'pt': 'pt-PT', 'ru': 'ru-RU', 'ja': 'ja-JP',
      'ko': 'ko-KR', 'zh': 'zh-CN', 'ar': 'ar-SA', 'hi': 'hi-IN',
      'tr': 'tr-TR', 'nl': 'nl-NL', 'pl': 'pl-PL',
      'ta': 'ta-IN', 'te': 'te-IN', 'ml': 'ml-IN', 'kn': 'kn-IN'
    };
    const lang = langMap[langCode] || langCode || 'en-US';

    // Keep queue short — drop all but the latest if backed up (real-time sync)
    if (ttsQueueRef.current.length >= 2) {
      console.log(`⚡ TTS queue backed up (${ttsQueueRef.current.length}), dropping stale items`);
      ttsQueueRef.current = [];
      // Cancel current speech to jump to latest
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        ttsSpeakingRef.current = false;
        setTtsSpeaking(false);
      }
    }
    ttsQueueRef.current.push({ text, lang });
    processTtsQueue();
  }, [processTtsQueue]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingType, setRecordingType] = useState('both'); // 'video', 'audio', 'both'
  const [recordedChunks, setRecordedChunks] = useState([]);
  const [recordings, setRecordings] = useState([]);
  const [showRecordings, setShowRecordings] = useState(false);

  // Meeting timer state
  const [meetingTimer, setMeetingTimer] = useState('00:00:00');
  const [timeUntilEnd, setTimeUntilEnd] = useState(null); // ms until scheduled end
  const meetingTimerRef = useRef(null);
  
  // Whiteboard state (showWhiteboard toggle only — drawing handled by Whiteboard component)

  // UI State
  const [showChat, setShowChat] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [showWhiteboard, setShowWhiteboard] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [hasRaisedHand, setHasRaisedHand] = useState(false);
  
  // Chat and interactions
  const [chatMessages, setChatMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [reactions, setReactions] = useState([]);
  const [raisedHands, setRaisedHands] = useState([]);
  const [roomStats, setRoomStats] = useState(null);
  
  // Refs
  const localVideoRef = useRef();
  const socketRef = useRef();
  const peersRef = useRef(new Map());
  const localStreamRef = useRef();
  const rawStreamRef = useRef(); // original unprocessed stream for re-applying noise suppression
  const screenStreamRef = useRef();
  const mediaRecorderRef = useRef();
  const recordingStreamRef = useRef();
  const autoRecorderRef = useRef(null);
  const autoRecordingChunksRef = useRef([]);
  const meetingJoinTimeRef = useRef(null);

  // Translation refs (browser-native STT + on-device translation)
  const recognitionRef = useRef(null);        // active SpeechRecognition instance
  const speechActiveRef = useRef(false);      // true while auto-translate should stay on
  const translatorCacheRef = useRef(new Map()); // "src>dst" → Translator instance (or null = unavailable)
  const translationLanguageRef = useRef('es');  // latest own translation language
  const participantsRef = useRef([]);           // latest participants (for target languages)
    const handleFinalTranscriptRef = useRef(null);// latest transcript handler (avoids stale closures)

  // — Continuous (interim) subtitle updates — refs to keep latest
  // handlers reachable from the speech recognizer's event closures
  const handleInterimTranscriptRef = useRef(null);
  const interimDebounceRef = useRef(null); // throttle translation calls during rapid interim updates
  const interimTextRef = useRef('');       // latest interim text (skip stale async results)
  

  // Start meeting elapsed timer
  const startMeetingTimer = useCallback((room) => {
    if (meetingTimerRef.current) clearInterval(meetingTimerRef.current);
    meetingTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - (meetingJoinTimeRef.current || Date.now());
      const h = Math.floor(elapsed / 3600000);
      const m = Math.floor((elapsed % 3600000) / 60000);
      const s = Math.floor((elapsed % 60000) / 1000);
      setMeetingTimer(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      );

      // Update time until scheduled end
      if (room?.meetingEndTime && room?.meetingDate) {
        try {
          const endDt = new Date(`${room.meetingDate}T${room.meetingEndTime}:00`);
          const remaining = endDt - Date.now();
          setTimeUntilEnd(remaining > 0 ? remaining : 0);
        } catch (e) {}
      }
    }, 1000);
  }, []);

  // Re-apply (or remove) noise suppression when user toggles it mid-call
  useEffect(() => {
    if (!rawStreamRef.current) return;
    (async () => {
      const newStream = await applyNoiseSuppression(rawStreamRef.current);
      const finalStream = newStream || rawStreamRef.current;
      localStreamRef.current = finalStream;
      setLocalStream(finalStream);
      if (localVideoRef.current) localVideoRef.current.srcObject = finalStream;
      // Replace audio track in all active peer connections
      peersRef.current.forEach(async (peer) => {
        const sender = peer.getSenders().find(s => s.track?.kind === 'audio');
        if (sender) {
          const newAudioTrack = finalStream.getAudioTracks()[0];
          if (newAudioTrack) {
            try { await sender.replaceTrack(newAudioTrack); } catch (e) {}
          }
        }
      });
      console.log(`🎙️ Noise suppression ${noiseSuppressionEnabled ? 'applied' : 'removed'} — stream updated`);
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noiseSuppressionEnabled]);

  useEffect(() => {
    // Prevent automatic start - only initialize if we have proper state
    if (!location.state || !location.state.participantName) {
      console.log('❌ No participant data found, redirecting to home');
      navigate('/');
      return;
    }

    // Check if this is a valid join attempt (not just page refresh)
    const { participantName, participantEmail, passcode, translationLanguage: userLang } = location.state;
    if (!participantName || !participantEmail || !passcode) {
      console.log('❌ Incomplete participant data, redirecting to home');
      navigate('/');
      return;
    }

    // Set user's preferred translation language
    if (userLang) {
      setTranslationLanguage(userLang);
      console.log(`🌐 User translation language set to: ${userLang}`);
    }
    // Set user's speaker language
    const { speakerLanguage: spkLang } = location.state;
    if (spkLang) {
      setSpeakerLanguage(spkLang);
      console.log(`🎤 User speaker language set to: ${spkLang}`);
    }

    console.log('✅ Valid join attempt detected, initializing call');
    initializeCall();

    return () => {
      if (meetingTimerRef.current) clearInterval(meetingTimerRef.current);
      cleanup();
    };
  }, []);

  const initializeCall = async () => {
    try {
      console.log('🚀 Initializing video call...');
      
      // Clean up any existing socket connection first
      if (socketRef.current) {
        console.log('🧹 Cleaning up existing socket connection');
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      
      // Initialize socket connection
      socketRef.current = io(SOCKET_URL, {
        forceNew: true,
        transports: ['websocket', 'polling'],
        timeout: 20000,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        randomizationFactor: 0.3
      });
      
      // Get user media with enhanced audio settings
      const mediaConstraints = {
        video: { 
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 30, max: 60 },
          facingMode: 'user'
        },
        audio: {
          // Enhanced audio settings for better quality
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: { ideal: 48000 },
          channelCount: { ideal: 1 },
          volume: { ideal: 1.0 },
          // Additional constraints for better audio
          googEchoCancellation: true,
          googAutoGainControl: true,
          googNoiseSuppression: true,
          googHighpassFilter: true,
          googTypingNoiseDetection: true,
          googAudioMirroring: false
        }
      };

      console.log('📹 Requesting media with enhanced constraints:', mediaConstraints);
      const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints);

      console.log('📹 Local stream obtained');
      
      // Store raw stream for re-applying noise suppression on toggle
      rawStreamRef.current = stream;

      // Apply RNNoise-based noise suppression (Krisp-equivalent)
      // This cleans the audio before WebRTC transmission AND transcription
      const processedStream = await applyNoiseSuppression(stream);
      const finalStream = processedStream || stream;

      setLocalStream(finalStream);
      localStreamRef.current = finalStream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = finalStream;
      }

      // Detect audio devices and show warning if no headphones
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioOutputs = devices.filter(device => device.kind === 'audiooutput');
        setAudioDevices(audioOutputs);
        
        // Check if likely using speakers (show warning)
        const hasHeadphones = audioOutputs.some(device => 
          device.label.toLowerCase().includes('headphone') ||
          device.label.toLowerCase().includes('headset') ||
          device.label.toLowerCase().includes('earphone')
        );
        
        if (!hasHeadphones && audioOutputs.length > 0) {
          setShowAudioWarning(true);
          // Auto-hide warning after 10 seconds
          setTimeout(() => setShowAudioWarning(false), 10000);
        }
      } catch (err) {
        console.log('Could not enumerate devices:', err);
      }

      setupSocketListeners();

      // Join room after getting media
      const { participantName, participantEmail, passcode, isHost, translationLanguage: userLang } = location.state;
      console.log(`🏠 Joining room ${roomId} as ${participantName} (${isHost ? 'ADMIN' : 'PARTICIPANT'}) with translation: ${userLang || translationLanguage}`);
      
      socketRef.current.emit('join-room', {
        roomId,
        passcode,
        participantName,
        participantEmail,
        isHost: isHost || false,
        translationLanguage: userLang || translationLanguage,
        speakerLanguage: location.state.speakerLanguage || 'en'
      });

      // Record join time for meeting history
      meetingJoinTimeRef.current = Date.now();

      // Start auto screen recording
      startAutoRecording(stream);

      setConnectionStatus('Connected');

    } catch (error) {
      console.error('❌ Error initializing call:', error);
      setError('Unable to access camera/microphone. Please check permissions.');
      setConnectionStatus('Failed');
    }
  };

  const saveMeetingHistory = (recordingCount = 0) => {
    const { participantName, isHost } = location.state || {};
    const joinTime = meetingJoinTimeRef.current;
    const leftTime = Date.now();
    const duration = joinTime ? leftTime - joinTime : 0;

    const entry = {
      id: Date.now(),
      roomId,
      participantName: participantName || 'Unknown',
      isHost: isHost || false,
      date: new Date().toLocaleDateString(),
      joinedAt: joinTime ? new Date(joinTime).toLocaleTimeString() : 'N/A',
      leftAt: new Date(leftTime).toLocaleTimeString(),
      duration,
      recordingCount
    };

    const existing = JSON.parse(localStorage.getItem('meetingHistory') || '[]');
    existing.push(entry);
    localStorage.setItem('meetingHistory', JSON.stringify(existing));
    console.log('📋 Meeting history saved');
  };

  const startAutoRecording = (stream) => {
    try {
      if (!stream) return;
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || '';

      autoRecordingChunksRef.current = [];
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) autoRecordingChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const chunks = autoRecordingChunksRef.current;
        if (chunks.length === 0) return;
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const { participantName } = location.state || {};
        const timestamp = new Date().toLocaleString();
        const filename = `meeting_${roomId}_${Date.now()}.webm`;
        const duration = meetingJoinTimeRef.current ? Date.now() - meetingJoinTimeRef.current : 0;

        const recEntry = {
          id: Date.now(),
          roomId,
          participantName: participantName || 'Unknown',
          url,
          filename,
          timestamp,
          duration
        };

        // Save to localStorage (metadata only, URL is blob)
        const existing = JSON.parse(localStorage.getItem('meetingRecordings') || '[]');
        existing.push(recEntry);
        localStorage.setItem('meetingRecordings', JSON.stringify(existing));

        // Also update recordings state for in-session view
        setRecordings(prev => [...prev, { ...recEntry, type: 'both', blob }]);
        console.log('🎥 Auto-recording saved:', filename);
      };

      recorder.start(1000);
      autoRecorderRef.current = recorder;
      console.log('🎥 Auto screen recording started');
    } catch (err) {
      console.error('❌ Auto recording failed to start:', err);
    }
  };

  const stopAutoRecording = () => {
    if (autoRecorderRef.current && autoRecorderRef.current.state === 'recording') {
      autoRecorderRef.current.stop();
      autoRecorderRef.current = null;
      console.log('🛑 Auto recording stopped');
    }
  };

  const setupSocketListeners = () => {
    const socket = socketRef.current;

    socket.on('room-joined', ({ room, isAdmin: adminStatus }) => {
      console.log('✅ Successfully joined room:', room);
      console.log('📊 Existing participants received:', room.participants);
      console.log('👑 Admin status:', adminStatus);
      
      setRoomInfo(room);
      setIsAdmin(adminStatus);      
      // CRITICAL: Clear any existing state first
      setParticipants([]);
      setRemoteStreams(new Map());
      peersRef.current.clear();
      
      // Set ONLY the existing participants (excluding self) with connection status
      const existingParticipants = (room.participants || []).map(p => ({
        ...p,
        connectionStatus: 'connecting'
      }));
      console.log(`📊 Setting ${existingParticipants.length} existing participants`);
      setParticipants(existingParticipants);
      setParticipantCount(existingParticipants.length + 1); // +1 for self
      
      setChatMessages(prev => {
        // Merge server history with local state, deduplicating by id
        const existingIds = new Set(prev.map(m => m.id));
        const newMsgs = (room.chatMessages || []).filter(m => !existingIds.has(m.id));
        return newMsgs.length ? [...prev, ...newMsgs] : prev;
      });
      setRaisedHands(room.raisedHands || []);

      // Start meeting timer
      startMeetingTimer(room);
      
      // Create peer connections ONLY for existing participants with a delay
      existingParticipants.forEach((participant, index) => {
        console.log(`🤝 Creating peer connection for existing participant: ${participant.name} (${participant.id})`);
        // Stagger connection creation to avoid overwhelming
        setTimeout(() => {
          createPeerConnection(participant.id, participant, true);
        }, index * 200);
      });
    });

    socket.on('user-joined', (participant) => {
      console.log('👋 New user joined:', participant);
      
      // Prevent duplicate participants
      setParticipants(prev => {
        const exists = prev.find(p => p.id === participant.id);
        if (exists) {
          console.log('⚠️ Participant already exists, skipping:', participant.name);
          return prev;
        }
        
        console.log('📊 Adding participant to list. Current:', prev.length, 'Adding:', participant.name);
        const newParticipant = { ...participant, connectionStatus: 'connecting' };
        const newList = [...prev, newParticipant];
        setParticipantCount(newList.length + 1); // +1 for self
        return newList;
      });
      
      // Create peer connection for new participant (they will initiate)
      if (!peersRef.current.has(participant.id)) {
        createPeerConnection(participant.id, participant, false);
      }
    });

    socket.on('participant-count-updated', ({ count }) => {
      console.log('📊 Participant count updated from server:', count);
      setParticipantCount(count);
      
      // Verify our local state matches server count
      setParticipants(prev => {
        const localCount = prev.length + 1; // +1 for self
        if (localCount !== count) {
          console.log(`⚠️ Count mismatch! Local: ${localCount}, Server: ${count}`);
        }
        return prev;
      });
    });

    socket.on('user-left', (userId) => {
      console.log('👋 User left:', userId);
      
      // Remove from participants
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== userId);
        console.log('📊 Removing participant. Before:', prev.length, 'After:', filtered.length);
        setParticipantCount(filtered.length + 1); // +1 for self
        return filtered;
      });
      
      // Clean up peer connection
      const peer = peersRef.current.get(userId);
      if (peer) {
        peer.close();
        peersRef.current.delete(userId);
        console.log(`🔌 Closed peer connection for ${userId}`);
      }
      
      // Remove remote stream
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.delete(userId);
        console.log(`🗑️ Removed remote stream for ${userId}`);
        return newStreams;
      });
    });

    // Admin-specific event handlers
    socket.on('force-disconnect', ({ reason, message }) => {
      console.log('🚫 Force disconnected:', reason);
      alert(message);
      cleanup();
      navigate('/');
    });

    socket.on('meeting-ended', ({ reason, message, endedBy }) => {
      console.log('🔚 Meeting ended:', reason);
      alert(`${message}${endedBy ? ` by ${endedBy}` : ''}`);
      cleanup();
      navigate('/');
    });

    socket.on('participant-removed', ({ participantId, participantName, removedBy }) => {
      console.log(`🚫 Participant ${participantName} was removed by ${removedBy}`);
      
      // Immediately remove from participants list
      setParticipants(prev => {
        const filtered = prev.filter(p => p.id !== participantId);
        console.log(`📊 Participant removed. Before: ${prev.length}, After: ${filtered.length}`);
        setParticipantCount(filtered.length + 1); // +1 for self
        return filtered;
      });
      
      // Clean up peer connection immediately
      const peer = peersRef.current.get(participantId);
      if (peer) {
        peer.close();
        peersRef.current.delete(participantId);
        console.log(`🔌 Closed peer connection for removed participant ${participantId}`);
      }
      
      // Remove remote stream immediately
      setRemoteStreams(prev => {
        const newStreams = new Map(prev);
        newStreams.delete(participantId);
        console.log(`🗑️ Removed remote stream for ${participantId}`);
        return newStreams;
      });
      
      // Show notification if not admin
      if (!isAdmin) {
        // Show a brief notification about the removal
        setTimeout(() => {
          console.log(`ℹ️ ${participantName} was removed from the meeting`);
        }, 100);
      }
    });

    // WebRTC signaling handlers
    socket.on('offer', async ({ offer, senderId }) => {
      console.log(`📥 Received offer from ${senderId}`);
      await handleOffer(offer, senderId);
    });

    socket.on('answer', async ({ answer, senderId }) => {
      console.log(`📥 Received answer from ${senderId}`);
      await handleAnswer(answer, senderId);
    });

    socket.on('ice-candidate', async ({ candidate, senderId }) => {
      console.log(`🧊 Received ICE candidate from ${senderId}`);
      await handleIceCandidate(candidate, senderId);
    });

    // Chat and interaction handlers
    socket.on('new-chat-message', (message) => {
      setChatMessages(prev => {
        // Deduplicate by message id
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      });
    });

    socket.on('new-reaction', (reaction) => {
      setReactions(prev => [...prev, reaction]);
      // Remove reaction after 3 seconds
      setTimeout(() => {
        setReactions(prev => prev.filter(r => r.id !== reaction.id));
      }, 3000);
    });

    socket.on('participant-hand-toggle', ({ participantId, isRaised, participantName }) => {
      if (isRaised) {
        setRaisedHands(prev => [...prev, { participantId, participantName }]);
      } else {
        setRaisedHands(prev => prev.filter(h => h.participantId !== participantId));
      }
    });

    socket.on('participant-video-toggle', ({ participantId, isEnabled }) => {
      setParticipants(prev => prev.map(p => 
        p.id === participantId ? { ...p, isVideoEnabled: isEnabled } : p
      ));
    });

    socket.on('participant-audio-toggle', ({ participantId, isEnabled }) => {
      setParticipants(prev => prev.map(p => 
        p.id === participantId ? { ...p, isAudioEnabled: isEnabled } : p
      ));
    });

    socket.on('room-stats', (stats) => {
      setRoomStats(stats);
    });

    // Translation event handlers

    // Handle incoming translations from other participants
    socket.on('participant-translation', (data) => {
      console.log('🌐 Received translation from participant:', data);
      
      const newResult = {
        id: Date.now(),
        original: data.original,
        translated: data.translated,
        targetLanguage: data.targetLanguage,
        targetLanguageName: data.targetLanguageName,
        speakerName: data.speakerName,
        timestamp: new Date().toLocaleTimeString(),
        isFallback: false
      };
      
      setTranscriptionResults(prev => {
        // Keep only last 50 results to avoid memory bloat
        const updated = [...prev, newResult];
        return updated.length > 50 ? updated.slice(-50) : updated;
      });
            setShowTranscriptions(true);

      // Set live subtitle on the correct remote video tile
      if (data.speakerId) {
        setLiveCaption(data.speakerId, {
          text: data.translated,
          original: data.original,
          speakerName: data.speakerName,
          sourceLanguageName: data.speakerLanguageName || getLanguageName(data.speakerLanguage)
        });
      }

      // Speak the translated text if TTS is enabled (use ref to avoid stale closure)
      if (ttsEnabledRef.current && data.translated) {
        speakText(data.translated, data.targetLanguage);
      }
    });

    // Whiteboard sync is handled by the Whiteboard component directly

    socket.on('error', (message) => {
      console.error('❌ Socket error:', message);
      setError(message);
      setConnectionStatus('Error');
    });

    socket.on('connect', () => {
      console.log('🔗 Socket connected:', socket.id);
      setConnectionStatus('Connected');
    });

    socket.on('reconnect', (attempt) => {
      console.log(`🔄 Socket reconnected after ${attempt} attempts — re-joining room`);
      setConnectionStatus('Reconnected');
      const { participantName, participantEmail, passcode, isHost, translationLanguage: userLang } = location.state || {};
      if (participantName && passcode) {
        socketRef.current.emit('join-room', {
          roomId,
          passcode,
          participantName,
          participantEmail,
          isHost: isHost || false,
          translationLanguage: userLang || 'en',
          speakerLanguage: location.state?.speakerLanguage || 'en'
        });
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('🔌 Socket disconnected:', reason);
      setConnectionStatus('Disconnected — reconnecting...');
    });
  };

  const createPeerConnection = (peerId, participant, shouldCreateOffer) => {
    console.log(`🔗 Creating peer connection for ${participant.name} (${peerId}), shouldCreateOffer: ${shouldCreateOffer}`);
    
    // Check if peer connection already exists
    if (peersRef.current.has(peerId)) {
      console.log(`⚠️ Peer connection already exists for ${peerId}, skipping`);
      return;
    }

    // ICE servers — Google STUN + reliable free TURN via Metered
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      // Metered free TURN — works across NAT/firewalls on Render
      { urls: 'turn:a.relay.metered.ca:80',      username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:a.relay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:a.relay.metered.ca:443',     username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      // Fallback TURN
      { urls: 'turn:openrelay.metered.ca:80',    username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443',   username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
    ];
    
    const peer = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 10,
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    // Buffer ICE candidates until remote description is set
    peer._iceCandidateBuffer = [];
    peer._remoteDescSet = false;

    // Add local stream tracks
    const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
    if (currentStream) {
      currentStream.getTracks().forEach(track => {
        if (track.kind === 'audio') {
          track.applyConstraints({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
            channelCount: 1
          }).catch(() => {});
        }
        peer.addTrack(track, currentStream);
        console.log(`➕ Added ${track.kind} track to peer for ${peerId}`);
      });
    }

    peer.ontrack = (event) => {
      console.log(`📺 Received remote stream from ${peerId}`);
      const [remoteStream] = event.streams;
      setRemoteStreams(prev => {
        const m = new Map(prev);
        m.set(peerId, remoteStream);
        return m;
      });
      setParticipants(prev => prev.map(p =>
        p.id === peerId ? { ...p, connectionStatus: 'connected' } : p
      ));
    };

    peer.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit('ice-candidate', { candidate: event.candidate, targetId: peerId });
      }
    };

    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      console.log(`🔄 Connection state for ${peerId}: ${state}`);
      setParticipants(prev => prev.map(p =>
        p.id === peerId ? { ...p, connectionStatus: state } : p
      ));

      if (state === 'failed') {
        console.log(`❌ Connection failed for ${peerId} — attempting ICE restart`);
        // Try ICE restart first before full reconnect
        if (shouldCreateOffer) {
          peer.restartIce();
          createOffer(peerId);
        } else {
          // Give the other side 3s to restart, then do full reconnect
          setTimeout(() => {
            if (peer.connectionState === 'failed' && peersRef.current.has(peerId)) {
              console.log(`🔄 Full reconnect for ${peerId}`);
              peer.close();
              peersRef.current.delete(peerId);
              setRemoteStreams(prev => { const m = new Map(prev); m.delete(peerId); return m; });
              createPeerConnection(peerId, participant, true);
            }
          }, 3000);
        }
      } else if (state === 'disconnected') {
        // Transient — wait before acting
        setTimeout(() => {
          if (peer.connectionState === 'disconnected' && peersRef.current.has(peerId)) {
            peer.restartIce();
          }
        }, 2000);
      }
    };

    peer.oniceconnectionstatechange = () => {
      console.log(`🧊 ICE state for ${peerId}: ${peer.iceConnectionState}`);
      if (peer.iceConnectionState === 'failed') {
        peer.restartIce();
      }
    };

    peersRef.current.set(peerId, peer);
    setParticipants(prev => prev.map(p =>
      p.id === peerId ? { ...p, connectionStatus: 'connecting' } : p
    ));

    if (shouldCreateOffer) {
      setTimeout(() => createOffer(peerId), 100);
    }
  };

  const createOffer = async (peerId) => {
    try {
      const peer = peersRef.current.get(peerId);
      if (!peer) return;
      console.log(`📤 Creating offer for ${peerId}`);
      const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await peer.setLocalDescription(offer);
      socketRef.current.emit('offer', { offer, targetId: peerId });
    } catch (error) {
      console.error(`❌ Error creating offer for ${peerId}:`, error);
    }
  };

  // Flush buffered ICE candidates after remote description is set
  const flushIceCandidates = async (peer, peerId) => {
    peer._remoteDescSet = true;
    const buffered = peer._iceCandidateBuffer || [];
    console.log(`🧊 Flushing ${buffered.length} buffered ICE candidates for ${peerId}`);
    for (const candidate of buffered) {
      try { await peer.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
    peer._iceCandidateBuffer = [];
  };

  const handleOffer = async (offer, senderId) => {
    try {
      let peer = peersRef.current.get(senderId);
      if (!peer) {
        const participant = participants.find(p => p.id === senderId) || { id: senderId, name: 'Unknown' };
        createPeerConnection(senderId, participant, false);
        peer = peersRef.current.get(senderId);
      }
      if (!peer) return;

      await peer.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIceCandidates(peer, senderId);

      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socketRef.current.emit('answer', { answer, targetId: senderId });
      console.log(`📤 Answer sent to ${senderId}`);
    } catch (error) {
      console.error(`❌ Error handling offer from ${senderId}:`, error);
    }
  };

  const handleAnswer = async (answer, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) return;
      await peer.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIceCandidates(peer, senderId);
      console.log(`✅ Answer processed from ${senderId}`);
    } catch (error) {
      console.error(`❌ Error handling answer from ${senderId}:`, error);
    }
  };

  const handleIceCandidate = async (candidate, senderId) => {
    try {
      const peer = peersRef.current.get(senderId);
      if (!peer) return;

      // Buffer candidates until remote description is ready
      if (!peer._remoteDescSet) {
        peer._iceCandidateBuffer = peer._iceCandidateBuffer || [];
        peer._iceCandidateBuffer.push(candidate);
        console.log(`🧊 Buffered ICE candidate for ${senderId} (remote desc not set yet)`);
        return;
      }

      await peer.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error(`❌ Error adding ICE candidate from ${senderId}:`, error);
    }
  };

  // Media control functions
  const toggleVideo = useCallback(() => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
        socketRef.current.emit('toggle-video', { isEnabled: videoTrack.enabled });
        console.log(`📹 Video ${videoTrack.enabled ? 'enabled' : 'disabled'}`);
      }
    }
  }, []);

  const toggleAudio = useCallback(() => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
        socketRef.current.emit('toggle-audio', { isEnabled: audioTrack.enabled });
        console.log(`🎤 Audio ${audioTrack.enabled ? 'enabled' : 'disabled'}`);
      }
    }
  }, []);

  const toggleScreenShare = useCallback(async () => {
    try {
      if (!isScreenSharing) {
        // Start screen sharing
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
        
        screenStreamRef.current = screenStream;
        setIsScreenSharing(true);
        
        // Replace video track in all peer connections
        peersRef.current.forEach(async (peer, peerId) => {
          const sender = peer.getSenders().find(s => 
            s.track && s.track.kind === 'video'
          );
          if (sender) {
            await sender.replaceTrack(screenStream.getVideoTracks()[0]);
          }
        });
        
        // Update local video
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = screenStream;
        }
        
        // Handle screen share end
        screenStream.getVideoTracks()[0].onended = () => {
          stopScreenShare();
        };
        
      } else {
        stopScreenShare();
      }
    } catch (error) {
      console.error('❌ Error toggling screen share:', error);
    }
  }, [isScreenSharing]);

  const stopScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    
    setIsScreenSharing(false);
    
    // Replace back to camera stream
    peersRef.current.forEach(async (peer, peerId) => {
      const sender = peer.getSenders().find(s => 
        s.track && s.track.kind === 'video'
      );
      if (sender && localStreamRef.current) {
        await sender.replaceTrack(localStreamRef.current.getVideoTracks()[0]);
      }
    });
    
    // Update local video back to camera
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, []);

  const toggleRaiseHand = useCallback(() => {
    const newState = !hasRaisedHand;
    setHasRaisedHand(newState);
    socketRef.current.emit('toggle-raise-hand', { isRaised: newState });
  }, [hasRaisedHand]);

  const sendReaction = useCallback((reaction) => {
    socketRef.current.emit('send-reaction', { reaction });
  }, []);

  const sendChatMessage = useCallback(() => {
    if (newMessage.trim()) {
      socketRef.current.emit('send-chat-message', { message: newMessage.trim() });
      setNewMessage('');
    }
  }, [newMessage]);

  const refreshConnection = useCallback(() => {
    setConnectionStatus('Refreshing...');
    console.log('🔄 Refreshing connections...');
    console.log('📊 Current participants:', participants.length);
    console.log('📊 Current peer connections:', peersRef.current.size);
    console.log('📊 Current remote streams:', remoteStreams.size);
    
    // Close all peer connections
    peersRef.current.forEach((peer, peerId) => {
      console.log(`🔌 Closing peer connection for ${peerId}`);
      peer.close();
    });
    peersRef.current.clear();
    setRemoteStreams(new Map());
    
    // Reconnect after a short delay
    setTimeout(() => {
      console.log('🔄 Recreating peer connections...');
      participants.forEach(participant => {
        console.log(`🤝 Recreating peer connection for ${participant.name}`);
        createPeerConnection(participant.id, participant, true);
      });
      setConnectionStatus('Connected');
    }, 1000);
  }, [participants]);

  const getStats = useCallback(() => {
    socketRef.current.emit('get-room-stats');
    setShowStats(true);
  }, []);

  // ── Browser-native translation pipeline ──────────────────────────────────
  // Speech recognition:  Web Speech API (built into Chrome/Edge/Safari)
  // Translation:         Chrome built-in on-device Translator API
  // Text-to-speech:      browser SpeechSynthesis (unchanged)
  // No server AI involved — the server only relays results to the room.

    // ── Live caption helper ─────────────────────────────────────────────────
  // Stores a subtitle for a given speaker and auto-clears it after CAPTION_TIMEOUT_MS.
  const CAPTION_TIMEOUT_MS = 6000;
  const setLiveCaption = useCallback((speakerId, data) => {
    if (!speakerId) return;
    setLiveCaptions(prev => {
      const updated = new Map(prev);
      if (data) {
        updated.set(speakerId, data);
      } else {
        updated.delete(speakerId);
      }
      return updated;
    });
    // Clear any pending timeout for this speaker
    if (captionTimeoutsRef.current.has(speakerId)) {
      clearTimeout(captionTimeoutsRef.current.get(speakerId));
    }
    // Schedule auto-clear
    if (data) {
      const t = setTimeout(() => {
        setLiveCaptions(prev => {
          const updated = new Map(prev);
          updated.delete(speakerId);
          return updated;
        });
        captionTimeoutsRef.current.delete(speakerId);
      }, CAPTION_TIMEOUT_MS);
      captionTimeoutsRef.current.set(speakerId, t);
    }
  }, []);

  // ── Browser-native on-device translation ─────────────────────────────────
  // Tries Chrome's built-in Translator API first; falls back to a free
  // no-key translation endpoint (MyMemory) so captions always translate
  // even in browsers that lack the experimental Translator API.

  // Free fallback: MyMemory Translation API (no API key required)
  const translateViaFreeAPI = useCallback(async (text, source, target) => {
    if (!text || source === target) return text;
    try {
      const params = new URLSearchParams({
        q: text,
        langpair: `${source}|${target}`,
        de: 'lgt-video-call'
      });
      const response = await fetch(`https://api.mymemory.translated.net/get?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      // MyMemory returns 200 with the result in responseData.translatedText
      const translated = data?.responseData?.translatedText;
      if (translated && translated !== text) {
        return translated;
      }
      // Some responses put results in a "matches" array
      if (data?.matches && data.matches.length > 0) {
        return data.matches[0].translation;
      }
      throw new Error('No translation returned');
    } catch (err) {
      console.warn(`⚠️ Free API translation ${source} → ${target} failed:`, err.message);
      return null;
    }
  }, []);

  // Get (or create) an on-device Translator for a language pair
  const getTranslator = useCallback(async (source, target) => {
    const key = `${source}>${target}`;
    if (translatorCacheRef.current.has(key)) {
      const cached = translatorCacheRef.current.get(key);
      if (cached) return cached;
      throw new Error(`Translator unavailable for ${key}`);
    }

    if (!('Translator' in window) || typeof window.Translator?.availability !== 'function') {
      translatorCacheRef.current.set(key, null);
      throw new Error('This browser does not support the built-in Translator API');
    }

    const availability = await window.Translator.availability({
      sourceLanguage: source,
      targetLanguage: target
    });
    if (availability === 'unavailable') {
      translatorCacheRef.current.set(key, null);
      throw new Error(`On-device translation ${source} → ${target} is unavailable`);
    }

    const translator = await window.Translator.create({
      sourceLanguage: source,
      targetLanguage: target,
      monitor: (m) => {
        m.addEventListener('downloadprogress', (e) => {
          if (e.loaded < 1) {
            setTranslationStatus(`⬇️ Downloading translation model (${Math.floor(e.loaded * 100)}%)...`);
          }
        });
      }
    });
    translatorCacheRef.current.set(key, translator);
    return translator;
  }, []);

    // Translate text — tries Chrome built-in Translator API first, then falls
  // back to a free no-key translation endpoint (MyMemory). Never throws.
  const translateText = useCallback(async (text, source, target) => {
    if (!text || !text.trim() || source === target) return text;
    try {
      // Try browser-native on-device translation first
      const translator = await getTranslator(source, target);
      const translated = await translator.translate(text);
      return translated || text;
    } catch (err) {
      // Browser doesn't support Chrome Translator API — use free fallback
      console.warn(`⚠️ On-device translation ${source} → ${target} unavailable, trying free API...`);
      const translated = await translateViaFreeAPI(text, source, target);
      if (translated) {
        return translated;
      }
      // Ultimate fallback: return original text so captions keep flowing
      setTranslationStatus(`⚠️ Translation unavailable (${source} → ${target})`);
      return text;
    }
  }, [getTranslator, translateViaFreeAPI, setTranslationStatus]);

  // Handle a final transcript from the speech recognizer: show it locally,
  // translate it on-device into every participant's target language and
  // broadcast the results (the server relays per participant).
  const handleFinalTranscript = useCallback(async (originalText) => {
    const text = (originalText || '').trim();
    if (!text || !socketRef.current?.connected) return;

    const speakerName = location.state?.participantName || 'Unknown';
    const sourceLang = speakerLanguageRef.current || 'en';
    const myTarget = translationLanguageRef.current || 'en';

    // Collect every target language in the room (others' + own)
    const targets = new Set([myTarget]);
    participantsRef.current.forEach(p => {
      if (socketRef.current && p.id !== socketRef.current.id) {
        targets.add(p.translationLanguage || 'en');
      }
    });

    // Translate once per unique target language (on-device)
    const translations = {};
    for (const lang of targets) {
      translations[lang] = lang === sourceLang ? text : await translateText(text, sourceLang, lang);
    }

    const timestamp = new Date().toLocaleTimeString();

        // Show own transcript card (original + own translation)
    const ownTranslation = translations[myTarget] ?? text;
    setTranscriptionResults(prev => [...prev.slice(-49), {
      id: `${Date.now()}-self-${Math.random().toString(36).slice(2, 7)}`,
      original: text,
      translated: ownTranslation,
      targetLanguage: myTarget,
      targetLanguageName: getLanguageName(myTarget),
      speakerName,
      timestamp,
      isFallback: false
    }]);
    setShowTranscriptions(true);

    // Show live subtitle at the bottom of the local video tile
    setLiveCaption(socketRef.current.id, {
      text: ownTranslation,
      original: text,
      speakerName,
      sourceLanguageName: getLanguageName(sourceLang)
    });

    // Relay to the room — the server fans out per participant language
    socketRef.current.emit('transcript-broadcast', {
      roomId,
      speakerName,
      speakerLanguage: sourceLang,
      original: text,
      translations,
      timestamp
    });
  }, [roomId, location.state, translateText]);

    // Keep the latest handler reachable from the recognizer's event closures
  useEffect(() => {
    handleFinalTranscriptRef.current = handleFinalTranscript;
  }, [handleFinalTranscript]);

  // Handle INTERIM (partial) results: translate on-device and show as a
  // continuously-updating subtitle on the local video tile — like movie
  // captions that appear word-by-word as the speaker talks.  These are NOT
  // broadcast to other participants (only final results are relayed).
  const handleInterimTranscript = useCallback(async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || !socketRef.current?.id) return;

    interimTextRef.current = trimmed;

    // Throttle: wait for a brief pause in the rapid interim stream before
    // committing a translation, so we don't spam the translation API.
    if (interimDebounceRef.current) {
      clearTimeout(interimDebounceRef.current);
    }

    interimDebounceRef.current = setTimeout(async () => {
      const currentText = interimTextRef.current;
      if (!currentText) return;

      const sourceLang = speakerLanguageRef.current || 'en';
      const myTarget = translationLanguageRef.current || 'en';
      const speakerName = location.state?.participantName || 'Unknown';

      // 1) Show original text immediately so the user sees instant feedback
      setLiveCaption(socketRef.current.id, {
        text: myTarget === sourceLang ? currentText : currentText,
        original: currentText,
        speakerName,
        sourceLanguageName: getLanguageName(sourceLang),
        isInterim: true
      });

      // 2) Translate (on-device first, MyMemory fallback) and update subtitle
      if (myTarget !== sourceLang) {
        const translated = await translateText(currentText, sourceLang, myTarget);
        // Only apply if this is still the latest interim text (not stale)
        if (interimTextRef.current === currentText) {
          setLiveCaption(socketRef.current.id, {
            text: translated,
            original: currentText,
            speakerName,
            sourceLanguageName: getLanguageName(sourceLang),
            isInterim: true
          });
        }
      }
    }, 200);
  }, [translateText, location.state]);

  // Keep the latest interim handler reachable from the recognizer's closures
  useEffect(() => {
    handleInterimTranscriptRef.current = handleInterimTranscript;
  }, [handleInterimTranscript]);



  // Continuous live translation — browser speech recognition
  const startContinuousTranslation = useCallback(() => {
    if (!localStreamRef.current) {
      alert('No audio stream available. Please check your microphone.');
      return;
    }
    if (!socketRef.current || !socketRef.current.connected) {
      alert('Not connected to server. Please wait and try again.');
      return;
    }
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
      setTranslationStatus('❌ Speech recognition not supported in this browser');
      return;
    }
    if (recognitionRef.current) {
      console.log('⚠️ Continuous translation already running');
      return;
    }

    console.log('🎤 Starting browser speech recognition...');
    setTranslationEnabled(true);
    // Auto-enable TTS so translated speech is heard immediately
    setTtsEnabled(true);
    ttsEnabledRef.current = true;
    // Unlock TTS audio context (requires being called from a user gesture chain)
    unlockTts();
    speechActiveRef.current = true;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = SPEECH_LOCALES[speakerLanguageRef.current] || 'en-US';

    recognition.onresult = (event) => {
      let interim = '';
      let hasFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = (result[0]?.transcript || '').trim();
        if (result.isFinal) {
          hasFinal = true;
          if (transcript && handleFinalTranscriptRef.current) {
            handleFinalTranscriptRef.current(transcript);
          }
        } else if (transcript) {
          interim = transcript;
        }
      }
      // Interim results: continuously translate and show as subtitles
      // (no broadcast to others, just updates the local video tile)
      if (!hasFinal && interim && handleInterimTranscriptRef.current) {
        handleInterimTranscriptRef.current(interim);
      }
      if (interim) {
        setTranslationStatus(`🎤 “...${interim.slice(-60)}”`);
      } else if (!hasFinal) {
        setTranslationStatus(`🎤 Listening...`);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        speechActiveRef.current = false;
        setTranslationEnabled(false);
        setTranslationStatus('❌ Microphone access denied for speech recognition');
        alert('Microphone access for speech recognition was denied. Please allow it and try again.');
      } else if (event.error === 'network') {
        setTranslationStatus('❌ Speech recognition network error — check your connection');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.warn('⚠️ Speech recognition error:', event.error);
      }
    };

    // Chrome ends recognition after silence — restart while auto-translate is on
    recognition.onend = () => {
      if (speechActiveRef.current) {
        try { recognition.start(); } catch (e) { /* already starting */ }
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setTranslationStatus('🎤 Listening...');
      console.log('✅ Speech recognition started (lang: ' + recognition.lang + ')');
    } catch (error) {
      console.error('❌ Error starting speech recognition:', error);
      speechActiveRef.current = false;
      recognitionRef.current = null;
      setTranslationEnabled(false);
      alert('Failed to start speech recognition: ' + error.message);
    }
  }, [roomId]);

  const stopContinuousTranslation = useCallback(() => {
    speechActiveRef.current = false;
    if (recognitionRef.current) {
      console.log('🛑 Stopping continuous translation...');
      try { recognitionRef.current.stop(); } catch (e) {}
      recognitionRef.current = null;
    }
    setTranslationEnabled(false);
    setTranslationStatus('');
    console.log('✅ Continuous translation stopped');
  }, []);

  const toggleContinuousTranslation = useCallback(() => {
    if (translationEnabled) {
      stopContinuousTranslation();
    } else {
      startContinuousTranslation();
    }
  }, [translationEnabled, startContinuousTranslation, stopContinuousTranslation]);

  // Change translation language mid-meeting
  const changeTranslationLanguage = useCallback((newLang) => {
    setTranslationLanguage(newLang);
    if (socketRef.current?.connected) {
      socketRef.current.emit('update-language', { translationLanguage: newLang });
    }
    if (translationEnabled) {
      stopContinuousTranslation();
      setTimeout(() => startContinuousTranslation(), 200);
    }
    console.log(`🌐 Translation language changed to: ${newLang}`);
  }, [translationEnabled, stopContinuousTranslation, startContinuousTranslation]);

  // Change speaker language mid-meeting (what the user speaks in, used by speech recognition)
  const changeSpeakerLanguage = useCallback((newLang) => {
    setSpeakerLanguage(newLang);
    if (socketRef.current?.connected) {
      socketRef.current.emit('update-language', { speakerLanguage: newLang });
    }
    if (translationEnabled) {
      stopContinuousTranslation();
      setTimeout(() => startContinuousTranslation(), 200);
    }
    console.log(`🎤 Speaker language changed to: ${newLang}`);
  }, [translationEnabled, stopContinuousTranslation, startContinuousTranslation]);

  const clearTranscriptions = useCallback(() => {
    setTranscriptionResults([]);
  }, []);

  // Recording functions
  const startRecording = useCallback(async (type = 'both') => {
    try {
      console.log(`🎥 Starting ${type} recording...`);
      
      let stream;
      const currentStream = isScreenSharing ? screenStreamRef.current : localStreamRef.current;
      
      if (type === 'video' || type === 'both') {
        // Record video (and audio if 'both')
        const constraints = {
          video: true,
          audio: type === 'both'
        };
        stream = currentStream;
      } else if (type === 'audio') {
        // Record audio only
        stream = new MediaStream();
        const audioTrack = currentStream.getAudioTracks()[0];
        if (audioTrack) {
          stream.addTrack(audioTrack);
        }
      }

      if (!stream) {
        throw new Error('No stream available for recording');
      }

      recordingStreamRef.current = stream;
      setRecordingType(type);
      
      // Create MediaRecorder
      const options = {
        mimeType: 'video/webm;codecs=vp9,opus'
      };
      
      // Fallback for different browsers
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
          options.mimeType = 'video/webm';
          if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = '';
          }
        }
      }

      mediaRecorderRef.current = new MediaRecorder(stream, options);
      const chunks = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        console.log('🎥 Recording stopped, processing...');
        const blob = new Blob(chunks, { 
          type: type === 'audio' ? 'audio/webm' : 'video/webm' 
        });
        
        const url = URL.createObjectURL(blob);
        const timestamp = new Date().toLocaleString();
        const filename = `${type}_recording_${Date.now()}.webm`;
        
        const newRecording = {
          id: Date.now(),
          type,
          url,
          blob,
          filename,
          timestamp,
          duration: 0 // Will be calculated when played
        };

        setRecordings(prev => [...prev, newRecording]);
        console.log(`✅ Recording saved: ${filename}`);
        
        // Clear chunks
        chunks.length = 0;
      };

      mediaRecorderRef.current.start(1000); // Collect data every second
      setIsRecording(true);
      setRecordedChunks([]);
      
      console.log(`✅ ${type} recording started`);
      
    } catch (error) {
      console.error('❌ Error starting recording:', error);
      alert('Failed to start recording. Please check your browser permissions.');
    }
  }, [isScreenSharing]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      console.log('🛑 Stopping recording...');
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      console.log('✅ Recording stopped');
    }
  }, [isRecording]);

  const downloadRecording = useCallback((recording) => {
    const link = document.createElement('a');
    link.href = recording.url;
    link.download = recording.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    console.log(`📥 Downloaded: ${recording.filename}`);
  }, []);

  const deleteRecording = useCallback((recordingId) => {
    setRecordings(prev => {
      const recording = prev.find(r => r.id === recordingId);
      if (recording) {
        URL.revokeObjectURL(recording.url);
        console.log(`🗑️ Deleted recording: ${recording.filename}`);
      }
      return prev.filter(r => r.id !== recordingId);
    });
  }, []);

  const leaveCall = useCallback(() => {
    console.log('👋 Leaving call...');
    cleanup();
    navigate('/');
  }, [navigate]);

  // Admin-only functions
  const removeParticipant = useCallback((participantId) => {
    if (!isAdmin) {
      console.log('❌ Only admin can remove participants');
      alert('Only the host can remove participants');
      return;
    }
    
    const participant = participants.find(p => p.id === participantId);
    if (!participant) {
      console.log('❌ Participant not found');
      return;
    }
    
    if (window.confirm(`Remove ${participant.name} from the meeting?\n\nThey will be immediately disconnected and cannot rejoin unless invited again.`)) {
      console.log('👑 Admin removing participant:', participantId);
      socketRef.current.emit('admin-remove-participant', { participantId });
      
      // Optimistically update UI (will be confirmed by server event)
      setParticipants(prev => prev.filter(p => p.id !== participantId));
    }
  }, [isAdmin, participants]);

  const endMeeting = useCallback(() => {
    if (!isAdmin) {
      console.log('❌ Only admin can end meeting');
      alert('Only the host can end the meeting');
      return;
    }
    
    const participantCount = participants.length;
    const confirmMessage = participantCount > 0 
      ? `End the meeting for all ${participantCount + 1} participants?\n\nEveryone will be disconnected immediately.`
      : 'End the meeting?\n\nThe room will be closed.';
    
    if (window.confirm(confirmMessage)) {
      console.log('👑 Admin ending meeting');
      socketRef.current.emit('admin-end-meeting');
      
      // Show ending message
      setConnectionStatus('Ending meeting...');
      
      // Clean up and navigate after a brief delay
      setTimeout(() => {
        cleanup();
        navigate('/');
      }, 2000);
    }
  }, [isAdmin, participants.length, navigate]);

  const cleanup = () => {
    console.log('🧹 Cleaning up...');
    
    // Clean up noise suppression pipeline
    cleanupNoiseSuppression();
    
    // Stop meeting timer
    if (meetingTimerRef.current) {
      clearInterval(meetingTimerRef.current);
      meetingTimerRef.current = null;
    }

    // Stop TTS and clear queue
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    ttsQueueRef.current = [];
    ttsSpeakingRef.current = false;
    setTtsSpeaking(false);

        // Stop continuous translation if active
    stopContinuousTranslation();

                  // Clear live caption timeouts
    captionTimeoutsRef.current.forEach(timeout => clearTimeout(timeout));
    captionTimeoutsRef.current.clear();
    setLiveCaptions(new Map());
    // Clear any pending interim debounce timer
    if (interimDebounceRef.current) {
      clearTimeout(interimDebounceRef.current);
      interimDebounceRef.current = null;
    }
    
    // Stop recording if active
    if (isRecording && mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }

    // Stop auto recording and save history
    stopAutoRecording();
    saveMeetingHistory(recordings.length + (autoRecorderRef.current ? 1 : 0));
    
    // Stop local stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
        console.log(`🛑 Stopped ${track.kind} track`);
      });
    }
    
    // Stop screen share stream
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
    }
    
    // Close all peer connections
    peersRef.current.forEach((peer, peerId) => {
      peer.close();
      console.log(`🔌 Closed peer connection for ${peerId}`);
    });
    peersRef.current.clear();
    
    // Disconnect socket
    if (socketRef.current) {
      socketRef.current.disconnect();
      console.log('🔌 Socket disconnected');
    }
  };

  if (error) {
    return (
      <div className="video-call-container">
        <div className="error-screen">
          <h2>Connection Error</h2>
          <p>{error}</p>
          <button onClick={() => navigate('/')} className="btn btn-primary">
            Return Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="video-call-container">
      {/* Audio Feedback Warning */}
      {showAudioWarning && (
        <div className="audio-warning">
          <div className="warning-content">
            <div className="warning-icon">🎧</div>
            <div className="warning-text">
              <h3>Use Headphones for Better Audio</h3>
              <p>To prevent echo and feedback, please use headphones or earphones during the call.</p>
            </div>
            <button 
              className="warning-close"
              onClick={() => setShowAudioWarning(false)}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="video-call-header">
        <div className="room-info">
          <h2>Room: {roomId} {isAdmin && <span className="admin-crown">👑</span>}</h2>
          {roomInfo && <p>Host: {roomInfo.creatorName}</p>}
          <p>Participants: {participantCount}</p>
        </div>
        <div className="meeting-timer-section">
          <div className="auto-rec-badge">
            <span className="rec-dot"></span> REC
          </div>
          {noiseSuppressionEnabled && noiseSuppressionSupported && (
            <div className="noise-suppression-badge" title="Background noise suppression active">
              <span className="ns-dot"></span> Noise Suppression
            </div>
          )}
          <div className="meeting-elapsed">⏱ {meetingTimer}</div>
          {timeUntilEnd !== null && (
            <div className={`meeting-end-countdown ${timeUntilEnd < 300000 ? 'warning' : ''}`}>
              {timeUntilEnd === 0
                ? '⏰ Meeting ended'
                : `⏰ Ends in ${Math.floor(timeUntilEnd / 60000)}m ${Math.floor((timeUntilEnd % 60000) / 1000)}s`}
            </div>
          )}
          {roomInfo?.meetingDate && roomInfo?.meetingTime && (
            <div className="meeting-schedule">
              📅 {roomInfo.meetingDate} {roomInfo.meetingTime}
              {roomInfo.meetingEndTime && ` – ${roomInfo.meetingEndTime}`}
            </div>
          )}
        </div>
        <div className="connection-info">
          <div className="connection-quality">
            <span className="quality-label">Connection:</span>
            <div className="quality-bars">
              <div className="bar bar-1 active"></div>
              <div className="bar bar-2 active"></div>
              <div className="bar bar-3 active"></div>
              <div className="bar bar-4"></div>
            </div>
          </div>
          <div className="connection-status">
            <span className={`status-indicator ${connectionStatus.toLowerCase()}`}>
              {connectionStatus}
            </span>
          </div>
        </div>
      </div>

      {/* Floating Participant Icon */}
      <button
        className={`floating-participants-btn ${showPeople ? 'active' : ''}`}
        onClick={() => setShowPeople(prev => !prev)}
        title="Show participants"
        aria-label={`Participants: ${participantCount}`}
      >
        <span className="floating-participants-icon">👥</span>
        <span className="floating-participants-count">{participantCount}</span>
      </button>

      {/* Main Content Area */}
      <div className="main-content">
        {/* Video Grid */}
        <div className={`video-grid ${showChat || showPeople ? 'with-sidebar' : ''}`}>
          {/* Local video */}
          <div className="video-wrapper local-video">
            <video
              ref={localVideoRef}
              autoPlay
              muted
              playsInline
              className={`video ${!isVideoEnabled ? 'video-disabled' : ''}`}
            />
            <div className="video-label">
              You{isAdmin && ' (Host) 👑'} {!isVideoEnabled && '(Video Off)'}
              {isScreenSharing && ' (Screen Sharing)'}
              {hasRaisedHand && ' ✋'}
            </div>
            <div className="video-controls-overlay">
              <button
                onClick={toggleVideo}
                className={`mini-control-btn ${!isVideoEnabled ? 'disabled' : ''}`}
                title={isVideoEnabled ? 'Turn off video' : 'Turn on video'}
              >
                {isVideoEnabled ? '📹' : '📹❌'}
              </button>
              <button
                onClick={toggleAudio}
                className={`mini-control-btn ${!isAudioEnabled ? 'disabled' : ''}`}
                title={isAudioEnabled ? 'Mute audio' : 'Unmute audio'}
              >
                {isAudioEnabled ? '🎤' : '🎤❌'}
              </button>
                        </div>
            {liveCaptions.has(socketRef.current?.id) && (
              <div className={`subtitle-overlay local${liveCaptions.get(socketRef.current?.id)?.isInterim ? ' interim' : ''}`}>
                {liveCaptions.get(socketRef.current?.id)?.original && (
                  <div className="subtitle-original">{liveCaptions.get(socketRef.current?.id).original}</div>
                )}
                <div className="subtitle-text">{liveCaptions.get(socketRef.current?.id).text}</div>
              </div>
            )}
          </div>

                    {/* Remote videos - ONLY render actual participants with valid data */}
          {participants
            .filter(participant => participant && participant.id && participant.name)
            .map((participant, index) => {
              const remoteStream = remoteStreams.get(participant.id);
              console.log(`🎥 Rendering participant: ${participant.name} (${participant.id}), hasStream: ${!!remoteStream}`);
              return (
                <RemoteVideo
                  key={participant.id}
                  participant={participant}
                  stream={remoteStream}
                  index={index}
                  raisedHands={raisedHands}
                  translationActive={translationEnabled}
                  ttsEnabled={ttsEnabled}
                                  globalMuteOriginal={muteOriginalAudio}
                  liveCaption={liveCaptions.get(participant.id)}
                />
              );
            })}
        </div>

        {/* Sidebar */}
        {(showChat || showPeople || showRecordings || showTranscriptions) && (
          <div className="sidebar">
            {showChat && (
              <div className="chat-panel">
                <div className="chat-header">
                  <h3>Chat</h3>
                  <button onClick={() => setShowChat(false)}>✕</button>
                </div>
                <div className="chat-messages">
                  {chatMessages.map(msg => (
                    <div key={msg.id} className="chat-message">
                      <strong>{msg.senderName}:</strong> {msg.message}
                      <span className="timestamp">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="chat-input">
                  <input
                    type="text"
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyPress={(e) => e.key === 'Enter' && sendChatMessage()}
                    placeholder="Type a message..."
                  />
                  <button onClick={sendChatMessage}>Send</button>
                </div>
              </div>
            )}

            {showPeople && (
              <div className="people-panel">
                <div className="people-header">
                  <h3>Participants ({participantCount})</h3>
                  <button onClick={() => setShowPeople(false)}>✕</button>
                </div>
                <div className="people-list">
                  <div className="participant-item self-participant">
                    <div className="participant-info">
                      <span className="participant-name">
                        You{isAdmin && ' (Host)'}
                        {isAdmin && <span className="admin-crown">👑</span>}
                      </span>
                      {hasRaisedHand && <span className="raised-hand">✋</span>}
                    </div>
                    <div className="participant-status">
                      {isVideoEnabled ? '📹' : '📹❌'}
                      {isAudioEnabled ? '🎤' : '🎤❌'}
                    </div>
                  </div>
                  
                  {participants.map(participant => (
                    <div key={participant.id} className="participant-item">
                      <div className="participant-info">
                        <span className="participant-name">
                          {participant.name}
                          {participant.isAdmin && ' (Host)'}
                          {participant.isAdmin && <span className="admin-crown">👑</span>}
                        </span>
                        {raisedHands.some(h => h.participantId === participant.id) && 
                          <span className="raised-hand">✋</span>
                        }
                      </div>
                      <div className="participant-controls">
                        <div className="participant-status">
                          {participant.isVideoEnabled ? '📹' : '📹❌'}
                          {participant.isAudioEnabled ? '🎤' : '🎤❌'}
                        </div>
                        {isAdmin && !participant.isAdmin && (
                          <button 
                            className="remove-participant-btn"
                            onClick={() => removeParticipant(participant.id)}
                            title={`Remove ${participant.name} from meeting`}
                          >
                            🚫
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                
                {isAdmin && (
                  <div className="admin-controls">
                    <div className="admin-info">
                      <span className="admin-badge">👑 Host Controls</span>
                    </div>
                    <button 
                      className="end-meeting-btn"
                      onClick={endMeeting}
                      title="End meeting for all participants"
                    >
                      🔚 End Meeting for All
                    </button>
                  </div>
                )}
              </div>
            )}

            {showRecordings && (
              <div className="recordings-panel">
                <div className="recordings-header">
                  <h3>My Recordings ({recordings.length})</h3>
                  <button onClick={() => setShowRecordings(false)}>✕</button>
                </div>
                <div className="recordings-list">
                  {recordings.length === 0 ? (
                    <div className="no-recordings">
                      <p>No recordings yet</p>
                      <p>Use the record button to start recording</p>
                    </div>
                  ) : (
                    recordings.map(recording => (
                      <div key={recording.id} className="recording-item">
                        <div className="recording-info">
                          <div className="recording-type">
                            {recording.type === 'both' && '🎥'}
                            {recording.type === 'video' && '📹'}
                            {recording.type === 'audio' && '🎤'}
                            <span>{recording.type === 'both' ? 'Video + Audio' : 
                                   recording.type === 'video' ? 'Video Only' : 'Audio Only'}</span>
                          </div>
                          <div className="recording-timestamp">{recording.timestamp}</div>
                        </div>
                        <div className="recording-preview">
                          {recording.type !== 'audio' ? (
                            <video 
                              src={recording.url} 
                              controls 
                              width="100%" 
                              height="120"
                              style={{borderRadius: '8px'}}
                            />
                          ) : (
                            <audio 
                              src={recording.url} 
                              controls 
                              style={{width: '100%'}}
                            />
                          )}
                        </div>
                        <div className="recording-actions">
                          <button 
                            onClick={() => downloadRecording(recording)}
                            className="download-btn"
                            title="Download recording"
                          >
                            📥 Download
                          </button>
                          <button 
                            onClick={() => deleteRecording(recording.id)}
                            className="delete-btn"
                            title="Delete recording"
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {showTranscriptions && (
              <div className="transcriptions-panel">
                <div className="transcriptions-header">
                  <h3>🌐 Translations ({transcriptionResults.length}){ttsSpeaking && <span className="tts-speaking-dot" title="Speaking..."> 🔊</span>}</h3>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <button
                      onClick={() => {
                        const next = !ttsEnabled;
                        setTtsEnabled(next);
                        if (next) {
                          unlockTts();
                        } else {
                          // Muting — cancel current speech and clear queue
                          if (window.speechSynthesis) window.speechSynthesis.cancel();
                          ttsQueueRef.current = [];
                          ttsSpeakingRef.current = false;
                          setTtsSpeaking(false);
                        }
                      }}
                      title={ttsEnabled ? 'Mute voice output' : 'Enable voice output'}
                      style={{
                        background: ttsEnabled ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)',
                        border: 'none', color: 'white', borderRadius: '50%',
                        width: '32px', height: '32px', cursor: 'pointer',
                        fontSize: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center'
                      }}
                    >
                      {ttsEnabled ? '🔊' : '🔇'}
                    </button>
                    <button onClick={() => setShowTranscriptions(false)}>✕</button>
                  </div>
                </div>
                <div className="transcriptions-list">
                  {transcriptionResults.length === 0 ? (
                    <div className="no-transcriptions">
                      <p>No translations yet</p>
                      {translationEnabled ? (
                        <div className="translation-status-active">
                          <p>🎤 Auto-Translate is ON</p>
                          <p className="status-detail">{translationStatus || 'Listening for speech...'}</p>
                          <p className="status-hint">Just speak — captions and translations appear live</p>
                        </div>
                      ) : (
                        <p>Click the Auto-Translate button to start</p>
                      )}
                    </div>
                  ) : (
                    transcriptionResults.map(result => (
                      <div key={result.id} className={`transcription-item${result.isFallback ? ' fallback-item' : ''}`}>
                        <div className="transcription-header">
                          <div className="transcription-speaker">
                            🗣️ {result.speakerName || 'Unknown'}
                          </div>
                          <div className="transcription-time">{result.timestamp}</div>
                        </div>
                        <div className="transcription-content">
                          <div className="original-text">
                            <strong>Original:</strong>
                            <p>{result.original}</p>
                          </div>
                          <div className="translation-arrow">↓</div>
                          <div className="translated-text">
                            <strong>Translated ({result.targetLanguageName}):</strong>
                            <p>{result.translated}</p>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {transcriptionResults.length > 0 && (
                  <div className="transcriptions-actions">
                    <button onClick={clearTranscriptions} className="clear-btn">
                      🗑️ Clear All
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Reactions Overlay */}
      <div className="reactions-overlay">
        {reactions.map(reaction => (
          <div key={reaction.id} className="reaction-bubble">
            {reaction.reaction}
          </div>
        ))}
      </div>

      {/* Stats Modal */}
      {showStats && roomStats && (
        <div className="modal-overlay" onClick={() => setShowStats(false)}>
          <div className="stats-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Room Statistics</h3>
              <button onClick={() => setShowStats(false)}>✕</button>
            </div>
            <div className="stats-content">
              <div className="stat-item">
                <span>Total Participants:</span>
                <span>{roomStats.totalParticipants}</span>
              </div>
              <div className="stat-item">
                <span>Chat Messages:</span>
                <span>{roomStats.chatMessages}</span>
              </div>
              <div className="stat-item">
                <span>Raised Hands:</span>
                <span>{roomStats.raisedHands}</span>
              </div>
              <div className="stat-item">
                <span>Video Enabled:</span>
                <span>{roomStats.videoEnabled}</span>
              </div>
              <div className="stat-item">
                <span>Audio Enabled:</span>
                <span>{roomStats.audioEnabled}</span>
              </div>
              <div className="stat-item">
                <span>Room Duration:</span>
                <span>{Math.floor(roomStats.roomDuration / 60000)} minutes</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Whiteboard */}
      {showWhiteboard && (
        <Whiteboard
          socket={socketRef.current}
          roomInfo={roomInfo}
          participantName={location.state?.participantName || 'You'}
          onClose={() => setShowWhiteboard(false)}
        />
      )}

      {/* Control Bar */}
      <div className="control-bar">
        <div className="control-group">
          <button
            onClick={toggleAudio}
            className={`control-btn audio-btn ${!isAudioEnabled ? 'disabled' : ''}`}
            title={isAudioEnabled ? 'Mute' : 'Unmute'}
          >
            {isAudioEnabled ? '🎤' : '🎤❌'}
            <span>Mute</span>
          </button>

          {/* Noise Suppression Toggle (Krisp-equivalent via RNNoise) */}
          {noiseSuppressionSupported && (
            <button
              onClick={toggleNoiseSuppression}
              className={`control-btn noise-btn ${noiseSuppressionEnabled ? 'active' : ''}`}
              title={
                noiseSuppressionLoading
                  ? 'Loading noise suppression...'
                  : noiseSuppressionEnabled
                  ? 'Noise suppression ON — click to disable'
                  : 'Noise suppression OFF — click to enable'
              }
              disabled={noiseSuppressionLoading}
            >
              {noiseSuppressionLoading ? '⏳' : noiseSuppressionEnabled ? '🎙️' : '🔕'}
              <span>{noiseSuppressionLoading ? 'Loading...' : noiseSuppressionEnabled ? 'Noise OFF' : 'Noise ON'}</span>
            </button>
          )}
          
          <button
            onClick={toggleVideo}
            className={`control-btn video-btn ${!isVideoEnabled ? 'disabled' : ''}`}
            title={isVideoEnabled ? 'Turn off camera' : 'Turn on camera'}
          >
            {isVideoEnabled ? '📹' : '📹❌'}
            <span>Camera</span>
          </button>
          
          <button
            onClick={toggleScreenShare}
            className={`control-btn screen-btn ${isScreenSharing ? 'active' : ''}`}
            title="Share Screen"
          >
            🖥️
            <span>Share</span>
          </button>
        </div>

        <div className="control-group">
          <button
            onClick={() => setShowChat(!showChat)}
            className={`control-btn chat-btn ${showChat ? 'active' : ''}`}
            title="Chat"
          >
            💬
            <span>Chat</span>
          </button>
          
          <button
            onClick={() => setShowPeople(!showPeople)}
            className={`control-btn people-btn ${showPeople ? 'active' : ''}`}
            title="Participants"
          >
            👥
            <span>People</span>
          </button>

          <button
            onClick={toggleContinuousTranslation}
            className={`control-btn translate-btn ${translationEnabled ? 'active' : ''}`}
            title={translationEnabled ? 'Stop Auto-Translation' : 'Start Auto-Translation'}
          >
            {translationEnabled ? '🔴' : '🌐'}
            <span>
              {translationEnabled ? 'Auto-Translate ON' : 'Auto-Translate'}
            </span>
          </button>

          {/* Global original/translated audio toggle — only visible when translation is active */}
          {translationEnabled && (
            <button
              onClick={() => {
                unlockTts();
                setMuteOriginalAudio(prev => !prev);
              }}
              className={`control-btn audio-mode-btn ${muteOriginalAudio ? 'active' : ''}`}
              title={muteOriginalAudio ? 'Switch to original audio' : 'Switch to translated audio (mute original)'}
            >
              {muteOriginalAudio ? '🌐' : '🔊'}
              <span>{muteOriginalAudio ? 'Translated' : 'Original'}</span>
            </button>
          )}

          <div className="inline-language-selector" title="Change translation language">
            <LanguageSelector
              selectedLanguage={translationLanguage}
              onLanguageChange={changeTranslationLanguage}
              showLabel={false}
            />
          </div>

          <div className="inline-language-selector" title="Change speaking language (what you speak in)">
            <LanguageSelector
              selectedLanguage={speakerLanguage}
              onLanguageChange={changeSpeakerLanguage}
              showLabel={false}
              label="🎤 I speak:"
            />
          </div>

          <button
            onClick={() => setShowTranscriptions(!showTranscriptions)}
            className={`control-btn transcriptions-btn ${showTranscriptions ? 'active' : ''}`}
            title="View Translations"
          >
            📝
            <span>Translations</span>
            {transcriptionResults.length > 0 && (
              <span className="translation-count">{transcriptionResults.length}</span>
            )}
          </button>
          
          <button
            onClick={() => setShowWhiteboard(!showWhiteboard)}
            className="control-btn whiteboard-btn"
            title="Whiteboard"
          >
            📝
            <span>Whiteboard</span>
          </button>
          
          <div className="recording-controls">
            <button 
              className={`control-btn recording-btn ${isRecording ? 'recording-active' : ''}`} 
              title="Recording Options"
            >
              {isRecording ? '🔴' : '🎥'}
              <span>{isRecording ? 'Recording' : 'Record'}</span>
            </button>
            <div className="recording-menu">
              {!isRecording ? (
                <>
                  <button onClick={() => startRecording('both')}>
                    🎥 Video + Audio
                  </button>
                  <button onClick={() => startRecording('video')}>
                    📹 Video Only
                  </button>
                  <button onClick={() => startRecording('audio')}>
                    🎤 Audio Only
                  </button>
                </>
              ) : (
                <button onClick={stopRecording} className="stop-recording">
                  ⏹️ Stop Recording
                </button>
              )}
            </div>
          </div>
          
          <button
            onClick={() => setShowRecordings(!showRecordings)}
            className={`control-btn recordings-btn ${showRecordings ? 'active' : ''}`}
            title="My Recordings"
          >
            📁
            <span>Recordings</span>
            {recordings.length > 0 && (
              <span className="recording-count">{recordings.length}</span>
            )}
          </button>
        </div>

        <div className="control-group">
          <div className="reactions-dropdown">
            <button className="control-btn reactions-btn" title="Reactions">
              😊
              <span>Reactions</span>
            </button>
            <div className="reactions-menu">
              {['👍', '👎', '😊', '😂', '😮', '❤️', '👏', '🎉'].map(emoji => (
                <button key={emoji} onClick={() => sendReaction(emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </div>
          
          <button
            onClick={toggleRaiseHand}
            className={`control-btn hand-btn ${hasRaisedHand ? 'active' : ''}`}
            title="Raise Hand"
          >
            ✋
            <span>Raise Hand</span>
          </button>
          
          <button
            onClick={getStats}
            className="control-btn stats-btn"
            title="View Stats"
          >
            📊
            <span>Stats</span>
          </button>
          
          <button
            onClick={refreshConnection}
            className="control-btn refresh-btn"
            title="Refresh Connection"
          >
            🔄
            <span>Refresh</span>
          </button>
        </div>

        <div className="control-group">
          <button 
            onClick={leaveCall} 
            className="control-btn leave-btn"
            title="Leave Meeting"
          >
            📞❌
            <span>Leave</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Separate component for remote video to ensure proper re-rendering
const RemoteVideo = React.memo(({ participant, stream, index, raisedHands, translationActive, ttsEnabled, globalMuteOriginal, liveCaption }) => {
  const videoRef = useRef();
  const [isStreamActive, setIsStreamActive] = useState(false);
  // Per-video override: user can flip back to original for this specific participant
  const [hearOriginal, setHearOriginal] = useState(false);

  // Derived: should the video element play audio?
  // Mute raw audio when: (global mute OR translation is on) AND user hasn't asked to hear original for this video
  const rawAudioMuted = (translationActive || globalMuteOriginal) && !hearOriginal;

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      setIsStreamActive(true);
      console.log(`📺 Remote video set for ${participant.name}`);
    } else {
      setIsStreamActive(false);
    }
  }, [stream, participant.name]);

  // Apply volume change reactively without remounting the video element
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = rawAudioMuted ? 0 : 1;
    }
  }, [rawAudioMuted]);

  // Reset "hear original" when translation is turned off and global mute is off
  useEffect(() => {
    if (!translationActive && !globalMuteOriginal) setHearOriginal(false);
  }, [translationActive, globalMuteOriginal]);

  const colorClass = `remote-video-${(index % 6) + 1}`;
  const hasRaisedHand = raisedHands.some(h => h.participantId === participant.id);
  const connectionStatus = participant.connectionStatus || 'connecting';

  return (
    <div className={`video-wrapper remote-video ${colorClass}`}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className={`video ${!participant.isVideoEnabled ? 'video-disabled' : ''}`}
      />
      <div className="video-label">
        {participant.name}
        {participant.isAdmin && ' (Host) 👑'}
        {!participant.isVideoEnabled && ' (Video Off)'}
        {!participant.isAudioEnabled && ' (Muted)'}
        {hasRaisedHand && ' ✋'}
      </div>

      {/* Translation audio mode indicator */}
      {translationActive && (
        <div className="translation-audio-badge">
          {rawAudioMuted ? (
            <>
              <span className="tab-icon">🌐</span>
              <span>Translated audio</span>
              <button
                className="hear-original-btn"
                onClick={() => setHearOriginal(true)}
                title="Hear original audio instead of translation"
              >
                Hear original
              </button>
            </>
          ) : (
            <>
              <span className="tab-icon">🔊</span>
              <span>Original audio</span>
              <button
                className="hear-original-btn active"
                onClick={() => setHearOriginal(false)}
                title="Switch back to translated audio"
              >
                Use translation
              </button>
            </>
          )}
        </div>
      )}
      
      {/* Connection Status Overlay */}
      {(!isStreamActive || connectionStatus === 'connecting') && (
        <div className="loading-overlay">
          <div className="loading-spinner"></div>
          <p>
            {connectionStatus === 'connecting' && 'Connecting to '}
            {connectionStatus === 'connected' && !isStreamActive && 'Loading video from '}
            {connectionStatus === 'failed' && 'Connection failed with '}
            {connectionStatus === 'disconnected' && 'Reconnecting to '}
            {participant.name}...
          </p>
          <div className="connection-status-indicator">
            <span className={`status-dot ${connectionStatus}`}></span>
            <span className="status-text">{connectionStatus}</span>
          </div>
        </div>
      )}
      
      <div className="participant-status-overlay">
        {!participant.isVideoEnabled && <span className="status-icon">📹❌</span>}
        {!participant.isAudioEnabled && <span className="status-icon">🎤❌</span>}
        {connectionStatus === 'connected' && isStreamActive && (
          <span className="status-icon connected">🟢</span>
        )}
            </div>

      {liveCaption && (
        <div className={`subtitle-overlay remote${liveCaption?.isInterim ? ' interim' : ''}`}>
          {liveCaption.original && (
            <div className="subtitle-original">{liveCaption.original}</div>
          )}
          <div className="subtitle-text">{liveCaption.text}</div>
        </div>
            )}
    </div>
  );
});

export default VideoCall;
