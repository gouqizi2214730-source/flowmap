import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only: point the page's REST + WebSocket traffic STRAIGHT at the server
 * (127.0.0.1:8720) instead of relaying through vite's proxy.
 *
 * Why the proxy is bypassed for the stream: a HistoryResponse is one large
 * binary WS frame (up to several MB), and the vite/http-proxy ws relay
 * measurably chokes on exactly those — the server-side socket errors with
 * ECONNABORTED, the client's history request times out, and every live frame
 * queued behind the stuck one freezes with it (head-of-line blocking on ONE
 * shared socket; measured 2026-09-20 on live BTCUSDT). The client already
 * supports an injected absolute server origin (the Tauri shell sets the same
 * global), and the server's REST-CORS + WS origin gates allow the vite origins
 * cross-origin, so a direct connection in dev makes dev behave like the
 * packaged app. The proxy entries stay in place as a same-origin fallback.
 */
function directServerOrigin(serverOrigin: string): Plugin {
  return {
    name: 'flowmap-direct-server-origin',
    transformIndexHtml(html, ctx) {
      // Dev server only — a production build must not bake in a loopback port.
      if (!ctx.server) return html;
      return html.replace(
        '<head>',
        `<head>
    <script>window.__FLOWMAP_SERVER__ = ${JSON.stringify(serverOrigin)};</script>`,
      );
    },
  };
}

// FlowMap client dev server. Port 5173 matches the server's CORS allow-list
// (spec §11). The page talks to the flowmap-server on 8720 DIRECTLY (see
// directServerOrigin above); the /api + /ws proxy entries remain as a
// same-origin fallback for tools that bypass the injected global.
export default defineConfig({
  plugins: [react(), directServerOrigin('http://127.0.0.1:8720')],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8720',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:8720',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
