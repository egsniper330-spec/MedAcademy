import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../src/lib/i18n';
import { Modal } from '../src/components/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function Harness() {
  const [value, setValue] = useState('');
  // Deliberately recreated on every keystroke, like the real pages.
  return (
    <I18nProvider>
      <Modal open onClose={() => undefined} title="Course">
        <label>
          Course name
          <input aria-label="Course name" value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
      </Modal>
    </I18nProvider>
  );
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('controlled form focus inside Modal', () => {
  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => { root.render(<Harness />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('keeps focus while typing Latin characters', async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Course name"]')!;
    input.focus();
    for (const value of ['C', 'Cl', 'Cli', 'Clin']) {
      await act(async () => { type(input, value); });
      expect(document.activeElement).toBe(input);
    }
    expect(input.value).toBe('Clin');
  });

  it('keeps focus while typing Arabic characters', async () => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Course name"]')!;
    input.focus();
    for (const value of ['د', 'دو', 'دور']) {
      await act(async () => { type(input, value); });
      expect(document.activeElement).toBe(input);
    }
    expect(input.value).toBe('دور');
  });
});
