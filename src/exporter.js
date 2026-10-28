// 이미지(PNG) / 영상(MP4) 내보내기. MP4는 WebCodecs 프레임 단위 인코딩 + mp4-muxer.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

export const canvasToPng = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG 생성 실패'))), 'image/png'));

// 우선순위: H.264 High → Main → VP9 → AV1. (H.264가 재생 호환성이 가장 좋다.)
const CODECS = [
  { codec: 'avc1.640034', mux: 'avc', label: 'H.264 High' },
  { codec: 'avc1.640033', mux: 'avc', label: 'H.264 High' },
  { codec: 'avc1.64002a', mux: 'avc', label: 'H.264 High' },
  { codec: 'avc1.4d0034', mux: 'avc', label: 'H.264 Main' },
  { codec: 'vp09.00.51.08', mux: 'vp9', label: 'VP9' },
  { codec: 'av01.0.13M.08', mux: 'av1', label: 'AV1' },
];

export function supportsMp4Export() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

async function pickCodec(width, height, fps, bitrate) {
  for (const c of CODECS) {
    const cfg = { codec: c.codec, width, height, bitrate, framerate: fps, bitrateMode: 'constant', hardwareAcceleration: 'no-preference' };
    try {
      const r = await VideoEncoder.isConfigSupported(cfg);
      if (r.supported) return { ...c, config: r.config };
    } catch { /* 다음 코덱 */ }
  }
  throw new Error('이 브라우저는 MP4 인코딩(WebCodecs)을 지원하지 않습니다. 최신 Chrome/Edge를 사용해 주세요.');
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param renderFrame (t01, frameIndex) => canvas  — 해당 시각의 완성된 프레임 캔버스
 * @param targetMB    목표 파일 크기 (MB). 비트레이트를 여기서 역산한다.
 */
const AUDIO_BITRATE = 128000;

/** 사용 가능한 오디오 코덱 선택: AAC 우선(호환성), 없으면 Opus */
async function pickAudioCodec(sampleRate) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  for (const c of [{ codec: 'mp4a.40.2', mux: 'aac', label: 'AAC' }, { codec: 'opus', mux: 'opus', label: 'Opus' }]) {
    try {
      const r = await AudioEncoder.isConfigSupported({ codec: c.codec, sampleRate, numberOfChannels: 2, bitrate: AUDIO_BITRATE });
      if (r.supported) return { ...c, config: r.config };
    } catch { /* 다음 코덱 */ }
  }
  return null;
}

export async function exportMp4({ renderFrame, width, height, fps, durationSec, targetMB, onProgress, signal, audioBuffer = null }) {
  if (!supportsMp4Export()) throw new Error('이 브라우저는 WebCodecs를 지원하지 않습니다. 최신 Chrome/Edge를 사용해 주세요.');
  const total = Math.round(durationSec * fps);
  // 컨테이너 오버헤드·비트레이트 편차를 감안해 목표의 약 94%를 영상에 배정
  const audioCfg = audioBuffer ? await pickAudioCodec(audioBuffer.sampleRate) : null;
  const bitrate = Math.floor((targetMB * 1024 * 1024 * 8 * 0.94) / durationSec) - (audioCfg ? AUDIO_BITRATE : 0);
  const picked = await pickCodec(width, height, fps, bitrate);

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: picked.mux, width, height, frameRate: fps },
    ...(audioCfg ? { audio: { codec: audioCfg.mux, numberOfChannels: 2, sampleRate: audioBuffer.sampleRate } } : {}),
    fastStart: 'in-memory',
  });
  let error = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { error = e; },
  });
  encoder.configure(picked.config);

  const t0 = performance.now();
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) { encoder.close(); throw new DOMException('취소됨', 'AbortError'); }
    if (error) throw error;
    const canvas = renderFrame(total > 1 ? i / (total - 1) : 0, i);
    const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 6) await tick();
    if (i % 2 === 0) {
      const elapsed = (performance.now() - t0) / 1000;
      onProgress?.({ phase: 'encode', done: i + 1, total, eta: (elapsed / (i + 1)) * (total - i - 1) });
      await tick();
    }
  }
  await encoder.flush();
  if (error) throw error;
  encoder.close();

  // 오디오 트랙 (비행 사운드)
  if (audioCfg) {
    onProgress?.({ phase: 'audio', done: total, total, eta: 0 });
    const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { error = e; } });
    aenc.configure(audioCfg.config);
    const sr = audioBuffer.sampleRate, ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
    const FR = 4096;
    for (let off = 0; off < audioBuffer.length; off += FR) {
      const n = Math.min(FR, audioBuffer.length - off);
      const data = new Float32Array(n * 2);
      data.set(ch0.subarray(off, off + n), 0);
      data.set(ch1.subarray(off, off + n), n);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((off / sr) * 1e6), data });
      aenc.encode(ad);
      ad.close();
    }
    await aenc.flush();
    aenc.close();
    if (error) throw error;
  }
  muxer.finalize();
  const blob = new Blob([target.buffer], { type: 'video/mp4' });
  onProgress?.({ phase: 'done', done: total, total, eta: 0 });
  return { blob, codec: picked.label, bitrate, audio: audioCfg ? audioCfg.label : null };
}
