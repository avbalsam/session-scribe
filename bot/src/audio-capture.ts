import { Page } from "puppeteer";
import WebSocket from "ws";

/**
 * JavaScript code injected into the Zoom web client page to intercept
 * WebRTC audio tracks and stream raw PCM data back to Node.js.
 *
 * This works by monkey-patching RTCPeerConnection so that when Zoom
 * establishes WebRTC connections, we intercept the incoming audio tracks
 * and route them through an AudioContext for capture.
 */
const AUDIO_CAPTURE_SCRIPT = `
(function() {
  // Prevent double-injection
  if (window.__sessionScribeCapturing) return;
  window.__sessionScribeCapturing = true;

  const SAMPLE_RATE = 16000;
  const BUFFER_SIZE = 4096;

  // Storage for captured tracks and their processing nodes
  const capturedTracks = new Set();
  let audioContext = null;
  let merger = null;
  let processor = null;
  let sendChunk = null;

  function initAudioPipeline() {
    if (audioContext) return;

    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

    // ChannelMergerNode to combine multiple audio tracks into one
    merger = audioContext.createChannelMerger(1);

    // ScriptProcessorNode to extract raw PCM samples
    // (AudioWorklet would be cleaner but requires a separate file served via HTTP)
    processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!sendChunk) return;
      const inputData = event.inputBuffer.getChannelData(0);
      // Convert Float32 [-1,1] to Int16 for compact transmission
      const pcm16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      sendChunk(pcm16.buffer);
    };

    merger.connect(processor);
    processor.connect(audioContext.destination);

    console.log('[session-scribe] Audio pipeline initialized at ' + SAMPLE_RATE + 'Hz');
  }

  function captureTrack(track) {
    if (capturedTracks.has(track.id)) return;
    capturedTracks.add(track.id);

    initAudioPipeline();

    const stream = new MediaStream([track]);
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(merger);

    console.log('[session-scribe] Capturing audio track: ' + track.id);

    track.addEventListener('ended', () => {
      console.log('[session-scribe] Audio track ended: ' + track.id);
      capturedTracks.delete(track.id);
      try { source.disconnect(); } catch(e) {}
    });
  }

  // Monkey-patch RTCPeerConnection to intercept incoming audio tracks
  const OriginalRTCPeerConnection = window.RTCPeerConnection;

  window.RTCPeerConnection = function(...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    pc.addEventListener('track', (event) => {
      if (event.track.kind === 'audio') {
        console.log('[session-scribe] Intercepted WebRTC audio track');
        captureTrack(event.track);
      }
    });

    return pc;
  };

  // Copy static properties and prototype
  window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
  Object.keys(OriginalRTCPeerConnection).forEach(key => {
    try {
      window.RTCPeerConnection[key] = OriginalRTCPeerConnection[key];
    } catch(e) {}
  });

  // Also intercept addStream (older WebRTC API)
  const origAddStream = OriginalRTCPeerConnection.prototype.addStream;
  if (origAddStream) {
    OriginalRTCPeerConnection.prototype.addStream = function(stream) {
      stream.getAudioTracks().forEach(track => captureTrack(track));
      return origAddStream.apply(this, arguments);
    };
  }

  // Expose a function for Node.js to set the chunk callback
  window.__sessionScribeSetCallback = (callback) => {
    sendChunk = callback;
    console.log('[session-scribe] Audio chunk callback registered');
  };

  // Expose cleanup
  window.__sessionScribeCleanup = () => {
    sendChunk = null;
    if (processor) processor.disconnect();
    if (audioContext) audioContext.close();
    capturedTracks.clear();
    window.__sessionScribeCapturing = false;
    console.log('[session-scribe] Audio capture cleaned up');
  };

  console.log('[session-scribe] WebRTC audio interception installed');
})();
`;

export interface AudioCaptureOptions {
  wsUrl: string;
  sessionId: string;
  onChunk?: (size: number) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

/**
 * Start capturing audio from a Zoom meeting page and streaming it
 * to the backend via WebSocket.
 */
export async function startAudioCapture(
  page: Page,
  options: AudioCaptureOptions
): Promise<{ stop: () => Promise<void> }> {
  const { wsUrl, sessionId, onChunk, onError, onClose } = options;

  // Connect WebSocket to backend
  const fullWsUrl = `${wsUrl}/ws/audio/${sessionId}`;
  console.log(`[audio] Connecting to ${fullWsUrl}`);

  const ws = new WebSocket(fullWsUrl);
  let connected = false;
  let chunkCount = 0;
  let totalBytes = 0;

  // Buffer chunks while WS is connecting
  const buffer: Buffer[] = [];

  ws.on("open", () => {
    connected = true;
    console.log("[audio] WebSocket connected to backend");
    // Flush buffered chunks
    for (const chunk of buffer) {
      ws.send(Buffer.from(chunk));
    }
    buffer.length = 0;
  });

  ws.on("error", (err) => {
    console.error("[audio] WebSocket error:", err.message);
    onError?.(err as Error);
  });

  ws.on("close", () => {
    connected = false;
    console.log("[audio] WebSocket closed");
    onClose?.();
  });

  // Inject the audio capture script BEFORE Zoom creates RTCPeerConnections
  // This must be called early — ideally before the page loads meeting content
  await page.evaluateOnNewDocument(AUDIO_CAPTURE_SCRIPT);

  // Also inject into the current page (in case RTCPeerConnection was already created)
  await page.evaluate(AUDIO_CAPTURE_SCRIPT);

  // Expose a Node.js function that receives audio chunks from the page
  await page.exposeFunction(
    "__sessionScribeSendAudio",
    (base64Chunk: string) => {
      const chunk = Buffer.from(base64Chunk, "base64");
      chunkCount++;
      totalBytes += chunk.length;

      if (connected && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
      } else {
        buffer.push(chunk);
      }

      onChunk?.(chunk.length);

      // Log progress periodically
      if (chunkCount % 50 === 0) {
        const mb = (totalBytes / 1024 / 1024).toFixed(2);
        console.log(`[audio] Sent ${chunkCount} chunks (${mb} MB total)`);
      }
    }
  );

  // Wire up the page-side callback to call our exposed function
  await page.evaluate(() => {
    // @ts-ignore
    if (window.__sessionScribeSetCallback) {
      // @ts-ignore
      window.__sessionScribeSetCallback((arrayBuffer: ArrayBuffer) => {
        // Convert to base64 for transfer through exposeFunction
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        // @ts-ignore — this function was exposed by Node.js
        window.__sessionScribeSendAudio(base64);
      });
    }
  });

  console.log("[audio] Audio capture pipeline ready — waiting for WebRTC tracks...");

  // Return a handle to stop capture
  return {
    stop: async () => {
      console.log(`[audio] Stopping capture. Total: ${chunkCount} chunks, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);

      // Clean up page-side resources
      await page
        .evaluate(() => {
          // @ts-ignore
          if (window.__sessionScribeCleanup) {
            // @ts-ignore
            window.__sessionScribeCleanup();
          }
        })
        .catch(() => {});

      // Close WebSocket
      if (ws.readyState === WebSocket.OPEN) {
        // Send an end signal
        ws.send(JSON.stringify({ type: "end", sessionId }));
        ws.close();
      }
    },
  };
}
