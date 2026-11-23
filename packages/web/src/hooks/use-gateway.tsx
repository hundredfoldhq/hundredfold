import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createGatewaySocket } from "@/lib/ws";
import type { GatewayEventListener } from "@hundredfold/gateway-events";

export interface GatewayContextValue {
  connected: boolean;
  connectionSeq: number;
  skillsVersion: number;
  subscribe: (fn: GatewayEventListener) => () => void;
}

const GatewayContext = createContext<GatewayContextValue | null>(null);

/**
 * Opens ONE WebSocket per app and exposes its events via context.
 * All consumers (useGateway, NotificationProvider, etc.) read from this
 * single connection — never open their own.
 */
export function GatewayProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connectionSeq, setConnectionSeq] = useState(0);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const listenersRef = useRef<Set<GatewayEventListener>>(new Set());

  useEffect(() => {
    const socket = createGatewaySocket(
      (frame) => {
        const { event } = frame;
        if (event === "skills:changed") {
          setSkillsVersion((prev) => prev + 1);
        }

        // Dispatch to synchronous subscribers (bypasses React 18 batching)
        for (const fn of listenersRef.current) {
          fn(frame);
        }
      },
      {
        onOpen: () => {
          setConnected(true);
          setConnectionSeq((prev) => prev + 1);
        },
        onClose: () => {
          setConnected(false);
        },
      },
    );

    // Resume listeners: a half-open socket can survive a tab backgrounding, a
    // network handoff, or an iOS bfcache restore in readyState=OPEN while being
    // functionally dead. On every "we're back" signal, reconnect immediately if
    // the socket isn't open (this clears any pending backoff and connects now).
    // The onOpen handler then bumps connectionSeq, which drives per-pane catch-up.
    const resume = () => {
      if (!socket.isOpen()) socket.reconnect();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resume();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", resume);
    window.addEventListener("pageshow", resume); // iOS bfcache restore

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", resume);
      window.removeEventListener("pageshow", resume);
      socket.close();
    };
  }, []);

  const subscribe = useCallback((fn: GatewayEventListener) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  return (
    <GatewayContext.Provider
      value={{ connected, connectionSeq, skillsVersion, subscribe }}
    >
      {children}
    </GatewayContext.Provider>
  );
}

/**
 * Consumer hook. Returns the same shape callers already expect.
 * Does NOT open a WebSocket — that's GatewayProvider's job.
 */
export function useGateway(): GatewayContextValue {
  const ctx = useContext(GatewayContext);
  if (!ctx) {
    throw new Error(
      "useGateway must be used inside <GatewayProvider> (mounted in ClientProviders).",
    );
  }
  return ctx;
}
