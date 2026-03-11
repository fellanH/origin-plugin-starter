// NOTE: This plugin replaces direct Tauri `invoke` / `Channel` usage with
// @origin-cards/sdk wrappers so it runs inside a sandboxed L1 iframe.
//
// PTY integration status:
//   - pty_spawn / pty_write / pty_resize / pty_destroy → proxied via sdk `invoke`
//   - PTY data streaming → proxied via sdk `onEvent("pty:data", ...)` which sends
//     ORIGIN_EVENT_SUBSCRIBE to the host; the host must implement the
//     ORIGIN_STREAM bridge in IframePluginHost.tsx (Phase 4 of the monorepo plan).
//   - The host-side streaming bridge (IframePluginHost.tsx) is NOT yet implemented
//     in origin/; when it is, this plugin will receive live PTY output without
//     any changes here.

import { useEffect, useRef, useCallback } from "react";
import { invoke, onEvent, useBusChannel } from "@origin-cards/sdk";
import type { IframePluginContextWithConfig } from "@origin-cards/sdk";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";

import { resolveConfig } from "./config";
import { parseOsc7Cwd } from "./osc7";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the parent directory from a path. */
function dirname(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep);
  parts.pop();
  return parts.join(sep) || sep;
}

// ---------------------------------------------------------------------------
// xterm theme helpers
// ---------------------------------------------------------------------------

const DARK_THEME = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
};

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#333333",
  cursor: "#333333",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  selectionForeground: "#333333",
};

function resolveXtermTheme(appTheme: "light" | "dark") {
  return appTheme === "light" ? { ...LIGHT_THEME } : { ...DARK_THEME };
}

function resolveBackground(appTheme: "light" | "dark"): string {
  return appTheme === "light" ? "#ffffff" : "#1e1e1e";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TerminalPlugin({ context }: { context: IframePluginContextWithConfig }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  // Resolve typed config from the raw context.config record.
  const config = resolveConfig(context.config);
  const configRef = useRef(config);
  configRef.current = config;

  // ------------------------------------------------------------------
  // Bus: publish CWD changes
  // ------------------------------------------------------------------

  const publishCwd = useBusChannel("com.origin.terminal:cwd");
  const publishCwdRef = useRef(publishCwd);
  publishCwdRef.current = publishCwd;

  // Track the last published CWD to avoid duplicate publishes.
  const lastCwdRef = useRef<string | null>(null);

  // ------------------------------------------------------------------
  // Terminal lifecycle — create / destroy
  // ------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: "monospace",
      fontSize: 13,
      theme: resolveXtermTheme(context.theme),
      cursorBlink: true,
      scrollback: 10_000,
    });

    const fitAddon = new FitAddon();
    const clipboardAddon = new ClipboardAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    const imageAddon = new ImageAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(clipboardAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(unicode11Addon);
    term.loadAddon(imageAddon);

    // Activate Unicode 11 for proper wide-char / emoji rendering.
    term.unicode.activeVersion = "11";

    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    term.loadAddon(webglAddon);

    term.open(container);
    fitAddon.fit();

    termRef.current = term;

    const { cols, rows } = term;

    // Subscribe to PTY data stream via the SDK event bridge.
    // The host proxies pty:data events from the Rust PTY channel.
    //
    // Data passes through the OSC 7 parser to detect CWD changes. The raw
    // bytes are decoded to a string for parsing, then written to xterm as
    // a Uint8Array (xterm handles its own decoding internally).
    const unsubPty = onEvent("pty:data", { id: context.cardId }, (payload) => {
      const data = (payload as { data: number[] }).data;
      const bytes = new Uint8Array(data);
      term.write(bytes);

      // Parse OSC 7 to detect CWD changes.
      const text = new TextDecoder().decode(bytes);
      const cwd = parseOsc7Cwd(text);
      if (cwd && cwd !== lastCwdRef.current) {
        lastCwdRef.current = cwd;
        publishCwdRef.current({ path: cwd, cardId: context.cardId });
      }
    });

    term.onData((data) => {
      invoke("pty_write", {
        id: context.cardId,
        data: Array.from(new TextEncoder().encode(data)),
      }).catch(console.error);
    });

    // pty_spawn no longer receives a Channel object — PTY data arrives via
    // the ORIGIN_EVENT bridge subscribed above.
    invoke("pty_spawn", {
      id: context.cardId,
      cols,
      rows,
      env: {
        TERM_PROGRAM_VERSION: "0.1.0",
      },
    }).catch(console.error);

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        invoke("pty_resize", {
          id: context.cardId,
          cols: term.cols,
          rows: term.rows,
        }).catch(console.error);
      }, 50);
    });
    ro.observe(container);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      ro.disconnect();
      unsubPty();
      termRef.current = null;
      term.dispose();
      invoke("pty_destroy", { id: context.cardId }).catch(console.error);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.cardId]);

  // ------------------------------------------------------------------
  // Bus: theme-changed — update xterm theme dynamically
  // ------------------------------------------------------------------

  useBusChannel("com.origin.app:theme-changed", useCallback((payload: unknown) => {
    const term = termRef.current;
    if (!term) return;
    const { theme } = payload as { theme: "light" | "dark" };
    term.options.theme = resolveXtermTheme(theme);
  }, []));

  // ------------------------------------------------------------------
  // Bus: follow active path — cd when workspace active path changes
  // ------------------------------------------------------------------

  const handleActivePath = useCallback(
    (payload: unknown) => {
      if (!configRef.current.followActivePath) return;
      const { path, type } = payload as { path: string; type: "file" | "directory" };
      const dir = type === "directory" ? path : dirname(path);
      // Escape single quotes in the path for safe shell interpolation.
      const escaped = dir.replace(/'/g, "'\\''");
      invoke("pty_write", {
        id: context.cardId,
        data: Array.from(new TextEncoder().encode(`cd '${escaped}'\n`)),
      }).catch(console.error);
    },
    [context.cardId],
  );

  useBusChannel("origin:workspace/active-path", handleActivePath);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const bg = resolveBackground(context.theme);

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", background: bg }} />
  );
}
