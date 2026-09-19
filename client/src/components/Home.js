import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE, SOCKET_URL } from '../config';
import { io } from 'socket.io-client';
import useScrollReveal from '../hooks/useScrollReveal';
import useRipple from '../hooks/useRipple';
import './Home.css';

// Returns true if the meeting is currently joinable (within 5 min before start or already started)
function isMeetingJoinable(event) {
  if (event.isActive) return true;
  if (!event.meetingDate || !event.meetingTime) return true; // no schedule = always joinable
  try {
    const startDt = new Date(`${event.meetingDate}T${event.meetingTime}:00`);
    const now = new Date();
    return now >= startDt - 5 * 60 * 1000; // allow 5 min early
  } catch {
    return true;
  }
}

function getMeetingStatus(event) {
  if (event.isActive) return 'active';
  if (!event.meetingDate || !event.meetingTime) return 'scheduled';
  try {
    const startDt = new Date(`${event.meetingDate}T${event.meetingTime}:00`);
    const now = new Date();
    if (now >= startDt - 5 * 60 * 1000) return 'starting';
    return 'scheduled';
  } catch {
    return 'scheduled';
  }
}

function Home() {
  const [upcomingEvents, setUpcomingEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);

  const revealRef   = useScrollReveal();
  const ripple      = useRipple();

  const fetchUpcomingEvents = useCallback(async (showLoader = false) => {
    if (showLoader) setEventsLoading(true);
    console.log('📅 Fetching upcoming events from:', API_BASE);
    try {
      const response = await fetch(`${API_BASE}/rooms`);
      const serverRooms = await response.json();
      console.log('✅ Fetched rooms from server:', serverRooms.length);

      // Merge with locally saved rooms (created on this device)
      const localRooms = JSON.parse(localStorage.getItem('createdRooms') || '[]');
      const serverIds = new Set(serverRooms.map(r => r.id));
      const localOnly = localRooms.filter(r => !serverIds.has(r.id));
      const merged = [...serverRooms, ...localOnly];

      setUpcomingEvents(merged);
    } catch (error) {
      console.error('❌ Error fetching rooms:', error);
      const localRooms = JSON.parse(localStorage.getItem('createdRooms') || '[]');
      setUpcomingEvents(localRooms);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUpcomingEvents(true);

    // Poll every 15 seconds as a fallback
    const pollInterval = setInterval(fetchUpcomingEvents, 15000);

    // Refresh immediately when the user switches back to this tab
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') fetchUpcomingEvents();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Real-time socket updates
    const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'] });

    socket.on('room-created', (newRoom) => {
      console.log('🔔 New room created (socket):', newRoom.id);
      setUpcomingEvents(prev => {
        if (prev.find(r => r.id === newRoom.id)) return prev;
        return [newRoom, ...prev];
      });
    });

    socket.on('room-active', ({ id, isActive, participantCount }) => {
      console.log('🟢 Room is now active:', id);
      setUpcomingEvents(prev =>
        prev.map(r => r.id === id ? { ...r, isActive, participantCount } : r)
      );
    });

    socket.on('room-deleted', ({ id }) => {
      console.log('🗑️ Room deleted:', id);
      setUpcomingEvents(prev => prev.filter(r => r.id !== id));
    });

    return () => {
      clearInterval(pollInterval);
      document.removeEventListener('visibilitychange', handleVisibility);
      socket.disconnect();
    };
  }, [fetchUpcomingEvents]);

  return (
    <div className="home-container" ref={revealRef}>
      <div className="home-background">
        <div className="floating-shapes">
          <div className="shape shape-1"></div>
          <div className="shape shape-2"></div>
          <div className="shape shape-3"></div>
          <div className="shape shape-4"></div>
          <div className="shape shape-5"></div>
        </div>
      </div>

      <header className="home-header">
        <div className="logo-section">
          <div className="logo-icon">📹</div>
          <h1>VideoMeet Pro</h1>
        </div>
        <p className="tagline">Connect, Collaborate, Create Together</p>
        <div className="feature-badges">
          <span className="badge reveal">🎥 HD Video</span>
          <span className="badge reveal">🎤 Crystal Audio</span>
          <span className="badge reveal">🔒 Secure</span>
          <span className="badge reveal">📱 Cross-Platform</span>
        </div>
        <Link to="/history" className="history-link-btn ripple-host" onClick={ripple}>
          📋 Meeting History
        </Link>
      </header>

      <div className="main-options">
        <div className="option-card create-card reveal">
          <div className="card-icon">🚀</div>
          <h2>Create Room</h2>
          <p>Start a new video meeting and invite others to join your session</p>
          <div className="card-features">
            <span>✓ Instant room creation</span>
            <span>✓ Admin controls</span>
            <span>✓ Screen sharing</span>
          </div>
          <Link to="/create-room" className="btn btn-primary ripple-host" onClick={ripple}>
            <span className="btn-icon">➕</span>
            Create New Room
          </Link>
        </div>

        <div className="option-card join-card reveal">
          <div className="card-icon">🔗</div>
          <h2>Join Room</h2>
          <p>Join an existing meeting with Room ID and start collaborating</p>
          <div className="card-features">
            <span>✓ Quick join process</span>
            <span>✓ No downloads required</span>
            <span>✓ Works on any device</span>
          </div>
          <Link to="/join-room" className="btn btn-secondary ripple-host" onClick={ripple}>
            <span className="btn-icon">🚪</span>
            Join Existing Room
          </Link>
        </div>
      </div>

      <div className="upcoming-events">
        <div className="section-header reveal">
          <h2>📅 Upcoming Meetings</h2>
          <p>Your scheduled video conferences</p>
        </div>

        {eventsLoading ? (
          <div className="events-skeleton">
            {[1, 2, 3].map(i => (
              <div key={i} className="event-card-skeleton">
                <div className="skeleton sk-title" />
                <div className="skeleton sk-line" />
                <div className="skeleton sk-line sk-short" />
              </div>
            ))}
          </div>
        ) : upcomingEvents.length === 0 ? (
          <div className="no-events reveal">
            <div className="no-events-icon">📭</div>
            <h3>No upcoming meetings</h3>
            <p>Create a new room to get started with your first video conference</p>
          </div>
        ) : (
          <div className="events-list">
            {upcomingEvents.map((event) => {
              const status = getMeetingStatus(event);
              const joinable = isMeetingJoinable(event);
              return (
              <div key={event.id} className={`event-card reveal${event.isActive ? ' event-card--active' : ''}`}>
                <div className="event-card-top">
                  <h3 className="event-title">{event.roomName || `${event.creatorName}'s Meeting`}</h3>
                  <span className={`event-status event-status--${status}`}>
                    {status === 'active' ? '🟢 Live' : status === 'starting' ? '🟡 Starting Soon' : '🕐 Scheduled'}
                  </span>
                </div>
                <div className="event-details">
                  <div className="detail-item">
                    <span className="detail-icon">📅</span>
                    <span>{event.meetingDate || 'TBD'}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-icon">🕒</span>
                    <span>{event.meetingTime || 'TBD'}{event.meetingEndTime ? ` – ${event.meetingEndTime}` : ''}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-icon">👤</span>
                    <span>Host: {event.creatorName}</span>
                  </div>
                  <div className="detail-item">
                    <span className="detail-icon">🔗</span>
                    <span>Room ID: {event.id}</span>
                  </div>
                  {event.participantCount > 0 && (
                    <div className="detail-item">
                      <span className="detail-icon">👥</span>
                      <span>{event.participantCount} participant{event.participantCount !== 1 ? 's' : ''} in room</span>
                    </div>
                  )}
                </div>
                <div className="event-actions">
                  {joinable ? (
                    <>
                      <Link
                        to="/join-room"
                        state={{ roomId: event.id, isHost: true }}
                        className="btn-join btn-join-admin ripple-host"
                        onClick={ripple}
                      >
                        {event.isActive ? '🟢 Join as Admin' : 'Join as Admin'}
                      </Link>
                      <Link
                        to="/join-room"
                        state={{ roomId: event.id, isHost: false }}
                        className="btn-join btn-join-participant ripple-host"
                        onClick={ripple}
                      >
                        {event.isActive ? '🟢 Join as Participant' : 'Join as Participant'}
                      </Link>
                    </>
                  ) : (
                    <div className="btn-join btn-join-scheduled" title={`Scheduled for ${event.meetingDate} at ${event.meetingTime}`}>
                      ⏳ Not started yet
                    </div>
                  )}
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>

      <footer className="home-footer reveal">
        <div className="footer-content">
          <p>© 2024 VideoMeet Pro - Secure Video Conferencing</p>
          <div className="footer-links">
            <span>Privacy</span>
            <span>Terms</span>
            <span>Support</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Home;