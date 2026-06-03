const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
const GOOGLE_IDENTITY_SCRIPT_ID = 'google-identity-services';
const STORAGE_KEY = 'photo-admin-session';

export function loadGoogleIdentityScript() {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Window is not available.'));
  }

  if (window.google?.accounts?.id) {
    return Promise.resolve(window.google);
  }

  const existing = document.getElementById(GOOGLE_IDENTITY_SCRIPT_ID);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve(window.google), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google script failed to load.')), {
        once: true,
      });
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = GOOGLE_IDENTITY_SCRIPT_ID;
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google);
    script.onerror = () => reject(new Error('Google script failed to load.'));
    document.head.appendChild(script);
  });
}

export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = window.atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const decoded = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export function saveAdminSession(profile, credential = '') {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...profile,
      credential,
    }),
  );
}

export function loadAdminSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const session = JSON.parse(raw);
    if (!session?.credential) {
      return session;
    }

    const decoded = decodeJwt(session.credential);
    if (!decoded) {
      return session;
    }

    const repairedSession = {
      ...session,
      ...decoded,
      credential: session.credential,
    };

    if (JSON.stringify(repairedSession) !== JSON.stringify(session)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(repairedSession));
    }

    return repairedSession;
  } catch {
    return null;
  }
}

export function clearAdminSession() {
  localStorage.removeItem(STORAGE_KEY);
}

export function getConfiguredAdminEmails() {
  return (import.meta.env.VITE_ADMIN_EMAILS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedAdminEmail(email) {
  const configured = getConfiguredAdminEmails();

  if (configured.length === 0) {
    return true;
  }

  return configured.includes(email.toLowerCase());
}
