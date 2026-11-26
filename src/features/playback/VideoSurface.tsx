import { useContext, useEffect, useLayoutEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import Hls from "hls.js";
import AmbientGlow from "./AmbientGlow";
import { setBalanceVolume } from "./balanceVolume";
import { platform } from "../../shared/api/api";
import { PageCoveredContext } from "../../shared/model/pageVisibility";
import { connectNativeMedia, playbackSource } from "./mediaTransport";
import { mediaErrorMessage } from "./mediaErrors";
import { mediaHost, mediaResource, usePlayerDiagnostics } from "../../shared/diagnostics/playbackDiagnostics";
import { observeHls } from "../../shared/diagnostics/hlsDiag";
import { usePlaybackActivity } from "./usePlaybackActivity";
import { useProxyPlaybackRecovery } from "./useProxyPlaybackRecovery";
import { createHlsRecovery, type HlsRecovery } from "./hlsRecovery";

export type VideoHandle = {
  el: () => HTMLVideoElement | null;
  play: () => void;
  retry: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number, source?: string) => void;
  /** 结束态“重新看第 1 集”：当前这条片源倒回 0 并立刻起播（与手动 seek 是两条路） */
  rewind: () => void;
  trace: (event: string, data?: Record<string, unknown>) => void;
  rate: (r: number) => void;
  mute: (m: boolean) => void;
  volume: (v: number) => void;
};

type Props = {
  src: string;
  poster?: string;
  autoPlay?: boolean;
  active?: boolean;
  measurementKey?: string;
  diagnosticContext?: Record<string, unknown>;
  muted?: boolean;
  loop?: boolean;
  fit?: "contain" | "cover";
  /** 背景透明：letterbox 时让视频不要自己把整块舞台涂黑，下面的层才看得见 */
  transparentBg?: boolean;
  /** 微光效果：从当前画面采样色晕铺在黑边（上游 PR #192），需要可读的播放源 */
  ambientGlow?: boolean;
  /** 平衡音量（POC，默认关）：把音频接进 Web Audio 做响度归一，见 balanceVolume.ts */
  balanceVolume?: boolean;
  /** 换源后重新套用，避免切集时音量/倍速被浏览器重置 */
  volume?: number;
  rate?: number;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onSize?: (w: number, h: number, measurementKey: string) => boolean | void;
  onPlaying?: () => void;
  onPause?: () => void;
  onWaiting?: () => void;
  onEnded?: () => void;
  onError?: (msg: string) => void;
  onClick?: () => void;
  className?: string;
};

/** 只负责「播」：hls.js + video 元素，控制条由外层渲染。 */
const VideoSurface = forwardRef<VideoHandle, Props>(function VideoSurface(
  { src, poster, autoPlay = true, active = true, measurementKey = src, diagnosticContext = {}, muted = false, loop = false, fit = "contain", volume = 1, rate = 1,
    onTime, onDuration, onSize, onPlaying, onPause, onWaiting, onEnded, onError, onClick, className = "", transparentBg = false, ambientGlow = false, balanceVolume = false },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const latestSource = useRef(src); latestSource.current = src;
  const attachedSource = useRef<string | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const recoveryRef = useRef<HlsRecovery | null>(null);
  const nearEndFiredRef = useRef(false);
  const reportedSizeRef = useRef({ key: "", w: 0, h: 0 });
  const measurementRef = useRef({ key: measurementKey, onSize });
  measurementRef.current = { key: measurementKey, onSize };
  const [ready, setReady] = useState(false);
  const pageCovered = useContext(PageCoveredContext);
  const [inPip, setInPip] = useState(false);
  const suspended = pageCovered && !inPip;
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const { trace, requestSeek } = usePlayerDiagnostics(videoRef, hlsRef, { ...diagnosticContext, active, resource: mediaResource(src) });
  const activity = usePlaybackActivity(videoRef, hlsRef, { active, autoPlay, src, trace });
  const proxyRecovery = useProxyPlaybackRecovery(videoRef, src, activity, trace);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const syncPip = () => setInPip(document.pictureInPictureElement === v);
    v.addEventListener("enterpictureinpicture", syncPip);
    v.addEventListener("leavepictureinpicture", syncPip);
    syncPip();
    return () => {
      v.removeEventListener("enterpictureinpicture", syncPip);
      v.removeEventListener("leavepictureinpicture", syncPip);
    };
  }, []);

  const reportSize = (v: HTMLVideoElement | null) => {
    if (!v || v !== videoRef.current || attachedSource.current !== latestSource.current || v.readyState < 1) return;
    const w = v.videoWidth || 0;
    const h = v.videoHeight || 0;
    const current = measurementRef.current;
    if (w > 0 && h > 0 && (current.key !== reportedSizeRef.current.key || w !== reportedSizeRef.current.w || h !== reportedSizeRef.current.h)) {
      // A parent may reject an event during an item transition. Keep it eligible
      // for the next metadata/resize event instead of losing the size forever.
      if (current.onSize?.(w, h, current.key) !== false) {
        reportedSizeRef.current = { key: current.key, w, h };
      }
    }
  };

  useLayoutEffect(() => {
    // Re-emit existing metadata when the same source becomes current again.
    // A newly selected source is ignored until its transport has been attached.
    reportedSizeRef.current = { key: "", w: 0, h: 0 };
    reportSize(videoRef.current);
  }, [measurementKey, src, active]);

  useImperativeHandle(ref, () => ({
    el: () => videoRef.current,
    play: () => activity.play("handle"),
    retry: () => { if (activity.isActive()) proxyRecovery.retry("manual", true); },
    pause: () => activity.pause(),
    toggle: () => {
      const v = videoRef.current;
      if (!v) return;
      trace("toggle.request");
      if (v.paused) activity.play("toggle"); else activity.pause("toggle");
    },
    seek: (t: number, source = "handle") => {
      const v = videoRef.current;
      if (!v || !Number.isFinite(t)) return;
      // iOS 上直接赋到 duration 会卡在 ended 态，夹到结尾前 0.15s
      const dur = v.duration && Number.isFinite(v.duration) ? v.duration : 0;
      const target = dur > 0 ? Math.max(0, Math.min(dur - 0.15, t)) : Math.max(0, t);
      requestSeek(target, source);
      if (hlsRef.current) { try { hlsRef.current.startLoad(target); } catch { /* ignore */ } }
      const resume = !v.paused;
      try { v.currentTime = target; trace("seek.assigned", { target, source }); }
      catch (e) { trace("seek.rejected", { error_name: (e as Error).name }); throw e; }
      if (resume) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    },
    /* 结束态“重新看第 1 集”：把当前片源倒回 0 并起播。
       与上面的 seek() 是两条路 —— seek 只动位置、是否续播看当前 paused；
       这里无条件起播，并且**重新武装片尾兜底**（nearEndFiredRef 只在换源时复位，
       同一集重播若不复位，iOS 上第二次到片尾就不会再补 ended，结束卡就再也出不来）。 */
    rewind: () => {
      const v = videoRef.current;
      if (!v) return;
      nearEndFiredRef.current = false;
      requestSeek(0, "replay");
      if (hlsRef.current) { try { hlsRef.current.startLoad(0); } catch { /* ignore */ } }
      try { v.currentTime = 0; trace("replay.rewind"); }
      catch (e) { trace("replay.rejected", { error_name: (e as Error).name }); }
      activity.play("replay");
    },
    trace,
    rate: (r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; },
    mute: (m: boolean) => { const v = videoRef.current; if (v) v.muted = m; },
    volume: (vol: number) => { const v = videoRef.current; if (v) v.volume = vol; },
  }), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src || suspended) return;
    attachedSource.current = null;
    setReady(false);
    reportedSizeRef.current = { key: "", w: 0, h: 0 };
    nearEndFiredRef.current = false;
    const resume = proxyRecovery.resume();
    const onVideoResize = () => reportSize(video);
    video.addEventListener("resize", onVideoResize);
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }

    const source = playbackSource(src, Hls.isSupported());
    let disconnectNative: (() => void) | undefined;
    trace("source.load", { engine: source.engine, auto_play: autoPlay, resource: mediaResource(src), host: mediaHost(src) });

    /* 换源时先把音量/倍速套回去：hls 重新 attach 后浏览器会把它们重置成默认值 */
    const applySettings = () => {
      const v = videoRef.current;
      if (!v) return;
      v.volume = volume;
      v.muted = muted;
      v.playbackRate = rate;
    };
    applySettings();
    attachedSource.current = src;

    if (source.engine === "hls.js") {
      const hls = new Hls({
        // 禁用从插播/内容引导 JSON 派生直连 URL 的可选功能。
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
        // WKWebView 里 hls.js 的 worker 不稳，iOS 关掉
        enableWorker: platform !== "ios",
        // Prefer standard MSE on macOS; hls.js handles MMS-only fallback and seek recovery.
        preferManagedMediaSource: false,
        autoStartLoad: false,
        startPosition: resume?.time ?? -1,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        backBufferLength: 30,
        maxBufferHole: 0.5,
        nudgeOffset: 0.25,
        nudgeMaxRetry: 6,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 4,
        fragLoadingTimeOut: 25000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 400,
      });
      hlsRef.current = hls;
      const recovery = createHlsRecovery({
        hls, video, url: source.url,
        isCurrent: () => hlsRef.current === hls,
        isActive: activity.isActive,
        resumePlayback: () => activity.play("media_recovery", true),
        onFatal: data => {
          onError?.(`${data.type}/${data.details}`);
          if (data.type !== Hls.ErrorTypes.NETWORK_ERROR && data.type !== Hls.ErrorTypes.MEDIA_ERROR) {
            hls.destroy(); hlsRef.current = null;
          }
        },
      });
      recoveryRef.current = recovery;
      observeHls(hls, trace);
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (activity.isActive()) hls.startLoad(resume?.time ?? -1);
        if (autoPlay && !resume) activity.play("manifest_autoplay", true);
      });
      hls.on(Hls.Events.FRAG_BUFFERED, () => recovery.buffered());
      hls.on(Hls.Events.ERROR, (_e, data) => recovery.error(data));
    } else {
      disconnectNative = connectNativeMedia(video, source, {
        isCurrent: () => latestSource.current === src && videoRef.current === video,
        onReady: () => { if (activity.isPlayWanted() && !resume) activity.play("native_autoplay", true); },
        onError: message => { trace("source.transport_error"); onError?.(message); },
      });
    }

    return () => {
      const releasingCovered = suspendedRef.current && latestSource.current === src;
      if (releasingCovered) proxyRecovery.stash("page_covered");
      attachedSource.current = null;
      disconnectNative?.();
      video.removeEventListener("resize", onVideoResize);
      recoveryRef.current?.dispose(); recoveryRef.current = null;
      trace("source.cleanup", releasingCovered ? { suspended: true } : undefined);
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      if (releasingCovered) {
        // Release Chromium/Android WebView MediaCodec & SurfaceTexture while covered by a stack page.
        video.srcObject = null;
        video.removeAttribute("src");
        video.load();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, proxyRecovery.revision, suspended]);

  useLayoutEffect(() => { recoveryRef.current?.activityChanged(); }, [active]);

  // iOS 内联播放：部分 WKWebView 只认 HTML 属性
  useEffect(() => {
    const v = videoRef.current;
    if (v) v.setAttribute("webkit-playsinline", "true");
  }, []);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);
  useEffect(() => { if (videoRef.current) videoRef.current.volume = volume; }, [volume]);
  useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = rate; }, [rate]);

  const reapply = (v: HTMLVideoElement) => {
    v.volume = volume;
    v.muted = muted;
    v.playbackRate = rate;
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    setBalanceVolume(video, balanceVolume && active);
    return () => setBalanceVolume(video, false);
  }, [balanceVolume, active]);

  const handleVideoError = () => {
    if (hlsRef.current || suspendedRef.current) return;
    onError?.(mediaErrorMessage(videoRef.current?.error ?? null));
  };

  return (
    <div className="relative isolate h-full w-full">
      {ambientGlow && active && <AmbientGlow videoRef={videoRef} active={active} />}
    <video
      ref={videoRef}
      poster={poster}
      playsInline
      /* 微光要读画面像素：src 是本地媒体代理（LOCAL /hls、/seg），而页面源是
         http://tauri.localhost（安卓）/tauri://localhost —— **跨源**。不加 crossOrigin，
         canvas 会被判污染，drawImage 抛 SecurityError，微光静默不生效（安卓上一直是这个状态）。
         所以只要开微光就加 anonymous：MSE(blob:) 路径这个属性无副作用，
         本地代理在 lib.rs 会按请求 Origin 回 Access-Control-Allow-Origin（无 Origin 时回 *），
         /img 不受影响（它走 <img>，本来就有跨源能力）。 */
      crossOrigin={ambientGlow ? "anonymous" : undefined}
      preload="auto"
      muted={muted}
      loop={loop}
      onClick={onClick}
      /* 注意：项目里并没有 .bg-black 这个工具类（构建产物里查不到），
         <video> 的黑底是浏览器默认样式。所以这里必须用内联样式显式改掉，
         否则 letterbox 下视频会自己把整块舞台涂黑，把下面的虚化盖死。 */
      style={{ opacity: ready ? 1 : 0, transition: "opacity .35s", ...(transparentBg || ambientGlow ? { backgroundColor: "transparent" } : null) }}
      className={`relative z-[1] w-full h-full ${transparentBg || ambientGlow ? "hg-video-transparent" : ""} ${fit === "cover" ? "object-cover" : "object-contain"} ${className}`}
      onLoadedData={(e) => {
        const v = e.target as HTMLVideoElement;
        setReady(true);
        reapply(v);
        reportSize(v);
      }}
      onTimeUpdate={(e) => {
        const v = e.target as HTMLVideoElement;
        reportSize(v);
        onTime?.(v.currentTime);
        // iOS 有时不触发 ended：靠近片尾自己补一次，保证自动连播
        const d = v.duration;
        if (d && Number.isFinite(d) && v.currentTime > d - 0.3 && !nearEndFiredRef.current) {
          nearEndFiredRef.current = true;
          onEnded?.();
        }
      }}
      onLoadedMetadata={(e) => {
        const v = e.target as HTMLVideoElement;
        reapply(v);
        onDuration?.(v.duration || 0);
        reportSize(v);
      }}
      onPlay={() => { if (activity.isActive()) onPlaying?.(); }}
      onPause={() => onPause?.()}
      onWaiting={() => onWaiting?.()}
      onPlaying={(e) => {
        reportSize(e.target as HTMLVideoElement);
        if (activity.isActive()) onPlaying?.();
      }}
      onEnded={() => { if (activity.isActive()) onEnded?.(); }}
      onError={handleVideoError}
    />
    </div>
  );
});

export default VideoSurface;
