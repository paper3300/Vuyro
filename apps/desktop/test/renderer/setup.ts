import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});

// React Flow measures nodes with ResizeObserver and reads the viewport transform; jsdom has neither
// (React Flow's own testing guide sets up the same stand-ins).
class ResizeObserverStub {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    const contentRect = { width: 800, height: 600, x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600 };
    this.callback([{ target, contentRect } as unknown as ResizeObserverEntry], this);
  }

  unobserve(): void {
    // Nothing observed is kept.
  }

  disconnect(): void {
    // Nothing observed is kept.
  }
}

class DOMMatrixReadOnlyStub {
  readonly m22: number;

  constructor(transform?: string) {
    const scale = /scale\(([0-9.]+)\)/.exec(transform ?? '')?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}

globalThis.ResizeObserver = ResizeObserverStub;
globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;
Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: {
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.height) || 100;
    },
  },
  offsetWidth: {
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.width) || 200;
    },
  },
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
