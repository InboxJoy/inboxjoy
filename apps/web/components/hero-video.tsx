"use client";

import { Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Self-hosted product tour for the homepage hero. Shows the poster first,
 * loads nothing until it nears the viewport, plays muted while at least half
 * visible and pauses when scrolled away. Visitors who prefer reduced motion
 * get a play button instead of autoplay.
 */
export function HeroVideo({ src, poster, title }: { src: string; poster: string; title: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [autoplay, setAutoplay] = useState(true);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setAutoplay(!reducedMotion);
    if (reducedMotion) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        video.preload = "auto";
        void video.play().catch(() => setAutoplay(false));
      } else {
        video.pause();
      }
    }, { threshold: 0.5 });
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const toggleSound = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
    if (video.paused) void video.play();
  };

  const startPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    video.preload = "auto";
    void video.play();
  };

  return (
    <div className="v2-hero-player">
      <video
        aria-label={title}
        loop
        muted
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        playsInline
        poster={poster}
        preload="none"
        ref={videoRef}
        src={src}
      />
      {!autoplay && !playing ? (
        <button aria-label="Play product tour" className="v2-hero-player-play" onClick={startPlayback} type="button"><Play aria-hidden="true" size={26} fill="currentColor" /></button>
      ) : null}
      <button aria-label={muted ? "Turn sound on" : "Turn sound off"} className="v2-hero-player-sound" onClick={toggleSound} type="button">
        {muted ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}
        <span>{muted ? "Sound on" : "Sound off"}</span>
      </button>
    </div>
  );
}
