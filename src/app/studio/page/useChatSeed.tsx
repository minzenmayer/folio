// Thoughtbed · useChatSeed
//
// Phase 22 slice 5 (2026-05-06). Threads the chip / submit choice
// from EditorEmptyState into ChatCompanion so the chat can land
// the right opening turn. The seed is one-shot — once the chat
// has consumed it, calling consume() returns null on subsequent
// reads so the seed doesn't replay on every re-render.

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  type ReactNode,
} from 'react';
import type { ChatSeed } from './EditorEmptyState';

type ChatSeedCtxValue = {
  consume: () => ChatSeed | null;
};

const ChatSeedCtx = createContext<ChatSeedCtxValue | null>(null);

export function ChatSeedProvider({
  initial,
  children,
}: {
  initial: ChatSeed | null;
  children: ReactNode;
}) {
  const seedRef = useRef<ChatSeed | null>(initial);

  const consume = useCallback(() => {
    const v = seedRef.current;
    seedRef.current = null;
    return v;
  }, []);

  return (
    <ChatSeedCtx.Provider value={{ consume }}>{children}</ChatSeedCtx.Provider>
  );
}

export function useChatSeed(): ChatSeedCtxValue {
  const ctx = useContext(ChatSeedCtx);
  if (!ctx) {
    // Outside of a provider (e.g., empty-state branch) — return
    // a no-op consume.
    return { consume: () => null };
  }
  return ctx;
}
