import { act, StrictMode, useLayoutEffect, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LeadAgentSnapshot } from "@t3tools/contracts";

import { useLeadConversationScroll } from "./useLeadConversationScroll";

class Viewport extends EventTarget {
  clientHeight = 300;
  scrollHeight = 1000;
  scrollTop = 0;

  scrollTo(top: number) {
    this.scrollTop = top;
    this.dispatchEvent(new Event("scroll"));
  }
}

class TestResizeObserver {
  static active = new Set<TestResizeObserver>();
  constructor(readonly callback: () => void) {
    TestResizeObserver.active.add(this);
  }
  observe() {}
  disconnect() {
    TestResizeObserver.active.delete(this);
  }
  static resize() {
    for (const observer of TestResizeObserver.active) observer.callback();
  }
}

let root: Root;
let viewport: Viewport;
let followToEnd: () => void;
let viewportRef: RefObject<HTMLDivElement | null>;
let contentRef: RefObject<HTMLDivElement | null>;

function Probe(props: { scope: string | null; conversation: LeadAgentSnapshot["conversation"] }) {
  const follow = useLeadConversationScroll(
    props.scope,
    props.conversation,
    viewportRef,
    contentRef,
  );
  useLayoutEffect(() => {
    followToEnd = follow;
  }, [follow]);
  return null;
}

async function render(scope: string | null = "project-a:session-1", count = 1) {
  await act(() => {
    root.render(
      <StrictMode>
        <Probe
          scope={scope}
          conversation={Array.from({ length: count }, (_, index) => ({
            source: "lead-agent" as const,
            content: `Response ${index}`,
          }))}
        />
      </StrictMode>,
    );
  });
}

beforeEach(() => {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  viewport = new Viewport();
  // Only geometry is simulated; React commits the real hook and its effects.
  viewportRef = { current: viewport as unknown as HTMLDivElement };
  contentRef = { current: {} as HTMLDivElement };
  TestResizeObserver.active.clear();
  root = createRoot(container as unknown as HTMLElement);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("Riker conversation scrolling", () => {
  it("waits for the conversation to mount and follows its first overflowing reply", async () => {
    await render(null, 0);
    expect(viewport.scrollTop).toBe(0);
    expect(TestResizeObserver.active.size).toBe(0);

    viewport.scrollHeight = 100;
    await render("project-a:session-1", 0);
    expect(viewport.scrollTop).toBe(0);
    viewport.scrollHeight = 900;
    await render();
    expect(viewport.scrollTop).toBe(600);
  });

  it("opens at the latest message and follows incoming messages", async () => {
    await render();
    expect(viewport.scrollTop).toBe(700);

    viewport.scrollHeight = 1400;
    await render("project-a:session-1", 2);
    expect(viewport.scrollTop).toBe(1100);
  });

  it("keeps the reading position until the Owner returns to the bottom", async () => {
    await render();
    viewport.scrollTo(200);
    viewport.scrollHeight = 1400;
    await render("project-a:session-1", 2);
    TestResizeObserver.resize();
    expect(viewport.scrollTop).toBe(200);

    viewport.scrollTo(1100);
    viewport.scrollHeight = 1700;
    await render("project-a:session-1", 3);
    expect(viewport.scrollTop).toBe(1400);
  });

  it("follows delayed content growth and viewport resizing only while at the bottom", async () => {
    await render();
    viewport.scrollHeight = 1500;
    TestResizeObserver.resize();
    expect(viewport.scrollTop).toBe(1200);
    viewport.clientHeight = 200;
    TestResizeObserver.resize();
    expect(viewport.scrollTop).toBe(1300);

    viewport.scrollTo(100);
    viewport.scrollHeight = 1800;
    TestResizeObserver.resize();
    expect(viewport.scrollTop).toBe(100);
  });

  it("returns to the latest message on send and when switching conversations", async () => {
    await render();
    viewport.scrollTo(100);
    followToEnd();
    expect(viewport.scrollTop).toBe(700);
    viewport.scrollHeight = 1400;
    await render("project-a:session-1", 2);
    expect(viewport.scrollTop).toBe(1100);

    viewport.scrollTo(100);
    viewport.scrollHeight = 2000;
    await render("project-b:session-1");
    expect(viewport.scrollTop).toBe(1700);
    viewport.scrollTo(100);
    await render("project-b:session-2");
    expect(viewport.scrollTop).toBe(1700);
  });

  it("disconnects on unmount and does not leave duplicate observers in StrictMode", async () => {
    await render();
    expect(TestResizeObserver.active.size).toBe(1);
    await act(() => root.render(null));
    expect(TestResizeObserver.active.size).toBe(0);
    viewport.scrollHeight = 2000;
    TestResizeObserver.resize();
    expect(viewport.scrollTop).toBe(700);
  });
});
