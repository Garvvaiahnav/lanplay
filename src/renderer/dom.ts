/* Tiny DOM helpers. Classic script (no import/export): everything hangs off the single global "LP". */
namespace LP.Dom {
  export type Child = Node | string | null | undefined | false;
  export type Prop = string | number | boolean | null | undefined | ((e: Event) => void);
  export type Props = Record<string, Prop>;

  const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected']);

  export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (typeof v === 'function') {
          if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'class') {
          el.className = String(v);
        } else if (PROPERTY_KEYS.has(k)) {
          (el as unknown as Record<string, unknown>)[k] = v;
        } else {
          el.setAttribute(k, v === true ? '' : String(v));
        }
      }
    }
    append(el, kids);
    return el;
  }

  export function append(el: Node, kids: Child[]): void {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    }
  }

  export function clear(el: Node): void {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  export function setChildren(el: Node, kids: Child[]): void {
    clear(el);
    append(el, kids);
  }

  export interface Segmented<T extends string | number> {
    el: HTMLElement;
    set(value: T): void;
    setDisabled(disabled: boolean): void;
  }

  /** Radio-group of buttons: arrow keys move + select, only the selected one is in the tab order. */
  export function segmented<T extends string | number>(
    label: string,
    options: ReadonlyArray<{ value: T; label: string }>,
    onPick: (value: T) => void,
    extraClass = '',
  ): Segmented<T> {
    let current: T | undefined;
    let disabled = false;
    const buttons: HTMLButtonElement[] = options.map((o) =>
      h('button', { type: 'button', role: 'radio', class: 'seg-btn', 'data-value': String(o.value) }, o.label),
    );
    const el = h('div', { class: ('seg ' + extraClass).trim(), role: 'radiogroup', 'aria-label': label }, ...buttons);

    const paint = (): void => {
      buttons.forEach((b, i) => {
        const on = options[i]?.value === current;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on || (current === undefined && i === 0) ? 0 : -1;
        b.disabled = disabled;
      });
    };
    buttons.forEach((b, i) => {
      b.addEventListener('click', () => {
        const o = options[i];
        if (!o || disabled) return;
        current = o.value;
        paint();
        onPick(o.value);
      });
      b.addEventListener('keydown', (e: KeyboardEvent) => {
        let d = 0;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') d = 1;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') d = -1;
        else return;
        e.preventDefault();
        const j = (i + d + buttons.length) % buttons.length;
        buttons[j]?.focus();
        buttons[j]?.click();
      });
    });
    paint();
    return {
      el,
      set(v: T) {
        current = v;
        paint();
      },
      setDisabled(d: boolean) {
        disabled = d;
        paint();
      },
    };
  }

  /** Accessible on/off switch. */
  export function toggle(label: string, onChange: (on: boolean) => void): { el: HTMLButtonElement; set(on: boolean): void; get(): boolean } {
    let on = false;
    const el = h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-label': label, 'aria-checked': 'false' }, h('span', { class: 'knob' }));
    const paint = (): void => el.setAttribute('aria-checked', on ? 'true' : 'false');
    el.addEventListener('click', () => {
      on = !on;
      paint();
      onChange(on);
    });
    return {
      el,
      set(v: boolean) {
        on = v;
        paint();
      },
      get: () => on,
    };
  }

  export async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
