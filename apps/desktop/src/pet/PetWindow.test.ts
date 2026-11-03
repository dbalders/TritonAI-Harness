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
  captured = false;
  classList = {
    toggle: (_name: string, value: boolean) => {
      this.open = value;
    },
  };
  readonly id: string;
  constructor(id: string) {
    this.id = id;
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
  setPointerCapture() {
    this.captured = true;
  }
  hasPointerCapture() {
    return this.captured;
  }
  releasePointerCapture() {
    this.captured = false;
  }
}
function page() {
  const elements = Object.fromEntries(
    ["actor", "sprite", "pet", "pills", "menu", "movement"].map((id) => [id, new TestElement(id)]),
  );
  const events: Record<string, (event: Input) => void> = {};
  const actions: unknown[] = [];
  const modes: boolean[] = [];
  const moves: Array<[number, number]> = [];
  let tick = () => {};
  let now = 0;
  const win = {
    innerWidth: 1920,
    innerHeight: 1080,
    addEventListener() {},
    t3PetBridge: {
      send: (action: unknown) => actions.push(action),
      setInteractive: (value: boolean) => modes.push(value),
      moveWindow: (dx: number, dy: number) => moves.push([dx, dy]),
    },
    __updatePet: (_state: unknown) => {},
  };
  const script = petHtml().split("<script>")[1]!.split("</script>")[0]!;
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
    modes,
    moves,
    win,
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
    const button = new TestElement("button");
    button.dataset.action = "movement";
    p.elements.menu!.fire("click", { target: button });
    button.dataset.action = "close";
    p.elements.menu!.fire("click", { target: button });
    expect(p.actions).toEqual([{ kind: "set-movement", movement: "playful" }, { kind: "close" }]);
  });
  it("drags the pet window by screen-coordinate deltas", () => {
    const p = page();
    p.win.__updatePet({ pet: "raccoon", movement: "static", threads: [summary] });
    const before = p.elements.actor!.style.transform;
    p.elements.sprite!.fire("pointerdown", {
      button: 0,
      pointerId: 1,
      clientX: 1836,
      clientY: 996,
      screenX: 1836,
      screenY: 996,
    });
    p.elements.sprite!.fire("pointermove", { pointerId: 1, screenX: 1436, screenY: 996 });
    p.elements.sprite!.fire("pointermove", { pointerId: 1, screenX: 1436, screenY: 996 });
    p.elements.sprite!.fire("pointermove", { pointerId: 1, screenX: 1936, screenY: 896 });
    expect(p.moves).toEqual([
      [-400, 0],
      [500, -100],
    ]);
    expect(p.elements.actor!.style.transform).toBe(before);
    p.elements.sprite!.fire("pointerup", { pointerId: 1 });
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
