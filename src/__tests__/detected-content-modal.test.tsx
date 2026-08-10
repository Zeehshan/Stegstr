import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DetectedContentModal,
  detectedFeedEventIds,
  emptyDetectionMessage,
  type DetectedContentResult,
} from "../DetectedContentModal";
import type { NostrEvent } from "../types";

function event(id: string, content: string, createdAt = 1_786_354_105): NostrEvent {
  return {
    id,
    pubkey: "9f3087af176417e9cdd99c16748cf90c72604bfb732d50d8b95f8b6839d1cf1d",
    created_at: createdAt,
    kind: 1,
    tags: [],
    content,
    sig: "0".repeat(128),
  };
}

function result(events: NostrEvent[], knownCount = 0): DetectedContentResult {
  return { events, newCount: events.length - knownCount, knownCount };
}

const profiles = {
  "9f3087af176417e9cdd99c16748cf90c72604bfb732d50d8b95f8b6839d1cf1d": { name: "Alice" },
};

describe("DetectedContentModal", () => {
  it("shows a readable success dialog for one detected event", () => {
    render(<DetectedContentModal result={result([event("one", "Recovered hello")])} profiles={profiles} onClose={() => {}} onViewInFeed={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Stegstr Content Detected" })).toBeVisible();
    expect(screen.getByText("Recovered hello")).toBeVisible();
    expect(screen.getByText("Alice")).toBeVisible();
    expect(screen.getByText("1", { selector: "strong" })).toBeVisible();
  });

  it("shows all recovered events in a scrollable list", () => {
    render(
      <DetectedContentModal
        result={result([event("one", "First recovered post"), event("two", "Second recovered post"), event("three", "Third recovered post")])}
        profiles={profiles}
        onClose={() => {}}
        onViewInFeed={() => {}}
      />,
    );
    expect(screen.getByText("First recovered post")).toBeVisible();
    expect(screen.getByText("Second recovered post")).toBeVisible();
    expect(screen.getByText("Third recovered post")).toBeVisible();
    expect(screen.getByLabelText("Recovered Stegstr content")).toHaveClass("detected-content-list");
  });

  it("closes without changing recovered content", () => {
    const onClose = vi.fn();
    render(<DetectedContentModal result={result([event("one", "Keep me")])} profiles={profiles} onClose={onClose} onViewInFeed={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("supports Escape to close", () => {
    const onClose = vi.fn();
    render(<DetectedContentModal result={result([event("one", "Keyboard close")])} profiles={profiles} onClose={onClose} onViewInFeed={() => {}} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("View in Feed closes the dialog, selects Feed, and exposes the recovered post", () => {
    function Harness() {
      const recovered = event("known", "Visible in Feed");
      const [open, setOpen] = useState(true);
      const [view, setView] = useState<"settings" | "feed">("settings");
      return (
        <>
          <span data-testid="view">{view}</span>
          {view === "feed" && <article className="note-thread detected">{recovered.content}</article>}
          {open && (
            <DetectedContentModal
              result={result([recovered])}
              profiles={profiles}
              onClose={() => setOpen(false)}
              onViewInFeed={() => { setOpen(false); setView("feed"); }}
            />
          )}
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "View in Feed" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("view")).toHaveTextContent("feed");
    expect(screen.getByText("Visible in Feed")).toHaveClass("detected");
  });

  it("keeps a previously known event navigable and explains that it was refreshed", () => {
    const onView = vi.fn();
    const known = event("known", "Already present");
    render(<DetectedContentModal result={result([known], 1)} profiles={profiles} onClose={() => {}} onViewInFeed={onView} />);
    expect(screen.getByText(/1 already known and refreshed/)).toBeVisible();
    expect(detectedFeedEventIds([known])).toEqual(["known"]);
    fireEvent.click(screen.getByRole("button", { name: "View in Feed" }));
    expect(onView).toHaveBeenCalledOnce();
  });

  it("uses a distinct zero-event message instead of a success result", () => {
    expect(emptyDetectionMessage(0)).toBe("Image decoded, but its Stegstr payload contains no events.");
    expect(emptyDetectionMessage(2)).toBe("Image decoded, but none of its 2 event record(s) passed Nostr validation.");
  });

  it("works while Network is OFF and remains open across Network ON then OFF", () => {
    function NetworkHarness({ networkEnabled }: { networkEnabled: boolean }) {
      return (
        <div data-network={networkEnabled ? "on" : "off"}>
          <DetectedContentModal result={result([event("offline", "Offline recovery")])} profiles={profiles} onClose={() => {}} onViewInFeed={() => {}} />
        </div>
      );
    }
    const rendered = render(<NetworkHarness networkEnabled={false} />);
    expect(screen.getByText("Offline recovery")).toBeVisible();
    rendered.rerender(<NetworkHarness networkEnabled={true} />);
    rendered.rerender(<NetworkHarness networkEnabled={false} />);
    expect(screen.getByRole("dialog", { name: "Stegstr Content Detected" })).toBeVisible();
    expect(screen.getByText("Offline recovery")).toBeVisible();
  });

  it("preserves a recovered deletion by disabling Feed navigation when no post survives", () => {
    const deleted = event("deleted", "Deleted post");
    const deletion: NostrEvent = { ...event("deletion", ""), kind: 5, tags: [["e", deleted.id]] };
    render(<DetectedContentModal result={result([deleted, deletion])} profiles={profiles} onClose={() => {}} onViewInFeed={() => {}} />);
    expect(detectedFeedEventIds([deleted, deletion])).toEqual([]);
    expect(screen.getByRole("button", { name: "View in Feed" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/deleted or unsupported/);
  });
});
