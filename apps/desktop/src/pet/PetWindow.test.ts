import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("electron", () => ({}));
import { petHtml } from "./PetWindow.ts";

type Input = {
  button?: number;
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  screenX?: number;
  screenY?: number;
  target?: TestElement;
  preventDefault?: () => void;
};
class TestElement {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  listeners: Record<string, (event: Input) => void> = {};
  className = "";
  textContent = "";
  title = "";
  open = false;
  classList = {
    toggle: (_name: string, value: boolean) => {
      this.open = value;
    },
  };
  capturedPointers: number[] = [];
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
  setPointerCapture(pointerId: number) {
    this.capturedPointers.push(pointerId);
  }
  hasPointerCapture(pointerId: number) {
    return this.capturedPointers.includes(pointerId);
  }
  releasePointerCapture(pointerId: number) {
    this.capturedPointers = this.capturedPointers.filter((id) => id !== pointerId);
  }
  addEventListener(name: string, fn: (event: Input) => void) {
    this.listeners[name] = fn;
  }
  fire(name: string, event: Input = {}) {
    this.listeners[name]?.({ target: this, preventDefault: () => {}, ...event });
  }
  closest(query: string) {
    return query === "button" || ["sprite", "pills", "menu"].includes(this.id) ? this : null;
  }
  append(...items: TestElement[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: TestElement[]) {
    this.children = items;
  }
  getBoundingClientRect() {
    return {
      width: this.id === "menu" ? 124 : 280,
      height: this.id === "menu" ? (this.open ? 180 : 0) : this.children.length * 30,
    };
  }
  getContext() {
    return { clearRect() {}, fillRect() {}, fillStyle: "" };
  }
}
function page(initialSpritePosition?: { readonly x: number; readonly y: number }) {
  const elements = Object.fromEntries(
    ["actor", "sprite", "pet", "pills", "menu", "movement"].map((id) => [id, new TestElement(id)]),
  );
  const events: Record<string, (event: Input) => void> = {};
  const actions: unknown[] = [];
  const drags: unknown[] = [];
  const modes: boolean[] = [];
  const bounds: unknown[] = [];
  let tick = () => {};
  let now = 0;
  let moveHandler: ((x: number, y: number) => void) | null = null;
  const win = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener() {},
    t3PetBridge: {
      send: (action: unknown) => actions.push(action),
      sendDrag: (event: unknown) => drags.push(event),
      setInteractive: (value: boolean) => modes.push(value),
      reportBounds: (value: unknown) => bounds.push(value),
      onMove: (handler: (x: number, y: number) => void) => {
        moveHandler = handler;
      },
    },
    __updatePet: (_state: unknown) => {},
    __movePet: (_x: number, _y: number) => {},
  };
  const script = petHtml(initialSpritePosition).split("<script>")[1]!.split("</script>")[0]!;
  NodeVM.runInNewContext(script, {
    window: win,
    document: {
      getElementById: (id: string) => elements[id],
      createElement: (id: string) => new TestElement(id),
      addEventListener: (name: string, fn: (event: Input) => void) => {
        events[name] = fn;
      },
    },
    Element: TestElement,
    performance: { now: () => now },
    clearInterval() {},
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
  });
  return {
    elements,
    events,
    actions,
    drags,
    modes,
    bounds,
    win,
    moveHandler: () => moveHandler,
    tick: (time: number) => {
      now = time;
      tick();
    },
  };
}
const summary = {
  environmentId: "env",
  threadId: "thread",
  title: "Thread",
  status: "working",
  statusLabel: "Running",
};
describe("pet page behavior", () => {
  it("starts without script errors and bounds pills without moving the sprite", () => {
    const p = page();
    p.win.__updatePet({
      pet: "trident",
      movement: "static",
      threads: Array.from({ length: 12 }, () => summary),
    });
    expect(p.elements.pills!.children).toHaveLength(4);
    expect(p.elements.actor!.style.transform).toBe("translate(1836px,996px)");
    expect(parseFloat(p.elements.pills!.style.left!)).toBeLessThan(0);
    expect(p.bounds.at(-1)).toEqual({ x: 1632, y: 868, width: 280, height: 192 });
    p.elements.pills!.children[0]!.fire("click");
    expect(p.actions).toEqual([
      { kind: "select-thread", environmentId: "env", threadId: "thread" },
    ]);
  });
  it("opens a reachable menu and sends movement and close actions", () => {
    const p = page();
    p.elements.sprite!.fire("contextmenu");
    expect(p.elements.menu!.open).toBe(true);
    expect(parseFloat(p.elements.menu!.style.left!)).toBeLessThan(0);
    expect(p.bounds.at(-1)).toEqual({ x: 1788, y: 808, width: 124, height: 252 });
    const button = new TestElement("button");
    button.dataset.action = "movement";
    p.elements.menu!.fire("click", { target: button });
    button.dataset.action = "close";
    p.elements.menu!.fire("click", { target: button });
    expect(p.actions).toEqual([{ kind: "set-movement", movement: "playful" }, { kind: "close" }]);
  });
  it("uses the provided initial sprite position", () => {
    const p = page({ x: 100, y: 200 });
    expect(p.elements.actor!.style.transform).toBe("translate(100px,200px)");
  });
  it("keeps a non-overlapping initial position offscreen", () => {
    const p = page({ x: -100, y: 40 });
    expect(p.elements.actor!.style.transform).toBe("translate(-100px,40px)");
    expect(p.elements.pills!.style.visibility).toBe("hidden");
  });
  it("drags the sprite with pointer capture", () => {
    const p = page();
    const sprite = p.elements.sprite!;
    expect(p.elements.actor!.style.transform).toBe("translate(1836px,996px)");
    sprite.fire("pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 1836,
      clientY: 996,
      screenX: 1836,
      screenY: 996,
    });
    expect(sprite.capturedPointers).toEqual([1]);
    expect(p.drags).toEqual([
      { kind: "start", offsetX: 0, offsetY: 0, screenX: 1836, screenY: 996 },
    ]);
    sprite.fire("pointermove", {
      pointerId: 1,
      clientX: 1800,
      clientY: 900,
      screenX: 1800,
      screenY: 900,
    });
    expect(p.elements.actor!.style.transform).toBe("translate(1836px,996px)");
    expect(p.drags[1]).toEqual({
      kind: "move",
      offsetX: 0,
      offsetY: 0,
      screenX: 1800,
      screenY: 900,
    });
    p.win.__movePet(1800, 900);
    expect(p.elements.actor!.style.transform).toBe("translate(1800px,900px)");
    sprite.fire("pointerup", { pointerId: 1 });
    expect(sprite.capturedPointers).toEqual([]);
    expect(p.drags[2]).toEqual({ kind: "end" });
  });
  it("keeps an offscreen sprite hidden across state updates", () => {
    const p = page();
    expect(p.moveHandler()).toBeTypeOf("function");
    p.win.__movePet(-64, -64);
    expect(p.elements.actor!.style.transform).toBe("translate(-64px,-64px)");
    expect(p.elements.pills!.style.visibility).toBe("hidden");
    p.win.__updatePet({ pet: "triton", movement: "playful", threads: [summary] });
    expect(p.elements.actor!.style.transform).toBe("translate(-64px,-64px)");
    expect(p.elements.pills!.style.visibility).toBe("hidden");
    p.moveHandler()!(100, 100);
    expect(p.elements.actor!.style.transform).toBe("translate(100px,100px)");
    expect(p.elements.pills!.style.visibility).toBe("visible");
    p.win.__updatePet({ pet: "triton", movement: "static", threads: [] });
    expect(p.elements.actor!.style.transform).toBe("translate(100px,100px)");
  });
  it("preserves straddling sprite coordinates during state updates", () => {
    const p = page();
    p.win.__movePet(-20, 980);
    expect(p.elements.actor!.style.transform).toBe("translate(-20px,980px)");
    p.win.__updatePet({ pet: "triton", movement: "static", threads: [] });
    expect(p.elements.actor!.style.transform).toBe("translate(-20px,980px)");
    p.elements.sprite!.fire("contextmenu");
    expect(p.elements.menu!.open).toBe(true);
    expect(p.elements.actor!.style.transform).toBe("translate(-20px,980px)");
  });
  it("keeps static position and releases input away from controls", () => {
    const p = page();
    const before = p.elements.actor!.style.transform;
    for (const time of [1000, 30000, 60000]) p.tick(time);
    expect(p.elements.actor!.style.transform).toBe(before);
    p.events.mousemove!({ target: p.elements.sprite! });
    p.events.mousemove!({ target: p.elements.sprite! });
    p.events.mousemove!({});
    expect(p.modes).toEqual([true, false]);
  });
});
