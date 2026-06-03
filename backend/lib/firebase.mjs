import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveServiceAccount() {
  // 1) Inline JSON (recommended for Render / hosted environments).
  const inline = String(process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (inline) {
    try {
      return JSON.parse(inline);
    } catch (error) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT is not valid JSON: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // 2) Path to a service-account key file.
  const keyPath =
    String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || '').trim() ||
    String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();

  const candidatePaths = [];
  if (keyPath) {
    candidatePaths.push(path.isAbsolute(keyPath) ? keyPath : path.resolve(process.cwd(), keyPath));
  }
  // 3) Conventional local file checked into .gitignore.
  candidatePaths.push(path.join(__dirname, '..', 'firebase-service-account.json'));

  for (const candidate of candidatePaths) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`Failed to read Firebase service account at ${candidate}: ${error.message}`);
      }
    }
  }

  return null;
}

let firestoreInstance = null;
let authInstance = null;

function ensureApp() {
  if (getApps().length > 0) {
    return;
  }

  const serviceAccount = resolveServiceAccount();
  const projectId =
    serviceAccount?.project_id || String(process.env.FIREBASE_PROJECT_ID || '').trim() || undefined;

  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount),
      projectId,
    });
    return;
  }

  // Fall back to Application Default Credentials (e.g. when running on GCP).
  if (!projectId) {
    throw new Error(
      'Firebase credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT (inline JSON) or ' +
        'FIREBASE_SERVICE_ACCOUNT_PATH, or place backend/firebase-service-account.json.',
    );
  }

  initializeApp({ projectId });
}

export function getDb() {
  if (!firestoreInstance) {
    ensureApp();
    firestoreInstance = getFirestore();
  }

  return firestoreInstance;
}

export function getAdminAuth() {
  if (!authInstance) {
    ensureApp();
    authInstance = getAuth();
  }

  return authInstance;
}

export { FieldValue };
