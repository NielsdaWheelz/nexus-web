import { waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { pulseReaderApparatusElement } from "./apparatusPulse";
import "./apparatus.css";

it("retires and restarts source-note pulses through the node's real animation", async () => {
  const node = document.createElement("span");
  node.textContent = "Source note";
  node.style.setProperty("--ease-glide", "linear");
  node.style.setProperty("--accent", "red");
  document.body.append(node);
  try {
    pulseReaderApparatusElement(node);
    const animation = node.getAnimations()[0];
    expect(animation).toBeDefined();
    animation!.currentTime = 500;
    pulseReaderApparatusElement(node);
    expect(node.getAnimations()[0]).toBe(animation);
    expect(Number(animation!.currentTime)).toBeLessThan(100);
    const finished = new Promise((resolve) => node.addEventListener("animationend", resolve, { once: true }));
    animation!.finish();
    await finished;
    expect(getComputedStyle(node).boxShadow).toBe("none");
    pulseReaderApparatusElement(node);
    const detached = node.getAnimations()[0];
    expect(detached, "completed source-note pulse did not restart").toBeDefined();
    expect(detached!.playState).toBe("running");
    node.remove();
    await waitFor(() => expect(detached!.playState).toBe("idle"));
    document.body.append(node);
    node.style.animationDuration = "0ms";
    pulseReaderApparatusElement(node);
    await waitFor(() => expect(node.getAnimations()).toHaveLength(0));
    expect(getComputedStyle(node).boxShadow).toBe("none");
  } finally { node.remove(); }
});
