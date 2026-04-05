import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import GalleryPage from './pages/GalleryPage';
import AdminPage from './pages/AdminPage';
import MobileGalleryPage from './pages/MobileGalleryPage';

function detectMobileClient() {
  if (typeof window === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  const agentMobile = /Android|iPhone|iPad|iPod|Mobile|CriOS|FxiOS|SamsungBrowser/i.test(userAgent);
  const coarsePointer =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(hover: none) and (pointer: coarse)').matches
      : false;

  return agentMobile || coarsePointer;
}

function App() {
  const [isMobileClient, setIsMobileClient] = useState(() => detectMobileClient());

  useEffect(() => {
    function syncClientType() {
      setIsMobileClient(detectMobileClient());
    }

    syncClientType();
    window.addEventListener('resize', syncClientType);
    window.addEventListener('orientationchange', syncClientType);

    return () => {
      window.removeEventListener('resize', syncClientType);
      window.removeEventListener('orientationchange', syncClientType);
    };
  }, []);

  return (
    <Routes>
      <Route path="/" element={isMobileClient ? <MobileGalleryPage /> : <GalleryPage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
