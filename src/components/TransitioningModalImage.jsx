import { useEffect, useRef, useState } from 'react';
import ResilientImage from './ResilientImage';

const TRANSITION_MS = 180;

export default function TransitioningModalImage({
  photo,
  alt,
  className,
  onClick,
  ...imgProps
}) {
  const [displayedPhoto, setDisplayedPhoto] = useState(photo);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const timeoutRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!photo) {
      setDisplayedPhoto(photo);
      setIsTransitioning(false);
      return undefined;
    }

    if (!displayedPhoto || displayedPhoto.id === photo.id) {
      setDisplayedPhoto(photo);
      setIsTransitioning(false);
      return undefined;
    }

    setIsTransitioning(true);
    timeoutRef.current = window.setTimeout(() => {
      setDisplayedPhoto(photo);
      frameRef.current = window.requestAnimationFrame(() => {
        setIsTransitioning(false);
      });
    }, TRANSITION_MS);

    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }

      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
      }
    };
  }, [photo, displayedPhoto]);

  useEffect(() => () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }

    if (frameRef.current) {
      window.cancelAnimationFrame(frameRef.current);
    }
  }, []);

  if (!displayedPhoto) {
    return null;
  }

  return (
    <ResilientImage
      {...imgProps}
      sources={[displayedPhoto.thumbUrl, displayedPhoto.imageUrl]}
      alt={alt}
      className={`${className} modal-image-transition${isTransitioning ? ' is-transitioning' : ''}`}
      decoding="async"
      loading="eager"
      fetchPriority="high"
      onClick={onClick}
    />
  );
}
