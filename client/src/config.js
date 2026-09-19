// Configuration for different environments
const config = {
  development: {
    API_BASE: 'http://localhost:5001/api',
    SOCKET_URL: 'http://localhost:5001'
  },
  production: {
    API_BASE: 'https://lgt-2.onrender.com/api',
    SOCKET_URL: 'https://lgt-2.onrender.com'
  }
};

// Determine current environment
// Only treat true localhost as development — ngrok/deployed URLs use production backend
const isLocalhost = window.location.hostname === 'localhost' ||
                   window.location.hostname === '127.0.0.1';

// Allow overriding via build-time env var (used by Docker / CI builds).
// e.g. REACT_APP_SIGNALING_SERVER=http://192.168.1.10:5001 npm run build
const envSocketUrl = process.env.REACT_APP_SIGNALING_SERVER;
if (envSocketUrl) {
  config.development.SOCKET_URL = envSocketUrl;
  config.development.API_BASE = `${envSocketUrl.replace(/\/$/, '')}/api`;
  config.production.SOCKET_URL = envSocketUrl;
  config.production.API_BASE = `${envSocketUrl.replace(/\/$/, '')}/api`;
}

const environment = isLocalhost ? 'development' : 'production';

console.log('🌍 Environment detected:', environment);
console.log('🔗 Current hostname:', window.location.hostname);
console.log('📡 API Base:', config[environment].API_BASE);
console.log('🔌 Socket URL:', config[environment].SOCKET_URL);

// Export current configuration
export const API_BASE = config[environment].API_BASE;
export const SOCKET_URL = config[environment].SOCKET_URL;

export default config[environment];