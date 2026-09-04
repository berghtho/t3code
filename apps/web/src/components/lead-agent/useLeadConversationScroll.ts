import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { LeadAgentSnapshot } from "@t3tools/contracts";

export function useLeadConversationScroll(
  scope: string | null,
  conversation: LeadAgentSnapshot["conversation"] | undefined,
  viewportRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
) {
  const followingEnd = useRef(true);

  const followToEnd = useCallback(() => {
    followingEnd.current = true;
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    }
  }, [viewportRef]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (scope === null || !viewport || !content) return;

    followToEnd();
    const onScroll = () => {
      followingEnd.current =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });

    // Markdown and the composer can change height after a message commits.
    const observer = new ResizeObserver(() => {
      if (followingEnd.current) followToEnd();
    });
    observer.observe(viewport);
    observer.observe(content);
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [scope, followToEnd, viewportRef, contentRef]);

  useLayoutEffect(() => {
    if (scope !== null && conversation !== undefined && followingEnd.current) followToEnd();
  }, [scope, conversation, followToEnd]);

  return followToEnd;
}
