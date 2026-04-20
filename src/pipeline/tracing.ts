import type { Span } from "./context.js";

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): Span;
}

export const noopTracer: Tracer = {
  startSpan(): Span {
    return {
      end() {
        /* noop */
      },
    };
  },
};

export function consoleTracer(prefix = "[trace]"): Tracer {
  return {
    startSpan(name, attrs) {
      const t0 = performance.now();
      const attrStr = attrs ? ` ${JSON.stringify(attrs)}` : "";
      console.log(`${prefix} start ${name}${attrStr}`);
      return {
        end(status, endAttrs) {
          const ms = (performance.now() - t0).toFixed(1);
          const extra = endAttrs ? ` ${JSON.stringify(endAttrs)}` : "";
          console.log(`${prefix} ${status} ${name} ${ms}ms${extra}`);
        },
      };
    },
  };
}
