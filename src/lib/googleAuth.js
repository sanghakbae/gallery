import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { auth, googleProvider, isFirebaseConfigured } from './firebase';

export { isFirebaseConfigured };

// Turn a Firebase User into the lightweight profile shape the UI expects.
export function toAdminProfile(user) {
  if (!user) {
    return null;
  }

  return {
    uid: user.uid,
    email: user.email || '',
    name: user.displayName || user.email || '',
    picture: user.photoURL || '',
  };
}

// Subscribe to auth state changes. The callback receives a profile or null.
export function subscribeToAdminSession(callback) {
  return onAuthStateChanged(auth, (user) => {
    callback(toAdminProfile(user));
  });
}

export function getCurrentAdmin() {
  return toAdminProfile(auth.currentUser);
}

// Returns a fresh Firebase ID token for the signed-in admin (or '' if none).
export async function getAdminIdToken(forceRefresh = false) {
  const user = auth.currentUser;
  if (!user) {
    return '';
  }

  return user.getIdToken(forceRefresh);
}

export async function signInWithGoogle() {
  const result = await signInWithPopup(auth, googleProvider);
  return toAdminProfile(result.user);
}

export async function signOutAdmin() {
  await signOut(auth);
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

  return configured.includes((email ?? '').toLowerCase());
}
