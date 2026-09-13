"use client";

import { useEffect } from "react";

/**
 * Keeps the application shell aligned with the visible browser area when a
 * mobile browser chrome or virtual keyboard changes the visual viewport.
 * CSS dvh remains the fallback, so rendering does not depend on JavaScript.
 */
export function useViewportMetrics() {
  useEffect(() => {
    const viewport = window.visualViewport;
    let frame = 0;

    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const height = viewport?.height ?? window.innerHeight;
        const offsetTop = viewport?.offsetTop ?? 0;
        document.documentElement.style.setProperty(
          "--app-viewport-height",
          `${Math.round(height)}px`,
        );
        document.documentElement.style.setProperty(
          "--app-viewport-offset-top",
          `${Math.round(offsetTop)}px`,
        );
      });
    };

    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);

    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      document.documentElement.style.removeProperty("--app-viewport-height");
      document.documentElement.style.removeProperty(
        "--app-viewport-offset-top",
      );
    };
  }, []);
}
